// GitHub upload helper used by tunnel-manager.mjs.
//
// The dashboard browser already knows which `results.csv` files exist for a finished experiment (it
// walks the same folder tree for the ZIP download) and posts them here, so this module only has to
// turn a flat list of files into one GitHub commit. The GitHub token stays in this Node process on
// purpose: every `VITE_*` value is inlined into the static bundle, so a token placed there would be
// readable by anyone who loads the deployed dashboard.
//
// The posted files carry base64 because they travel inside a JSON body, while the commit is created
// with the "create tree" endpoint, whose blob content is plain text: `validateUploadFiles` decodes the
// payload before it is inlined, so what lands in the repository is the `results.csv` itself and not
// its base64 spelling.
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
//
// Every level of that layout is length-capped before the tree is created (see `planUploadTree`): a
// folder name longer than 255 bytes cannot be checked out on any of the filesystems the results
// repository is cloned on, and a full path longer than ~260 characters breaks `git clone` on Windows.
// A name over its cap keeps its readable head plus a digest of the full name, so the identity of the
// experiment, sub-experiment or iteration it names survives the trimming, the mapping stays stable
// (re-uploading the same results is still a no-op) and two long names never land in the same folder.

import { createHash } from 'node:crypto'

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

// Longest folder name each level of the upload tree may have. A name that fits is committed exactly as
// it is, so every folder a previous upload created keeps its spelling and re-uploads stay no-ops; only
// the names that cannot be checked out are trimmed. The caps are the ones the results repository needs:
// 255 bytes is the per-component limit of ext4/APFS/NTFS (`File name too long` during `git checkout`),
// and 260 characters is the Windows `MAX_PATH` limit, since Git for Windows ships `core.longpaths=false`
// (`Filename too long` during `git clone`).
export const MAX_MODEL_SEGMENT_LENGTH = 48
export const MAX_GPU_TYPE_SEGMENT_LENGTH = 16
export const MAX_EXPERIMENT_SEGMENT_LENGTH = 56
export const MAX_SUB_EXPERIMENT_SEGMENT_LENGTH = 48
export const MAX_ITERATION_SEGMENT_LENGTH = 32
// Hex digits of the digest appended to a trimmed name: enough to keep two long names apart (a 1 in 4.3
// billion chance per pair) while staying short.
export const SEGMENT_HASH_LENGTH = 8
// Longest complete tree path a trimmed upload may produce, measured from the results folder up, so the
// repository stays clonable into a reasonably short directory on Windows.
export const MAX_TREE_PATH_LENGTH = 200
// Levels the path budget never trims below, so a trimmed name still reads as the folder it names.
const MIN_SEGMENT_LENGTHS = Object.freeze({
  experiment: 40,
  subExperiment: 36,
  iteration: 24,
})

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

// Digest of an already sanitized name. It is what carries the identity of a trimmed folder: the head
// keeps the name readable for a human, the digest keeps it unique and traceable to the full name.
function segmentHash(segment) {
  return createHash('sha256').update(String(segment), 'utf8').digest('hex').slice(0, SEGMENT_HASH_LENGTH)
}

function clampSegmentLength(maxLength) {
  const requested = Number(maxLength)
  return Number.isFinite(requested) && requested > SEGMENT_HASH_LENGTH + 2
    ? Math.floor(requested)
    : SEGMENT_HASH_LENGTH + 2
}

// Folders already in the repository keep their exact spelling: a name within its cap is returned as it
// is, so re-uploading known results still produces the same tree (and stays a no-op commit).
export function shortenSegment(segment, maxLength) {
  const value = String(segment ?? '')
  const cap = clampSegmentLength(maxLength)
  if (value.length <= cap) {
    return value
  }

  // Anything but a letter or digit is a separator `sanitizeSegment` can leave behind (`_`, `-`, `.`) or
  // that the raw folder names already contain (`,` and `:` of the `mix_...` names), so trimming back to
  // one avoids names that end in a stray separator before the digest.
  const head = value.slice(0, cap - SEGMENT_HASH_LENGTH - 1).replace(/[^A-Za-z0-9]+$/, '')
  return head ? `${head}-${segmentHash(value)}` : segmentHash(value)
}

// Archive (`Experiment_<TYPE>_<timestamp>`) and iteration folders end in `_<YYYY-MM-DD_HH-MM-SS>`: that
// tail is re-attached behind the digest, so a trimmed folder still shows when the run happened. The
// separator is accepted as `_` (the archive layout) or `-` (how the matrix cells name their iterations).
const TRAILING_TIMESTAMP_PATTERN = /[-_]\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/
const MIN_TRIMMED_HEAD_LENGTH = 8

export function shortenTrailingTimestampSegment(segment, maxLength) {
  const value = String(segment ?? '')
  const cap = clampSegmentLength(maxLength)
  if (value.length <= cap) {
    return value
  }

  const tail = TRAILING_TIMESTAMP_PATTERN.exec(value)?.[0] || ''
  const headBudget = cap - SEGMENT_HASH_LENGTH - 1 - tail.length
  if (!tail || headBudget < MIN_TRIMMED_HEAD_LENGTH) {
    return shortenSegment(value, cap)
  }

  const head = value.slice(0, headBudget).replace(/[^A-Za-z0-9]+$/, '')
  return head ? `${head}-${segmentHash(value)}${tail}` : shortenSegment(value, cap)
}

// `<model>-<gpuType>-<N>gpus`, e.g. `deepseek-ai_DeepSeek-R1-Distill-Qwen-7B-A40-2gpus`. Only the model
// part is capped, so the hardware suffix always survives and the folder stays readable.
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

  const trimmedModel = shortenSegment(modelSegment, MAX_MODEL_SEGMENT_LENGTH)
  const trimmedType = shortenSegment(typeSegment, MAX_GPU_TYPE_SEGMENT_LENGTH)

  return { ok: true, folder: `${trimmedModel}-${trimmedType}-${numericCount}gpus`, error: '' }
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

// Caps the three levels below `<model>-<gpuType>-<N>gpus` are trimmed to. The budget is balanced on the
// worst case - every level at its cap - and the deepest level that still has room is lowered first, so
// all files of one upload agree on one experiment folder and uploading the same results twice keeps
// producing the same tree. The result depends only on the results path, the folder and those floors,
// never on the actual sub-experiment names, which is what keeps the mapping stable.
function resolveTreeCaps(resultsPath, folder) {
  const fixedLength =
    String(resultsPath ?? '').length + String(folder ?? '').length + RESULTS_FILE_NAME.length + 5
  const levels = [
    { key: 'iteration', cap: MAX_ITERATION_SEGMENT_LENGTH, floor: MIN_SEGMENT_LENGTHS.iteration },
    { key: 'subExperiment', cap: MAX_SUB_EXPERIMENT_SEGMENT_LENGTH, floor: MIN_SEGMENT_LENGTHS.subExperiment },
    { key: 'experiment', cap: MAX_EXPERIMENT_SEGMENT_LENGTH, floor: MIN_SEGMENT_LENGTHS.experiment },
  ]
  let total = fixedLength + levels.reduce((sum, level) => sum + level.cap, 0)

  for (const level of levels) {
    const room = level.cap - level.floor
    if (room <= 0 || total <= MAX_TREE_PATH_LENGTH) {
      continue
    }

    const reduction = Math.min(room, total - MAX_TREE_PATH_LENGTH)
    level.cap -= reduction
    total -= reduction
  }

  return {
    experiment: levels[2].cap,
    subExperiment: levels[1].cap,
    iteration: levels[0].cap,
  }
}

function describeTrimmedName(level, from, to) {
  return { level, from, to }
}

// Turns the validated files into the tree the commit is created from, trimming every level that git
// cannot check out. Returns the trimmed names the files actually land under, so the caller reports the
// repository layout instead of the raw one, plus a summary of what was shortened for the upload notice.
export function planUploadTree(config, folder, files = []) {
  const caps = resolveTreeCaps(config?.resultsPath, folder)
  const folderPath = buildResultsTreePath(config, folder)
  const trimmedByExperiment = new Map()
  const rawByTreePath = new Map()
  const shortened = new Map()
  const planned = []
  let shortenedCount = 0

  for (const file of files) {
    if (!file) {
      continue
    }

    const experimentFolder = shortenTrailingTimestampSegment(file.experimentFolder, caps.experiment)
    const relativePath = shortenResultRelativePath(
      file.path,
      caps.subExperiment,
      caps.iteration,
    )

    // Two different archive names must never end up in one folder: their results would merge and the
    // experiment level would stop identifying the run. The digest makes a collision implausible, so
    // failing loudly is enough.
    const knownRaw = trimmedByExperiment.get(experimentFolder)
    if (knownRaw !== undefined && knownRaw !== file.experimentFolder) {
      throw new GitHubUploadError(
        `The experiment names "${knownRaw}" and "${file.experimentFolder}" are both too long for git and shorten to "${experimentFolder}", which would merge them into one folder. Rename one of the results sources and upload it again.`,
        400,
      )
    }
    trimmedByExperiment.set(experimentFolder, file.experimentFolder)

    const treePath = buildResultsTreePath(config, folder, experimentFolder, relativePath)
    const knownPath = rawByTreePath.get(treePath)
    if (knownPath !== undefined && knownPath !== file.path) {
      throw new GitHubUploadError(
        `The sub-experiment names "${knownPath}" and "${file.path}" are both too long for git and shorten to the same path "${treePath}". Rename one of them and upload it again.`,
        400,
      )
    }
    rawByTreePath.set(treePath, file.path)

    if (treePath.length > MAX_TREE_PATH_LENGTH) {
      throw new GitHubUploadError(
        `The upload path "${treePath}" is longer than the ${MAX_TREE_PATH_LENGTH} characters git can check out reliably. Rename the sub-experiment it belongs to and upload it again.`,
        400,
      )
    }

    for (const [level, from, to] of [
      ['experiment', file.experimentFolder, experimentFolder],
      ['path', file.path, relativePath],
    ]) {
      if (from === to || shortened.has(`${level}:${from}`)) {
        continue
      }

      shortened.set(`${level}:${from}`, describeTrimmedName(level, from, to))
      shortenedCount += 1
    }

    planned.push({
      experimentFolder,
      path: relativePath,
      treePath,
      content: file.content,
      bytes: file.bytes,
    })
  }

  return {
    folderPath,
    caps,
    files: planned,
    experimentFolders: [...new Set(planned.map((file) => file.experimentFolder))],
    // Kept short on purpose: the response only has to tell the dashboard how many names were trimmed and
    // show a few examples, while the full mapping is logged by the caller.
    trimmed: {
      count: shortenedCount,
      examples: [...shortened.values()].slice(0, 10),
    },
  }
}

// `<sub-experiment>/<iteration>/results.csv`, with both folder levels trimmed. The file name itself is
// fixed (`RESULTS_FILE_NAME`), and a path with a different shape is left to the validator to reject.
export function shortenResultRelativePath(
  relativePath,
  subExperimentMaxLength = MAX_SUB_EXPERIMENT_SEGMENT_LENGTH,
  iterationMaxLength = MAX_ITERATION_SEGMENT_LENGTH,
) {
  const segments = String(relativePath ?? '')
    .split('/')
    .filter(Boolean)

  if (segments.length < 3) {
    return String(relativePath ?? '')
  }

  return [
    shortenSegment(segments[0], subExperimentMaxLength),
    shortenTrailingTimestampSegment(segments[1], iterationMaxLength),
    ...segments.slice(2),
  ].join('/')
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

    const base64 = typeof entry?.contentBase64 === 'string' ? entry.contentBase64.replace(/\s+/g, '') : ''
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      return {
        ok: false,
        error: `"${relativePath}" does not contain base64 CSV content.`,
        files: [],
        totalBytes: 0,
      }
    }

    // The request body is JSON, so a `results.csv` travels base64-encoded, but the commit is created
    // with the "create tree" endpoint, whose `content` is plain text (the Contents and Blobs endpoints
    // are the ones that take base64). Inlining the payload as it arrives is what made every committed
    // `results.csv` hold its own base64 spelling instead of the CSV it stands for, so it is decoded
    // here, once, and only the decoded text reaches the tree.
    const decoded = Buffer.from(base64, 'base64')
    const bytes = decoded.length
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

    const content = decoded.toString('utf8')
    // A results.csv is UTF-8 text: a payload whose bytes cannot be spelled as UTF-8 is refused instead
    // of being committed with replacement characters in place of its original content.
    if (!Buffer.from(content, 'utf8').equals(decoded)) {
      return {
        ok: false,
        error: `"${relativePath}" is not UTF-8 text, so it cannot be committed as a results.csv.`,
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
// creates no commit at all. The inlined contents are the decoded CSVs `validateUploadFiles` produced,
// which is what keeps the committed files readable as CSV.
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
  const requestOptions = { fetchImpl: request, config }
  // Every level of the tree is trimmed before the first API call, so a name git cannot check out can
  // never reach the repository: the dashboard keeps sending the raw names, the commit uses the trimmed
  // ones, and `plan.trimmed` reports what changed. `plan` also rejects two raw names that would collapse
  // into one folder, which would silently merge two experiments.
  const plan = planUploadTree(config, folder, validation.files)
  const folderPath = plan.folderPath

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
    tree: plan.files.map((file) => ({
      path: file.treePath,
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
    experimentFolders: plan.experimentFolders,
    fileCount: plan.files.length,
    totalBytes: validation.totalBytes,
    resultsPath: config.resultsPath,
    // Names git could not check out, as they appear in the repository instead: `count` says how many
    // were shortened and `examples` shows the first few, so the dashboard can say so in its notice.
    trimmed: plan.trimmed,
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
