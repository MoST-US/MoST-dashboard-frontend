// GitHub upload helper used by tunnel-manager.mjs.
//
// The dashboard browser already knows which `results.csv` files exist for a finished experiment (it
// walks the same folder tree for the ZIP download) and posts them here, so this module only has to
// turn a flat list of files into one GitHub commit. The GitHub token stays in this Node process on
// purpose: every `VITE_*` value is inlined into the static bundle, so a token placed there would be
// readable by anyone who loads the deployed dashboard.
//
// Repository layout produced by an upload (see `buildResultsFolderName` / `buildResultsTreePath`):
//   <GITHUB_RESULTS_PATH>/<model>-<gpuType>-<N>gpus/<experimentFolder>/<sub-experiment>/<iteration>/results.csv
// with `<GITHUB_RESULTS_PATH>` defaulting to `results`.
//
// The `<experimentFolder>` level names the experiment the results belong to: the results source they
// were read from, which is the archive folder of a finished run (`Experiment_<EXPERIMENT_TYPE>_<ts>`, or
// `Experiment_MIX_<EXPERIMENT_TYPE>_<ts>` for additive runs). Without that level two runs land in the
// same `<sub-experiment>/` folder, because archives normally reuse the same cell names (`1-100_1-100`).
// The live `current` results source has no archive name yet, so it is refused instead of being
// committed as an unnamed experiment (`UNNAMED_EXPERIMENT_SOURCE`).

const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com'
const GITHUB_WEB_BASE_URL = 'https://github.com'
const DEFAULT_GITHUB_BRANCH = 'main'
const DEFAULT_GITHUB_RESULTS_PATH = 'results'
const RESULTS_FILE_NAME = 'results.csv'
// Results source of a run that is still executing: it has no archive name yet, so it cannot name the
// experiment level of the upload tree and is never committed on its own.
const UNNAMED_EXPERIMENT_SOURCE = 'current'
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
// Characters that are safe for a folder inside a git tree. Model ids arrive as `owner/model`, so the
// slash is folded into the folder name instead of creating an extra level.
const UNSAFE_SEGMENT_PATTERN = /[^A-Za-z0-9._@+=-]+/g
const MAX_GPU_COUNT = 64

// GPU type -> nodes of the private cluster. Every node listed here is mapped back to its type, which
// is what names the upload folder. Override with `GPU_TYPE_MAP=A30:gpu01:gpu02,A40:gpu03:...`.
export const DEFAULT_GPU_TYPE_MAP = Object.freeze({
  A30: ['gpu01', 'gpu02'],
  A40: ['gpu03', 'gpu04', 'gpu05', 'gpu06'],
  A100: ['gpu07', 'gpu08'],
})

export const MAX_UPLOAD_FILE_BYTES = 8 * 1024 * 1024
export const MAX_UPLOAD_TOTAL_BYTES = 64 * 1024 * 1024
export const MAX_UPLOAD_FILES = 5000
// Bodies carry base64 payloads, so the JSON envelope is a third larger than the raw results.
export const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_TOTAL_BYTES + 8 * 1024 * 1024

export class GitHubUploadError extends Error {
  constructor(message, statusCode = 502) {
    super(message)
    this.name = 'GitHubUploadError'
    this.statusCode = statusCode
  }
}

function cloneDefaultGpuTypeMap() {
  return Object.fromEntries(
    Object.entries(DEFAULT_GPU_TYPE_MAP).map(([type, nodes]) => [type, [...nodes]]),
  )
}

// `A30:gpu01:gpu02,A40:gpu03:gpu04` -> `{ A30: ['gpu01', 'gpu02'], A40: ['gpu03', 'gpu04'] }`.
// Anything unusable falls back to the cluster defaults.
export function parseGpuTypeMap(raw) {
  const source = String(raw ?? '').trim()
  if (!source) {
    return cloneDefaultGpuTypeMap()
  }

  const gpuTypeMap = {}

  for (const group of source.split(',')) {
    const parts = group
      .split(':')
      .map((part) => part.trim())
      .filter(Boolean)

    if (parts.length < 2) {
      continue
    }

    const [type, ...nodes] = parts
    gpuTypeMap[type] = [...new Set(nodes)]
  }

  return Object.keys(gpuTypeMap).length > 0 ? gpuTypeMap : cloneDefaultGpuTypeMap()
}

export function resolveGpuTypeForNode(gpuTypeMap, node) {
  const target = String(node ?? '').trim().toLowerCase()
  if (!target) {
    return null
  }

  for (const [type, nodes] of Object.entries(gpuTypeMap || {})) {
    const matched = (nodes || []).some(
      (candidate) => String(candidate).trim().toLowerCase() === target,
    )
    if (matched) {
      return type
    }
  }

  return null
}

export function listGpuNodes(gpuTypeMap) {
  return Object.values(gpuTypeMap || {}).flat().map((node) => String(node).trim())
}

export function normalizeResultsPath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
}

export function readGitHubConfig(env = {}) {
  const token = String(env.GITHUB_TOKEN ?? '').trim()
  const repo = String(env.GITHUB_REPO ?? '')
    .trim()
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
  const branch = String(env.GITHUB_BRANCH ?? '').trim() || DEFAULT_GITHUB_BRANCH
  const resultsPath = normalizeResultsPath(env.GITHUB_RESULTS_PATH ?? DEFAULT_GITHUB_RESULTS_PATH)
  const apiBaseUrl = (String(env.GITHUB_API_BASE_URL ?? '').trim() || DEFAULT_GITHUB_API_BASE_URL).replace(
    /\/+$/,
    '',
  )

  return {
    token,
    repo,
    branch,
    resultsPath,
    apiBaseUrl,
    gpuTypeMap: parseGpuTypeMap(env.GPU_TYPE_MAP),
  }
}

export function isGitHubConfigured(config) {
  return Boolean(config) && Boolean(config.token) && REPO_PATTERN.test(String(config.repo || ''))
}

// Payload of `GET /github/status`: it lets the dashboard disable the upload buttons and explain why
// instead of failing after the operator already collected the results.
export function describeGitHubConfig(config) {
  const missing = []
  if (!config || !config.token) {
    missing.push('GITHUB_TOKEN')
  }
  if (!REPO_PATTERN.test(String(config?.repo || ''))) {
    missing.push('GITHUB_REPO')
  }

  return {
    configured: missing.length === 0,
    repo: config?.repo || '',
    branch: config?.branch || DEFAULT_GITHUB_BRANCH,
    resultsPath: config?.resultsPath ?? '',
    gpuTypes: Object.entries(config?.gpuTypeMap || {}).map(([type, nodes]) => ({
      type,
      nodes: [...nodes],
    })),
    missing,
    message: missing.length === 0 ? '' : `Set ${missing.join(' and ')} in .env to enable GitHub uploads.`,
  }
}

export function sanitizeSegment(value, fallback = 'unknown') {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[\\/]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(UNSAFE_SEGMENT_PATTERN, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')

  return cleaned || fallback
}

// `<model>-<gpuType>-<N>gpus`, e.g. `deepseek-ai_DeepSeek-R1-Distill-Qwen-7B-A40-2gpus`.
export function buildResultsFolderName({ model, gpuType, gpuCount } = {}) {
  const modelSegment = sanitizeSegment(model, '')
  if (!modelSegment) {
    return { ok: false, folder: '', error: 'A model name is required to build the upload folder.' }
  }

  const typeSegment = sanitizeSegment(gpuType, '')
  if (!typeSegment) {
    return { ok: false, folder: '', error: 'A GPU type is required to build the upload folder.' }
  }

  const numericCount = Number(gpuCount)
  if (!Number.isInteger(numericCount) || numericCount < 1 || numericCount > MAX_GPU_COUNT) {
    return {
      ok: false,
      folder: '',
      error: `The GPU count must be an integer between 1 and ${MAX_GPU_COUNT}.`,
    }
  }

  return { ok: true, folder: `${modelSegment}-${typeSegment}-${numericCount}gpus`, error: '' }
}

// `results/<folder>/<experimentFolder>/<sub-experiment>/<iteration>/results.csv` inside the repository.
// `experimentFolder` is the experiment (results source) the file was read from, and `relativePath` is
// the `<sub-experiment>/<iteration>/results.csv` tail below it.
export function buildResultsTreePath(config, folder, experimentFolder = '', relativePath = '') {
  return [config?.resultsPath, folder, experimentFolder, relativePath]
    .map((segment) =>
      String(segment ?? '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, ''),
    )
    .filter(Boolean)
    .join('/')
}

function normalizeResultRelativePath(rawPath) {
  const normalized = String(rawPath ?? '')
    .replace(/\\/g, '/')
    .trim()

  if (!normalized || normalized.startsWith('/')) {
    return null
  }

  const segments = normalized.split('/').filter(Boolean)
  if (segments.length < 3) {
    return null
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return null
  }
  if (segments[segments.length - 1] !== RESULTS_FILE_NAME) {
    return null
  }

  return segments.join('/')
}

// Only folder-style `results.csv` files may be uploaded, and each of them has to name the experiment it
// belongs to: `<experimentFolder>/<sub-experiment>/<iteration>/results.csv`. Anything else (path
// traversal, absolute paths, other file types, a results.csv sitting directly in a sub-experiment
// folder, a file without an experiment name, a file of the live `current` source) is refused instead of
// being silently rewritten or committed into a folder shared by several runs.
export function validateUploadFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      error: 'No results.csv files were provided for the upload.',
      files: [],
      totalBytes: 0,
    }
  }

  if (files.length > MAX_UPLOAD_FILES) {
    return {
      ok: false,
      error: `Too many files in one upload (${files.length} > ${MAX_UPLOAD_FILES}).`,
      files: [],
      totalBytes: 0,
    }
  }

  const validated = []
  const seenTreePaths = new Set()
  let totalBytes = 0

  for (const entry of files) {
    const relativePath = normalizeResultRelativePath(entry?.path)
    if (!relativePath) {
      return {
        ok: false,
        error: `Invalid results path "${String(entry?.path ?? '')}". Expected "<sub-experiment>/<iteration>/${RESULTS_FILE_NAME}".`,
        files: [],
        totalBytes: 0,
      }
    }

    // The experiment level has to come from the caller, because only the dashboard knows which results
    // source the file was read from.
    const experimentFolder = sanitizeSegment(entry?.experimentFolder, '')
    if (!experimentFolder) {
      return {
        ok: false,
        error: `"${relativePath}" does not name the experiment (results source) it belongs to.`,
        files: [],
        totalBytes: 0,
      }
    }

    if (experimentFolder === UNNAMED_EXPERIMENT_SOURCE) {
      return {
        ok: false,
        error: `The ongoing "${UNNAMED_EXPERIMENT_SOURCE}" results source has no experiment name yet, so its sub-experiments cannot be uploaded. Upload the Experiment_* archive the run becomes once it ends.`,
        files: [],
        totalBytes: 0,
      }
    }

    // Two archives usually hold the same sub-experiment names, so the experiment level is part of the
    // identity of a file: without it the second archive would be dropped as a duplicate of the first.
    if (seenTreePaths.has(`${experimentFolder}/${relativePath}`)) {
      continue
    }

    const content = typeof entry?.contentBase64 === 'string' ? entry.contentBase64.replace(/\s+/g, '') : ''
    if (!content || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) {
      return {
        ok: false,
        error: `"${relativePath}" does not contain base64 CSV content.`,
        files: [],
        totalBytes: 0,
      }
    }

    const bytes = Buffer.byteLength(content, 'base64')
    if (bytes === 0) {
      return { ok: false, error: `"${relativePath}" is empty.`, files: [], totalBytes: 0 }
    }
    if (bytes > MAX_UPLOAD_FILE_BYTES) {
      return {
        ok: false,
        error: `"${relativePath}" is larger than the ${Math.round(MAX_UPLOAD_FILE_BYTES / (1024 * 1024))} MB per-file limit.`,
        files: [],
        totalBytes: 0,
      }
    }

    totalBytes += bytes
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      return {
        ok: false,
        error: `The upload is larger than the ${Math.round(MAX_UPLOAD_TOTAL_BYTES / (1024 * 1024))} MB limit.`,
        files: [],
        totalBytes: 0,
      }
    }

    seenTreePaths.add(`${experimentFolder}/${relativePath}`)
    validated.push({ experimentFolder, path: relativePath, content, bytes })
  }

  return { ok: true, error: '', files: validated, totalBytes }
}

function buildWebBaseUrl(config) {
  const base = String(config?.apiBaseUrl || '')
  if (!base || base === DEFAULT_GITHUB_API_BASE_URL) {
    return GITHUB_WEB_BASE_URL
  }

  return base.replace(/\/api\/v3\/?$/i, '').replace(/\/+$/, '')
}

function buildCommitMessage(commitMessage, folder) {
  const trimmed = typeof commitMessage === 'string' ? commitMessage.trim() : ''
  return trimmed || `Add ${folder} results`
}

function describeGitHubFailure(response, payload) {
  const detail = payload?.message ? ` GitHub said: ${payload.message}` : ''

  if (response.status === 401) {
    return ` The GITHUB_TOKEN was rejected (401); check that it is valid and not expired.${detail}`
  }

  if (response.status === 403 || response.status === 404) {
    return ` Check that GITHUB_REPO exists and that the token can write to it (Contents: read & write).${detail}`
  }

  if (response.status === 422) {
    return ` GitHub rejected the payload (422).${detail}`
  }

  return detail
}

async function githubRequest({ fetchImpl, config, pathname, method = 'GET', body }) {
  const response = await fetchImpl(`${config.apiBaseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'MoST-dashboard',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  return { response, payload }
}

function assertGitHubResponse(action, { response, payload }) {
  if (response.ok) {
    return
  }

  throw new GitHubUploadError(
    `GitHub could not ${action} (HTTP ${response.status}).${describeGitHubFailure(response, payload)}`,
    502,
  )
}

// Creates one commit holding every file of a single upload. The tree is sent with the previous tree
// as `base_tree` and the blob contents inlined, so the upload costs four API calls (branch ref, tree,
// commit, ref update) no matter how many iterations it carries, and re-uploading identical results
// creates no commit at all.
export async function uploadResults({ config, folder, files, commitMessage, fetchImpl } = {}) {
  if (!isGitHubConfigured(config)) {
    throw new GitHubUploadError(
      'GitHub upload is not configured. Set GITHUB_TOKEN and GITHUB_REPO in .env and restart the tunnel manager.',
      409,
    )
  }

  if (!folder) {
    throw new GitHubUploadError('An upload folder name is required.', 400)
  }

  const validation = validateUploadFiles(files)
  if (!validation.ok) {
    throw new GitHubUploadError(validation.error, 400)
  }

  const request = fetchImpl || globalThis.fetch
  if (typeof request !== 'function') {
    throw new GitHubUploadError('No fetch implementation is available in this Node runtime.', 500)
  }

  const { repo, branch } = config
  const folderPath = buildResultsTreePath(config, folder)
  const requestOptions = { fetchImpl: request, config }

  let baseCommitSha = null
  let baseTreeSha = null

  const refResult = await githubRequest({
    ...requestOptions,
    pathname: `/repos/${repo}/git/ref/heads/${branch}`,
  })

  if (refResult.response.ok) {
    baseCommitSha = refResult.payload?.object?.sha || null

    if (baseCommitSha) {
      const commitResult = await githubRequest({
        ...requestOptions,
        pathname: `/repos/${repo}/git/commits/${baseCommitSha}`,
      })
      assertGitHubResponse(`read the ${branch} branch tip`, commitResult)
      baseTreeSha = commitResult.payload?.tree?.sha || null
    }
  } else if (refResult.response.status !== 404 && refResult.response.status !== 409) {
    // 404/409 mean the branch (or the whole repository) is still empty: the commit below then creates
    // `refs/heads/<branch>` from scratch.
    assertGitHubResponse(`read the ${branch} branch`, refResult)
  }

  const treeBody = {
    tree: validation.files.map((file) => ({
      path: buildResultsTreePath(config, folder, file.experimentFolder, file.path),
      mode: '100644',
      type: 'blob',
      content: file.content,
    })),
  }

  if (baseTreeSha) {
    treeBody.base_tree = baseTreeSha
  }

  const treeResult = await githubRequest({
    ...requestOptions,
    pathname: `/repos/${repo}/git/trees`,
    method: 'POST',
    body: treeBody,
  })
  assertGitHubResponse('create the upload tree', treeResult)

  const treeSha = treeResult.payload?.sha || null
  if (!treeSha) {
    throw new GitHubUploadError('GitHub did not return a tree for the upload.', 502)
  }

  const summary = {
    ok: true,
    repo,
    branch,
    folder,
    folderPath,
    // One upload may carry several archives at once (the dashboard can sweep every completed results
    // source), and they are written as sibling experiment folders under `folderPath`.
    experimentFolders: [...new Set(validation.files.map((file) => file.experimentFolder))],
    fileCount: validation.files.length,
    totalBytes: validation.totalBytes,
    resultsPath: config.resultsPath,
    webUrl: `${buildWebBaseUrl(config)}/${repo}`,
  }

  if (baseTreeSha && treeSha === baseTreeSha) {
    return { ...summary, unchanged: true, commitSha: baseCommitSha, commitUrl: `${summary.webUrl}/commit/${baseCommitSha}`, treeSha }
  }

  const commitResult = await githubRequest({
    ...requestOptions,
    pathname: `/repos/${repo}/git/commits`,
    method: 'POST',
    body: {
      message: buildCommitMessage(commitMessage, folder),
      tree: treeSha,
      parents: baseCommitSha ? [baseCommitSha] : [],
    },
  })
  assertGitHubResponse('create the upload commit', commitResult)

  const commitSha = commitResult.payload?.sha || null
  if (!commitSha) {
    throw new GitHubUploadError('GitHub did not return a commit for the upload.', 502)
  }

  if (baseCommitSha) {
    const updateResult = await githubRequest({
      ...requestOptions,
      pathname: `/repos/${repo}/git/refs/heads/${branch}`,
      method: 'PATCH',
      body: { sha: commitSha, force: false },
    })
    assertGitHubResponse(`update the ${branch} branch`, updateResult)
  } else {
    const createResult = await githubRequest({
      ...requestOptions,
      pathname: `/repos/${repo}/git/refs`,
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: commitSha },
    })
    assertGitHubResponse(`create the ${branch} branch`, createResult)
  }

  return {
    ...summary,
    unchanged: false,
    commitSha,
    commitUrl: `${summary.webUrl}/commit/${commitSha}`,
    treeSha,
  }
}
