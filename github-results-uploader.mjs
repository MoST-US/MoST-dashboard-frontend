// GitHub upload helper used by tunnel-manager.mjs.
//
// The dashboard browser already knows which result CSV files exist for a finished experiment (it
// walks the same folder tree for the ZIP download) and posts them here, so this module only has to
// turn a flat list of files into one GitHub commit. The GitHub token stays in this Node process on
// purpose: every `VITE_*` value is inlined into the static bundle, so a token placed there would be
// readable by anyone who loads the deployed dashboard.
//
// The posted files carry base64 because they travel inside a JSON body. Small files are decoded before
// being inlined in the "create tree" request, whose blob content is plain text; larger files are sent
// to the Git blobs endpoint and referenced by SHA, so what lands in the repository is always the CSV
// itself and not its base64 spelling.
//
// Repository layout produced by an upload (see `buildResultsFolderName` / `buildResultsTreePath`):
//   <GITHUB_RESULTS_PATH>/<model>-<gpuType>-<N>gpus/<experimentFolder>/<sub-experiment>/<iteration>/<file>
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

import { createHash, randomUUID } from 'node:crypto'

const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com'
const GITHUB_WEB_BASE_URL = 'https://github.com'
const DEFAULT_GITHUB_BRANCH = 'main'
const DEFAULT_GITHUB_RESULTS_PATH = 'results'
const RESULTS_FILE_NAMES = new Set(['results.csv', 'results_from_json.csv'])
const UPLOAD_MODES = new Set(['full', 'update'])
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

// GitHub rejects blobs at or above 100 MiB. Files up to 8 MiB are inlined in the tree request; larger
// files use the Git blobs endpoint and are referenced by SHA in the tree instead.
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024
export const MAX_INLINE_UPLOAD_FILE_BYTES = 8 * 1024 * 1024
// GitHub limits each tree request, not the logical upload. Inline tree entries contain the CSV text
// inside a JSON document, so their serialized size can be larger than the files' UTF-8 byte count.
// Keep a conservative limit to avoid GitHub's undocumented request-size ceiling.
export const MAX_UPLOAD_TOTAL_BYTES = 64 * 1024 * 1024
export const MAX_UPLOAD_TREE_PAYLOAD_BYTES = 8 * 1024 * 1024
export const MAX_UPLOAD_FILES = 5000
// Bodies carry base64 payloads, so the JSON envelope is larger than the raw results. This is the
// request limit for a logical upload; individual GitHub commits stay within the limits above.
export const MAX_UPLOAD_BODY_BYTES = 256 * 1024 * 1024

// A single stalled GitHub hop must not pin an upload: every API call gets a deadline and a few retries
// with backoff. A transient failure (a timeout, 408/429, a 5xx, or the secondary-rate-limit 403) is
// retried; a 4xx that is a real answer (bad token, missing repo, rejected payload) comes back at once.
// `Retry-After` and GitHub's rate-limit reset headers are honoured, so a throttled call waits as long
// as it is told to instead of hammering the API.
export const GITHUB_REQUEST_TIMEOUT_MS = 60000
export const GITHUB_REQUEST_MAX_ATTEMPTS = 4
const GITHUB_RETRY_BASE_DELAY_MS = 1000
const GITHUB_RETRY_MAX_DELAY_MS = 30000

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

// `results/<folder>/<experimentFolder>/<sub-experiment>/<iteration>/<file>` inside the repository.
// `experimentFolder` is the experiment (results source) the file was read from, and `relativePath` is
// the `<sub-experiment>/<iteration>/<file>` tail below it.
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
    String(resultsPath ?? '').length +
    String(folder ?? '').length +
    Math.max(...[...RESULTS_FILE_NAMES].map((name) => name.length)) +
    5
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
      contentBase64: file.contentBase64,
      bytes: file.bytes,
      // A CSV just below the inline threshold can still expand substantially when JSON-escaped
      // (for example, a response-heavy CSV with many quoted fields). Move that entry to the blob
      // endpoint if its actual tree representation would consume the whole request budget.
      useBlob:
        file.useBlob ||
        Buffer.byteLength(
          JSON.stringify({
            path: treePath,
            mode: '100644',
            type: 'blob',
            content: file.content,
          }),
          'utf8',
        ) >
          MAX_UPLOAD_TREE_PAYLOAD_BYTES - 256,
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

// `<sub-experiment>/<iteration>/<file>`, with both folder levels trimmed. The filename is restricted
// to the result CSVs accepted by the validator.
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
  if (!RESULTS_FILE_NAMES.has(segments[segments.length - 1])) {
    return null
  }

  return segments.join('/')
}

// Only folder-style result CSV files may be uploaded, and each of them has to name the experiment it
// belongs to: `<experimentFolder>/<sub-experiment>/<iteration>/<file>`. Anything else (path traversal,
// absolute paths, other file types, a CSV sitting directly in a sub-experiment folder, a file without an
// experiment name, a file of the live `current` source) is refused instead of being silently rewritten or
// committed into a folder shared by several runs.
export function validateUploadFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      error: 'No result CSV files were provided for the upload.',
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
        error: `Invalid results path "${String(entry?.path ?? '')}". Expected "<sub-experiment>/<iteration>/results.csv" or "<sub-experiment>/<iteration>/results_from_json.csv".`,
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

    // The request body is JSON, so a result CSV travels base64-encoded, but the commit is created
    // with the "create tree" endpoint, whose `content` is plain text (the Contents and Blobs endpoints
    // are the ones that take base64). Inlining the payload as it arrives is what made every committed
    // result files hold their own base64 spelling instead of the CSV they stand for, so it is decoded
    // here, once, and only the decoded text reaches the tree.
    const decoded = Buffer.from(base64, 'base64')
    const bytes = decoded.length
    if (bytes === 0) {
      return { ok: false, error: `"${relativePath}" is empty.`, files: [], totalBytes: 0 }
    }
    if (bytes > MAX_UPLOAD_FILE_BYTES) {
      return {
        ok: false,
        error: `"${relativePath}" is larger than GitHub's ${Math.round(MAX_UPLOAD_FILE_BYTES / (1024 * 1024))} MiB per-file limit.`,
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
    seenTreePaths.add(`${experimentFolder}/${relativePath}`)
    validated.push({
      experimentFolder,
      path: relativePath,
      content,
      contentBase64: base64,
      bytes,
      useBlob: bytes > MAX_INLINE_UPLOAD_FILE_BYTES,
    })
  }

  return { ok: true, error: '', files: validated, totalBytes }
}

function serializedTreeEntryBytes(file) {
  const entry = {
    path: file.treePath,
    mode: '100644',
    type: 'blob',
  }

  if (file.useBlob) {
    // Blob-backed files only contribute a SHA to the tree request. The actual blob is uploaded
    // separately and is therefore not part of the tree payload.
    entry.sha = '0'.repeat(40)
  } else {
    entry.content = file.content
  }

  return Buffer.byteLength(JSON.stringify(entry), 'utf8')
}

function splitUploadFiles(files) {
  const batches = []
  let batch = []
  let batchBytes = 0
  let batchTreePayloadBytes = Buffer.byteLength('{"tree":[]}', 'utf8')

  for (const file of files) {
    const entryBytes = serializedTreeEntryBytes(file)
    const startsNewBatch =
      batch.length > 0 &&
      (
        batch.length >= MAX_UPLOAD_FILES ||
        batchBytes + file.bytes > MAX_UPLOAD_TOTAL_BYTES ||
        batchTreePayloadBytes + entryBytes + 1 > MAX_UPLOAD_TREE_PAYLOAD_BYTES
      )

    if (startsNewBatch) {
      batches.push(batch)
      batch = []
      batchBytes = 0
      batchTreePayloadBytes = Buffer.byteLength('{"tree":[]}', 'utf8')
    }

    batch.push(file)
    batchBytes += file.bytes
    // One byte accounts for the comma between entries. The small fixed wrapper and base_tree
    // field are covered by the conservative headroom in MAX_UPLOAD_TREE_PAYLOAD_BYTES.
    batchTreePayloadBytes += entryBytes + 1
  }

  if (batch.length > 0) {
    batches.push(batch)
  }

  return batches
}

function normalizeUploadMode(value) {
  const mode = String(value ?? '').trim().toLowerCase()
  return UPLOAD_MODES.has(mode) ? mode : 'full'
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function backoffMs(attempt) {
  const capped = Math.min(GITHUB_RETRY_MAX_DELAY_MS, GITHUB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
  return capped + Math.floor(Math.random() * 250)
}

// How long to wait before retrying, from the response when it says so. `Retry-After` (seconds or an HTTP
// date) wins; otherwise GitHub's epoch-second rate-limit reset; otherwise null so the caller falls back
// to exponential backoff.
function retryAfterMs(response, payload) {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000
    }
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) {
      return Math.max(0, date - Date.now())
    }
  }

  const remaining = response.headers.get('x-ratelimit-remaining')
  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (remaining === '0' && Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - Date.now())
  }

  return null
}

function isRetryableGitHubResponse(response, payload) {
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return true
  }
  if (response.status === 403) {
    // A permission 403 is terminal; only the rate-limit flavour is worth a retry.
    const message = String(payload?.message || '').toLowerCase()
    return (
      response.headers.get('retry-after') !== null ||
      response.headers.get('x-ratelimit-remaining') === '0' ||
      message.includes('rate limit')
    )
  }
  return false
}

async function githubRequest({ fetchImpl, config, pathname, method = 'GET', body }) {
  const url = `${config.apiBaseUrl}${pathname}`
  const requestOptions = {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'MoST-dashboard',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }

  for (let attempt = 1; attempt <= GITHUB_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS)

    let response
    let payload = null
    try {
      response = await fetchImpl(url, { ...requestOptions, signal: controller.signal })
      const text = await response.text()
      if (text) {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = null
        }
      }
    } catch (error) {
      if (attempt === GITHUB_REQUEST_MAX_ATTEMPTS) {
        const reason = error?.name === 'AbortError' ? 'timed out' : 'could not be reached'
        throw new GitHubUploadError(
          `GitHub ${reason} after ${attempt} attempt(s): ${error?.message || error}`,
          502,
        )
      }
      await sleep(backoffMs(attempt))
      continue
    } finally {
      clearTimeout(timer)
    }

    if (response.ok) {
      return { response, payload }
    }

    if (isRetryableGitHubResponse(response, payload) && attempt < GITHUB_REQUEST_MAX_ATTEMPTS) {
      await sleep(retryAfterMs(response, payload) ?? backoffMs(attempt))
      continue
    }

    // A terminal answer (a real 4xx, or the last of the attempts): hand it back so `assertGitHubResponse`
    // builds the message exactly as before.
    return { response, payload }
  }

  // Unreachable: every path above returns or throws.
  throw new GitHubUploadError('The GitHub request failed unexpectedly.', 502)
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

// Creates one or more sequential commits holding the files of a logical upload. Each tree is sent
// with the current branch tree as `base_tree`, keeping every commit cumulative while respecting the
// per-commit limits above. Re-uploading identical results creates no commits.
export async function uploadResults({
  config,
  folder,
  files,
  commitMessage,
  uploadMode = 'full',
  fetchImpl,
} = {}) {
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
  const mode = normalizeUploadMode(uploadMode)

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
    uploadMode: mode,
    webUrl: `${buildWebBaseUrl(config)}/${repo}`,
  }
  let filesToUpload = plan.files
  let baseCommitSha = null
  let baseTreeSha = null
  let latestTreeSha = null
  let commitsCreated = 0

  if (mode === 'update') {
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
      assertGitHubResponse(`read the ${branch} branch`, refResult)
    }

    if (baseTreeSha) {
      const treeResult = await githubRequest({
        ...requestOptions,
        pathname: `/repos/${repo}/git/trees/${baseTreeSha}?recursive=1`,
      })
      assertGitHubResponse('read the existing results tree', treeResult)
      if (treeResult.payload?.truncated) {
        throw new GitHubUploadError(
          'GitHub returned a truncated repository tree, so update upload cannot safely check every result file.',
          502,
        )
      }

      const existingPaths = new Set(
        (treeResult.payload?.tree || [])
          .filter((entry) => entry?.type === 'blob')
          .map((entry) => entry.path),
      )
      const completeIterations = new Set()
      for (const file of plan.files) {
        if (
          RESULTS_FILE_NAMES.has(file.path.split('/').pop()) &&
          existingPaths.has(file.treePath)
        ) {
          const iterationPath = file.treePath.slice(0, file.treePath.lastIndexOf('/'))
          const pair = `${iterationPath}/results.csv`
          const jsonPair = `${iterationPath}/results_from_json.csv`
          if (existingPaths.has(pair) && existingPaths.has(jsonPair)) {
            completeIterations.add(iterationPath)
          }
        }
      }
      filesToUpload = plan.files.filter(
        (file) => !completeIterations.has(file.treePath.slice(0, file.treePath.lastIndexOf('/'))),
      )
    }
  }

  summary.fileCount = filesToUpload.length
  summary.skippedFileCount = plan.files.length - filesToUpload.length
  if (filesToUpload.length === 0) {
    summary.unchanged = true
    summary.commitCount = 0
    summary.batchCount = 0
    return summary
  }

  const batches = splitUploadFiles(filesToUpload)

  for (const [batchIndex, batch] of batches.entries()) {
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
      // 404/409 mean the branch (or the whole repository) is still empty.
      assertGitHubResponse(`read the ${branch} branch`, refResult)
    }

    const treeBody = {
      tree: [],
    }

    for (const file of batch) {
      const treeEntry = {
        path: file.treePath,
        mode: '100644',
        type: 'blob',
      }

      if (file.useBlob) {
        const blobResult = await githubRequest({
          ...requestOptions,
          pathname: `/repos/${repo}/git/blobs`,
          method: 'POST',
          body: {
            content: file.contentBase64,
            encoding: 'base64',
          },
        })
        assertGitHubResponse(`create the blob for ${file.treePath}`, blobResult)

        const blobSha = blobResult.payload?.sha || null
        if (!blobSha) {
          throw new GitHubUploadError(`GitHub did not return a blob for ${file.treePath}.`, 502)
        }
        treeEntry.sha = blobSha
      } else {
        treeEntry.content = file.content
      }

      treeBody.tree.push(treeEntry)
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
    latestTreeSha = treeSha

    if (baseTreeSha && treeSha === baseTreeSha) {
      continue
    }

    const messageSuffix = batches.length > 1 ? ` (part ${batchIndex + 1}/${batches.length})` : ''
    const commitResult = await githubRequest({
      ...requestOptions,
      pathname: `/repos/${repo}/git/commits`,
      method: 'POST',
      body: {
        message: `${buildCommitMessage(commitMessage, folder)}${messageSuffix}`,
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

    baseCommitSha = commitSha
    baseTreeSha = treeSha
    commitsCreated += 1
  }

  return {
    ...summary,
    unchanged: commitsCreated === 0,
    commitCount: commitsCreated,
    commitSha: baseCommitSha,
    commitUrl: baseCommitSha ? `${summary.webUrl}/commit/${baseCommitSha}` : '',
    treeSha: latestTreeSha,
    batchCount: batches.length,
  }
}

// ---------------------------------------------------------------------------
// Streaming upload sessions
// ---------------------------------------------------------------------------
//
// The dashboard used to post every collected CSV of an experiment in one JSON body, base64-encoded.
// That buffered the whole experiment (plus its base64 spelling and the enclosing JSON) in the browser
// and again in the tunnel manager before a single commit was created, so a sweep of a few thousand
// small files could pin hundreds of megabytes on the manager's single thread and stall `/status` with
// it. A session removes that peak: the dashboard opens one session per sub-experiment, posts each CSV
// as its raw bytes (one request per file), and the server keeps only that sub-experiment's pending tree
// before committing it, or splitting it into bounded parts when it is large.
//
// A session lives in this module (a plain Map) because the tunnel manager is a single process. It is
// pruned after UPLOAD_SESSION_TTL_MS of inactivity, so an upload the browser abandons (tab closed,
// navigation away) cannot pin memory forever.

// How long an idle session is kept before the janitor drops it. A sweep posts thousands of small files
// and each of them refreshes the timer, so this only ever expires a session the browser gave up on.
export const UPLOAD_SESSION_TTL_MS = 10 * 60 * 1000
// Inline files pending in a session are flushed into a commit once they reach this many bytes, which
// keeps the tree request (and so the manager's heap) bounded no matter how many files one experiment
// holds. Files larger than MAX_INLINE_UPLOAD_FILE_BYTES travel through a Git blob and only add a SHA to
// the pending tree, so they do not count against this budget.
export const UPLOAD_SESSION_FLUSH_BYTES = 4 * 1024 * 1024

const uploadSessions = new Map()

function disposeUploadSession(session) {
  // A completed session can have thousands of path strings and a large existing-path Set. Clear
  // those references before removing the session so the manager can reclaim them without waiting
  // for a long-lived request or the janitor.
  session.pending = []
  session.existingPaths = null
  session.rawByTreePath.clear()
  session.trimmedByExperiment.clear()
  session.shortened.clear()
  session.addChain = Promise.resolve()
}

function sessionInlineEntryBytes(treePath, content) {
  return Buffer.byteLength(
    JSON.stringify({ path: treePath, mode: '100644', type: 'blob', content }),
    'utf8',
  )
}

// Drops sessions the browser abandoned. Returns how many were removed so the caller can log it.
export function pruneUploadSessions(now = Date.now()) {
  let removed = 0
  for (const [id, session] of uploadSessions) {
    if (session.activeTasks > 0) {
      continue
    }
    if (now - session.lastActivityAt > UPLOAD_SESSION_TTL_MS) {
      disposeUploadSession(session)
      uploadSessions.delete(id)
      removed += 1
    }
  }
  return removed
}

export function getUploadSessionCount() {
  return uploadSessions.size
}

async function readBranchBase(session, request) {
  const { repo, branch } = session.config
  const requestOptions = { fetchImpl: request, config: session.config }
  const refResult = await githubRequest({
    ...requestOptions,
    pathname: `/repos/${repo}/git/ref/heads/${branch}`,
  })

  let baseCommitSha = null
  let baseTreeSha = null

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
    assertGitHubResponse(`read the ${branch} branch`, refResult)
  }

  return { baseCommitSha, baseTreeSha }
}

async function readExistingPaths(session, request) {
  if (!session.baseTreeSha) {
    return null
  }

  const { repo } = session.config
  const treeResult = await githubRequest({
    fetchImpl: request,
    config: session.config,
    pathname: `/repos/${repo}/git/trees/${session.baseTreeSha}?recursive=1`,
  })
  assertGitHubResponse('read the existing results tree', treeResult)
  if (treeResult.payload?.truncated) {
    throw new GitHubUploadError(
      'GitHub returned a truncated repository tree, so update upload cannot safely check every result file.',
      502,
    )
  }

  return new Set(
    (treeResult.payload?.tree || [])
      .filter((entry) => entry?.type === 'blob')
      .map((entry) => entry.path),
  )
}


// Opens the session an experiment's files stream into. `experimentFolder` is the results source the
// files were read from and becomes the experiment level of the tree, exactly as in `uploadResults`.
export async function createUploadSession({
  config,
  folder,
  experimentFolder,
  uploadMode = 'full',
  commitMessage = '',
  fetchImpl,
} = {}) {
  if (!isGitHubConfigured(config)) {
    throw new GitHubUploadError(
      'GitHub upload is not configured. Set GITHUB_TOKEN and GITHUB_REPO in .env and restart the tunnel manager.',
      409,
    )
  }

  if (!folder) {
    throw new GitHubUploadError('An upload folder name is required.', 400)
  }

  const experiment = sanitizeSegment(experimentFolder, '')
  if (!experiment) {
    throw new GitHubUploadError(
      'An upload session requires the experiment (results source) its files belong to.',
      400,
    )
  }

  if (experiment === UNNAMED_EXPERIMENT_SOURCE) {
    throw new GitHubUploadError(
      `The ongoing "${UNNAMED_EXPERIMENT_SOURCE}" results source has no experiment name yet, so its sub-experiments cannot be uploaded. Upload the Experiment_* archive the run becomes once it ends.`,
      400,
    )
  }

  const request = fetchImpl || globalThis.fetch
  if (typeof request !== 'function') {
    throw new GitHubUploadError('No fetch implementation is available in this Node runtime.', 500)
  }

  pruneUploadSessions()

  const mode = normalizeUploadMode(uploadMode)
  const session = {
    id: randomUUID(),
    config,
    folder,
    folderPath: buildResultsTreePath(config, folder),
    caps: resolveTreeCaps(config?.resultsPath, folder),
    experimentFolder: experiment,
    mode,
    commitMessage,
    baseCommitSha: null,
    baseTreeSha: null,
    existingPaths: null,
    pending: [],
    pendingBytes: 0,
    totalBytes: 0,
    fileCount: 0,
    skippedCount: 0,
    commitCount: 0,
    latestCommitSha: null,
    latestTreeSha: null,
    trimmedByExperiment: new Map(),
    rawByTreePath: new Map(),
    shortened: new Map(),
    shortenedCount: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    activeTasks: 0,
    // Tail of the per-session task chain (see `enqueueSessionTask`). The browser streams several files
    // at once now, so the shared bookkeeping below must be applied one task at a time.
    addChain: Promise.resolve(),
  }

  if (mode === 'update') {
    const base = await readBranchBase(session, request)
    session.baseCommitSha = base.baseCommitSha
    session.baseTreeSha = base.baseTreeSha
    session.existingPaths = await readExistingPaths(session, request)
  }

  uploadSessions.set(session.id, session)
  return session
}

function findUploadSession(id) {
  const session = uploadSessions.get(String(id ?? ''))
  if (!session) {
    throw new GitHubUploadError(
      'This upload session has expired or was never created. Start the upload again.',
      404,
    )
  }
  return session
}

// Runs `task` strictly after every task already queued for this session, and returns its result. The
// browser streams several files of one session concurrently, so the counters, the pending tree and any
// automatic flush must be applied one at a time or two overlapping adds could double-flush or drop a
// file. Tasks of different sessions are independent and still run in parallel. A rejected task never
// breaks the chain: the stored tail swallows both outcomes so the next task still runs.
function enqueueSessionTask(session, task) {
  session.activeTasks += 1
  session.lastActivityAt = Date.now()
  const result = session.addChain.then(async () => {
    session.lastActivityAt = Date.now()
    try {
      return await task()
    } finally {
      session.activeTasks -= 1
      session.lastActivityAt = Date.now()
    }
  })
  session.addChain = result.then(
    () => {},
    () => {},
  )
  return result
}

// Adds one CSV (raw bytes, already the file itself) to the session. The path is validated and trimmed
// exactly as `uploadResults` does it, so a session produces the same tree a one-shot upload would.
// The body runs through the session's task chain (see `enqueueSessionTask`) so overlapping file posts
// - the browser streams several at once - are applied one after another and never race the counters,
// the pending tree or an automatic flush.
export async function addUploadSessionFile({ id, relativePath, content, fetchImpl } = {}) {
  const session = findUploadSession(id)

  return enqueueSessionTask(session, () =>
    addUploadSessionFileLocked(session, { relativePath, content, fetchImpl }),
  )
}

async function addUploadSessionFileLocked(session, { relativePath, content, fetchImpl } = {}) {
  const request = fetchImpl || globalThis.fetch
  const requestOptions = { fetchImpl: request, config: session.config }
  const { repo } = session.config

  const normalized = normalizeResultRelativePath(relativePath)
  if (!normalized) {
    throw new GitHubUploadError(
      `Invalid results path "${String(relativePath ?? '')}". Expected "<sub-experiment>/<iteration>/results.csv" or "<sub-experiment>/<iteration>/results_from_json.csv".`,
      400,
    )
  }

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '')
  const bytes = buffer.length
  if (bytes === 0) {
    throw new GitHubUploadError(`"${normalized}" is empty.`, 400)
  }
  if (bytes > MAX_UPLOAD_FILE_BYTES) {
    throw new GitHubUploadError(
      `"${normalized}" is larger than GitHub's ${Math.round(MAX_UPLOAD_FILE_BYTES / (1024 * 1024))} MiB per-file limit.`,
      413,
    )
  }

  const text = buffer.toString('utf8')
  // A results.csv is UTF-8 text: a payload whose bytes cannot be spelled as UTF-8 is refused instead of
  // being committed with replacement characters in place of its original content.
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    throw new GitHubUploadError(
      `"${normalized}" is not UTF-8 text, so it cannot be committed as a results.csv.`,
      400,
    )
  }

  const experimentFolder = shortenTrailingTimestampSegment(
    session.experimentFolder,
    session.caps.experiment,
  )
  const shortenedPath = shortenResultRelativePath(
    normalized,
    session.caps.subExperiment,
    session.caps.iteration,
  )
  const treePath = buildResultsTreePath(session.config, session.folder, experimentFolder, shortenedPath)

  // Two different archive names must never end up in one folder: their results would merge and the
  // experiment level would stop identifying the run. The digest makes a collision implausible, so
  // failing loudly is enough.
  const knownRaw = session.trimmedByExperiment.get(experimentFolder)
  if (knownRaw !== undefined && knownRaw !== session.experimentFolder) {
    throw new GitHubUploadError(
      `The experiment names "${knownRaw}" and "${session.experimentFolder}" are both too long for git and shorten to "${experimentFolder}", which would merge them into one folder. Rename one of the results sources and upload it again.`,
      400,
    )
  }
  session.trimmedByExperiment.set(experimentFolder, session.experimentFolder)

  const knownPath = session.rawByTreePath.get(treePath)
  if (knownPath !== undefined && knownPath !== normalized) {
    throw new GitHubUploadError(
      `The sub-experiment names "${knownPath}" and "${normalized}" are both too long for git and shorten to the same path "${treePath}". Rename one of them and upload it again.`,
      400,
    )
  }
  session.rawByTreePath.set(treePath, normalized)

  if (treePath.length > MAX_TREE_PATH_LENGTH) {
    throw new GitHubUploadError(
      `The upload path "${treePath}" is longer than the ${MAX_TREE_PATH_LENGTH} characters git can check out reliably. Rename the sub-experiment it belongs to and upload it again.`,
      400,
    )
  }

  for (const [level, from, to] of [
    ['experiment', session.experimentFolder, experimentFolder],
    ['path', normalized, shortenedPath],
  ]) {
    if (from === to || session.shortened.has(`${level}:${from}`)) {
      continue
    }

    session.shortened.set(`${level}:${from}`, describeTrimmedName(level, from, to))
    session.shortenedCount += 1
  }

  // Update mode: an iteration whose two files are both already in the repository is left alone, so a
  // re-run of the upload only commits what is new. `full` mode commits every file it is handed.
  if (session.mode === 'update' && session.existingPaths) {
    const slash = treePath.lastIndexOf('/')
    const fileName = treePath.slice(slash + 1)
    const iterationPath = treePath.slice(0, slash)
    if (
      RESULTS_FILE_NAMES.has(fileName) &&
      session.existingPaths.has(treePath) &&
      session.existingPaths.has(`${iterationPath}/results.csv`) &&
      session.existingPaths.has(`${iterationPath}/results_from_json.csv`)
    ) {
      session.fileCount += 1
      session.skippedCount += 1
      return { ok: true, treePath, bytes, skipped: true }
    }
  }

  // A client that resends a file after a timeout (or a replayed request) must not add the same tree path
  // twice: the previous pending entry is replaced in place, so a tree request never carries two entries
  // for one path and the byte/file counters stay exact.
  const duplicateIndex = session.pending.findIndex((entry) => entry.treePath === treePath)
  if (duplicateIndex !== -1) {
    const previous = session.pending[duplicateIndex]
    if (previous.content !== undefined) {
      session.pendingBytes -= sessionInlineEntryBytes(treePath, previous.content)
    }
    session.pending.splice(duplicateIndex, 1)
    session.fileCount -= 1
    session.totalBytes -= Number(previous.bytes) || 0
  }

  session.fileCount += 1
  session.totalBytes += bytes

  const inlineBytes = sessionInlineEntryBytes(treePath, text)
  const useBlob =
    bytes > MAX_INLINE_UPLOAD_FILE_BYTES || inlineBytes > MAX_UPLOAD_TREE_PAYLOAD_BYTES - 256

  let entry
  if (useBlob) {
    const blobResult = await githubRequest({
      ...requestOptions,
      pathname: `/repos/${repo}/git/blobs`,
      method: 'POST',
      body: { content: buffer.toString('base64'), encoding: 'base64' },
    })
    assertGitHubResponse(`create the blob for ${treePath}`, blobResult)
    const blobSha = blobResult.payload?.sha || null
    if (!blobSha) {
      throw new GitHubUploadError(`GitHub did not return a blob for ${treePath}.`, 502)
    }
    entry = { treePath, sha: blobSha, bytes }
  } else {
    entry = { treePath, content: text, bytes }
  }

  // Commit what is pending before an inline entry that would not fit alongside it, so every tree
  // request stays inside the payload budget however the files are sized.
  if (
    entry.content !== undefined &&
    session.pendingBytes + inlineBytes > MAX_UPLOAD_TREE_PAYLOAD_BYTES - 256
  ) {
    await flushUploadSession(session, request)
  }

  session.pending.push(entry)
  if (entry.content !== undefined) {
    session.pendingBytes += inlineBytes
  }

  if (
    session.pendingBytes >= UPLOAD_SESSION_FLUSH_BYTES ||
    session.pending.length >= MAX_UPLOAD_FILES
  ) {
    await flushUploadSession(session, request)
  }

  return { ok: true, treePath, bytes, skipped: false }
}

// Commits the pending files of a session as one tree (one GitHub commit), building on the current
// branch tip. Called automatically once the pending tree grows past the flush budget and once more at
// the end of the experiment, where a tree identical to the branch tip creates no commit.
async function flushUploadSession(session, request) {
  if (session.pending.length === 0) {
    return session
  }

  const { repo, branch } = session.config
  const requestOptions = { fetchImpl: request, config: session.config }

  const base = await readBranchBase(session, request)
  session.baseCommitSha = base.baseCommitSha
  session.baseTreeSha = base.baseTreeSha

  const treeBody = { tree: [] }
  for (const entry of session.pending) {
    const treeEntry = { path: entry.treePath, mode: '100644', type: 'blob' }
    if (entry.sha) {
      treeEntry.sha = entry.sha
    } else {
      treeEntry.content = entry.content
    }
    treeBody.tree.push(treeEntry)
  }
  if (session.baseTreeSha) {
    treeBody.base_tree = session.baseTreeSha
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
  session.latestTreeSha = treeSha

  // The pending files were already in the branch tip, so the tree is unchanged and no commit is made.
  if (session.baseTreeSha && treeSha === session.baseTreeSha) {
    session.pending = []
    session.pendingBytes = 0
    return session
  }


  const partSuffix = session.commitCount > 0 ? ` (part ${session.commitCount + 1})` : ''
  const commitResult = await githubRequest({
    ...requestOptions,
    pathname: `/repos/${repo}/git/commits`,
    method: 'POST',
    body: {
      message: `${buildCommitMessage(session.commitMessage, session.folder)}${partSuffix}`,
      tree: treeSha,
      parents: session.baseCommitSha ? [session.baseCommitSha] : [],
    },
  })
  assertGitHubResponse('create the upload commit', commitResult)

  const commitSha = commitResult.payload?.sha || null
  if (!commitSha) {
    throw new GitHubUploadError('GitHub did not return a commit for the upload.', 502)
  }

  if (session.baseCommitSha) {
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

  session.baseCommitSha = commitSha
  session.baseTreeSha = treeSha
  session.latestCommitSha = commitSha
  session.commitCount += 1
  session.pending = []
  session.pendingBytes = 0

  return session
}

function buildUploadSessionSummary(session) {
  const webUrl = `${buildWebBaseUrl(session.config)}/${session.config.repo}`
  const committed = Math.max(0, session.fileCount - session.skippedCount)

  return {
    ok: true,
    repo: session.config.repo,
    branch: session.config.branch,
    folder: session.folder,
    folderPath: session.folderPath,
    experimentFolders: [session.experimentFolder],
    fileCount: committed,
    skippedFileCount: session.skippedCount,
    totalBytes: session.totalBytes,
    resultsPath: session.config.resultsPath,
    // Kept short on purpose, like `uploadResults`: how many names were trimmed plus a few examples.
    trimmed: {
      count: session.shortenedCount,
      examples: [...session.shortened.values()].slice(0, 10),
    },
    uploadMode: session.mode,
    webUrl,
    unchanged: session.commitCount === 0,
    commitCount: session.commitCount,
    commitSha: session.latestCommitSha || null,
    commitUrl: session.latestCommitSha ? `${webUrl}/commit/${session.latestCommitSha}` : '',
    treeSha: session.latestTreeSha,
    batchCount: session.commitCount,
  }
}

// Commits whatever is still pending and closes the session. The summary matches the one `uploadResults`
// returns, so the dashboard folds session results together exactly as it did before.
export async function commitUploadSession({ id, fetchImpl } = {}) {
  const session = findUploadSession(id)
  const request = fetchImpl || globalThis.fetch

  try {
    // Queue the final flush behind any file post still in flight, so the commit captures everything the
    // browser sent and nothing mutates the session after it (the browser only commits once every post
    // has resolved, but this makes the ordering explicit and race-free).
    await enqueueSessionTask(session, () => flushUploadSession(session, request))
    return buildUploadSessionSummary(session)
  } finally {
    session.lastActivityAt = Date.now()
    session.activeTasks = 0
    disposeUploadSession(session)
    uploadSessions.delete(session.id)
  }
}

// Drops a session without committing it, for a sweep that failed part-way through.
export function abortUploadSession({ id } = {}) {
  const session = uploadSessions.get(String(id ?? ''))
  if (!session) {
    return false
  }

  disposeUploadSession(session)
  return uploadSessions.delete(session.id)
}
