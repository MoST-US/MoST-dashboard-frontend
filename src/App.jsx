import { useEffect, useMemo, useRef, useState } from 'react'
import { Fragment } from 'react'
import {
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  CartesianGrid,
  XAxis,
  YAxis,
  Legend,
  Tooltip,
} from 'recharts'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import { Download, FileDown, RefreshCw, RotateCcw, Terminal, Upload } from 'lucide-react'
import './App.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000'
const TUNNEL_MANAGER_URL = import.meta.env.VITE_TUNNEL_MANAGER_URL || 'http://localhost:4100'
const API_PROXY_PATH = import.meta.env.VITE_API_PROXY_PATH || ''
const API_PORTS_RAW = import.meta.env.VITE_API_PORTS || ''
const EXPERIMENT_LIST_RAW =
  import.meta.env.VITE_EXPERIMENT_LIST || import.meta.env.EXPERIMENT_LIST || ''

const STAGE_ONE_COLOR = '#1f5fff'
const STAGE_TWO_COLOR = '#f68026'
// Additive (mix) matrix cells: red marking for the profile cells the selected mix uses.
const ADDITIVE_MIX_CELL_COLOR = '#ffc2c2'
const NODE_HIT_RADIUS_PX = 24
const TOOLTIP_OFFSET_PX = 12
const TOOLTIP_MARGIN_PX = 8
const TOOLTIP_FALLBACK_WIDTH_PX = 240
const TOOLTIP_FALLBACK_HEIGHT_PX = 132

const REQ_MIN_KEYS = [
  'REQ_MIN',
  'req_min',
  'Requests sent per minute',
  'requests_sent_per_minute',
  'requests_per_minute',
  'RPM',
  'rpm',
]

const EVALUATION_KEYS = ['EVALUATION', 'Evaluation', 'evaluation', 'evaluated', 'is_eval_true']
const DATE_KEYS = ['Date', 'date', 'Timestamp', 'timestamp', 'created_at']
const SUCCESS_KEYS = [
  'SUCCESS_RATE',
  'Success rate',
  'success_rate',
  'successRate',
  'pass_rate',
]
const STAGE_KEYS = ['STAGE', 'Stage', 'stage', 'Pipeline stage', 'pipeline_stage']
const FINISHED_KEYS = ['FINISHED', 'Finished', 'finished', 'IS_FINISHED', 'is_finished']
const LARGEST_TRUE_KEYS = [
  'LARGEST_TRUE',
  'Largest true',
  'largest_true',
  'largestTrue',
  'CURRENT_LARGEST_TRUE',
]
const EXPERIMENT_TYPE_KEYS = [
  'EXPERIMENT_TYPE',
  'Experiment type',
  'experiment_type',
  'experimentType',
]
const DEFAULT_RESULTS_SCOPE = 'current'
const DEFAULT_EXPERIMENT_TYPE = 'MST'
const WORKLOAD_PROFILE_COLORS = [
  '#1f5fff',
  '#f68026',
  '#0b9254',
  '#a855f7',
  '#d92d20',
  '#0891b2',
  '#ca8a04',
  '#db2777',
]

function parsePortToken(token) {
  const numeric = Number(String(token || '').trim())
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null
  }

  return numeric
}

function buildConfiguredApiPorts(rawPorts, fallbackApiBaseUrl) {
  const fromEnv = rawPorts
    .split(',')
    .map((item) => parsePortToken(item))
    .filter(Boolean)

  if (fromEnv.length > 0) {
    return [...new Set(fromEnv)]
  }

  try {
    const fallbackPort = parsePortToken(new URL(fallbackApiBaseUrl).port || '4000')
    if (fallbackPort !== null) {
      return [fallbackPort]
    }
  } catch {
    // Keep default list when URL parsing fails.
  }

  return [4000]
}

const CONFIGURED_API_PORTS = buildConfiguredApiPorts(API_PORTS_RAW, API_BASE_URL)

function getFieldValue(row, keys) {
  if (!row) {
    return null
  }

  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim()
    }
  }

  return null
}

function parseNumber(value) {
  if (value === null || value === undefined) {
    return null
  }

  const cleaned = String(value).replace('%', '').replace(',', '.').trim()
  const numeric = Number(cleaned)
  return Number.isFinite(numeric) ? numeric : null
}

function parseBoolean(value) {
  if (value === null || value === undefined) {
    return false
  }

  const normalized = String(value).trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'pass'
}

function parseCsv(text) {
    const rows = []
    let row = []
    let value = ''
    let quoted = false

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index]
      const next = text[index + 1]

      if (character === '"' && quoted && next === '"') {
        value += '"'
        index += 1
      } else if (character === '"') {
        quoted = !quoted
      } else if (character === ',' && !quoted) {
        row.push(value)
        value = ''
      } else if ((character === '\n' || character === '\r') && !quoted) {
        if (character === '\r' && next === '\n') {
          index += 1
        }
        row.push(value)
        if (row.some((cell) => cell !== '')) {
          rows.push(row)
        }
        row = []
        value = ''
      } else {
        value += character
      }
    }

    if (value || row.length > 0) {
      row.push(value)
      if (row.some((cell) => cell !== '')) {
        rows.push(row)
      }
    }

    if (rows.length < 2) {
      return []
    }

    const headers = rows[0]
    return rows.slice(1).map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])),
    )
}

const REQUEST_START_KEYS = [
  'request_sent_at_utc',
  'request_start_time',
  'request_started_at',
  'start_time',
  'started_at',
]
const REQUEST_END_KEYS = [
  'full_response_received_at_utc',
  'request_end_time',
  'request_finished_at',
  'end_time',
  'finished_at',
  'completed_at',
]
const REQUEST_RECEIVED_KEYS = ['received_timestamp', 'received_at', 'response_received_at']
const REQUEST_DURATION_KEYS = ['request_duration_ms', 'complete_response_time', 'duration_ms']
const WORKLOAD_PROFILE_KEYS = ['workload_profile', 'profile', 'workloadProfile']

function parseRequestTimestamp(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null
  }

  const text = String(value).trim()
  const numeric = Number(text)
  if (Number.isFinite(numeric)) {
    const absolute = Math.abs(numeric)
    const milliseconds =
      absolute >= 1e17
        ? numeric / 1e6
        : absolute >= 1e14
          ? numeric / 1e3
          : absolute < 1e11
            ? numeric * 1e3
            : numeric
    return Number.isFinite(milliseconds) ? milliseconds : null
  }

  const compactTimestamp = text.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/,
  )
  if (compactTimestamp) {
    const [, year, month, day, hour, minute, second, fraction = ''] = compactTimestamp
    const milliseconds = Number(`0.${fraction}`) * 1000
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      milliseconds,
    )
  }

  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function buildRequestTimeline(rows) {
  const events = []
  const profiles = new Set()
  let origin = null

  rows.forEach((row) => {
    let start = parseRequestTimestamp(getFieldValue(row, REQUEST_START_KEYS))
    let end = parseRequestTimestamp(getFieldValue(row, REQUEST_END_KEYS))

    // Older results_from_json.csv files contain the completion timestamp and
    // total response time instead of explicit request start/end timestamps.
    if (start === null || end === null) {
      const received = parseRequestTimestamp(getFieldValue(row, REQUEST_RECEIVED_KEYS))
      const duration = parseNumber(getFieldValue(row, REQUEST_DURATION_KEYS))
      if (received !== null && duration !== null && duration >= 0) {
        start = received - duration
        end = received
      }
    }

    if (start === null || end === null || end < start) {
      return
    }

    const profile = getFieldValue(row, WORKLOAD_PROFILE_KEYS) || 'Unknown profile'
    profiles.add(profile)
    origin = origin === null ? start : Math.min(origin, start)
    events.push({ timestamp: start, profile, delta: 1, order: 1 })
    events.push({ timestamp: end, profile, delta: -1, order: 0 })
  })

  if (events.length === 0 || origin === null) {
    return { data: [], profiles: [] }
  }

  events.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order)
  const counts = Object.fromEntries([...profiles].map((profile) => [profile, 0]))
  const cumulativeCounts = Object.fromEntries([...profiles].map((profile) => [profile, 0]))
  const data = [{
    time: 0,
    total: 0,
    cumulative: { ...cumulativeCounts },
    displayTime: new Date(origin).toISOString(),
  }]

  let index = 0
  while (index < events.length) {
    const timestamp = events[index].timestamp
    while (index < events.length && events[index].timestamp === timestamp) {
      const event = events[index]
      counts[event.profile] += event.delta
      if (event.delta > 0) {
        cumulativeCounts[event.profile] += event.delta
      }
      index += 1
    }

    data.push({
      time: (timestamp - origin) / 1000,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      cumulative: { ...cumulativeCounts },
      displayTime: new Date(timestamp).toISOString(),
      ...counts,
    })
  }

  return {
    data,
    profiles: [...profiles].sort((a, b) => a.localeCompare(b)),
  }
}

function sortIterationsChronologically(iterations) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...iterations].sort((a, b) => collator.compare(a, b))
}

function detectStage(iteration, row) {
  const stageFromRow = getFieldValue(row, STAGE_KEYS)

  if (stageFromRow) {
    if (/(^|\s|_)1($|\s|_)/i.test(stageFromRow) || /stage\s*1/i.test(stageFromRow)) {
      return 1
    }
    if (/(^|\s|_)2($|\s|_)/i.test(stageFromRow) || /stage\s*2/i.test(stageFromRow)) {
      return 2
    }
  }

  if (/stage[_\s-]*1|(^|[_\s-])s1([_\s-]|$)/i.test(iteration)) {
    return 1
  }
  if (/stage[_\s-]*2|(^|[_\s-])s2([_\s-]|$)/i.test(iteration)) {
    return 2
  }

  return 1
}

function formatSuccessRate(value) {
  const numeric = parseNumber(value)
  if (numeric === null) {
    return value || 'Unknown'
  }

  return `${numeric}%`
}

function extractModelUrl(gpuResponse) {
  const candidates = [
    gpuResponse?.url,
    gpuResponse?.URL,
    gpuResponse?.modelUrl,
    gpuResponse?.model_url,
    gpuResponse?.endpoint,
    gpuResponse?.gpuUsed,
  ]

  const found = candidates.find((value) => value !== undefined && value !== null && String(value).trim() !== '')
  return found ? String(found).trim() : 'Unavailable'
}

function extractGpuUsed(gpuResponse) {
  const candidates = [
    gpuResponse?.gpuUsed,
    gpuResponse?.gpu,
    gpuResponse?.device,
    gpuResponse?.name,
  ]

  const found = candidates.find((value) => value !== undefined && value !== null && String(value).trim() !== '')
  return found ? String(found).trim() : 'Unavailable'
}

function extractModelName(llmResponse) {
  const candidates = [
    llmResponse?.llmName,
    llmResponse?.modelName,
    llmResponse?.model,
    llmResponse?.name,
  ]

  const found = candidates.find((value) => value !== undefined && value !== null && String(value).trim() !== '')
  return found ? String(found).trim() : 'Unknown model'
}

const MODEL_USED_KEYS = ['MODEL_USED', 'Model used', 'model_used', 'MODEL', 'model']
const MODEL_URL_KEYS = ['URL', 'url', 'Url', 'endpoint', 'model_url']
const GPU_COUNT_KEYS = ['GPU_COUNT', 'GPU count', 'gpu_count', 'GPUS', 'gpus', 'num_gpus']
// Only the columns an upload folder is built from. `?fields=` keeps the fallback payload tiny, and a
// legacy results.csv without one of them simply answers with rows that do not carry that key.
const UPLOAD_IDENTITY_FIELDS = 'MODEL_USED,URL,GPU_COUNT'

function parseEndpointFromUrl(rawUrl) {
  const cleaned = String(rawUrl || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
  if (!cleaned) {
    return null
  }

  let candidate = cleaned
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `http://${candidate}`
  }

  try {
    const parsed = new URL(candidate)
    const hostname = parsed.hostname
    if (!hostname) {
      return null
    }

    const rawPort = parsed.port ? Number(parsed.port) : null
    if (rawPort === null || !Number.isInteger(rawPort) || rawPort <= 0) {
      return null
    }

    const isIpAddress = /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
    const node = isIpAddress ? hostname : hostname.split('.')[0]

    return { node, port: rawPort }
  } catch {
    return null
  }
}

function formatGpuCount(value) {
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'string' && value.trim()) {
    return value
  }
  return 'Unavailable'
}

function buildApiBaseUrlForPort(port) {
  if (API_PROXY_PATH) {
    const proxyPath = API_PROXY_PATH.replace(/\/$/, '')
    return `${window.location.origin}${proxyPath}/${port}`
  }

  try {
    const url = new URL(API_BASE_URL)
    url.port = String(port)
    return url.toString().replace(/\/$/, '')
  } catch {
    return `http://localhost:${port}`
  }
}

function buildApiUrl(pathname, port, queryParams = {}) {
  const baseUrl = buildApiBaseUrlForPort(port)
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  const url = new URL(normalizedPath, `${baseUrl}/`)

  Object.entries(queryParams).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return
    }
    url.searchParams.set(key, String(value))
  })

  return url.toString()
}

function buildTunnelUrl(pathname) {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  const baseUrl = TUNNEL_MANAGER_URL.replace(/\/$/, '')

  if (baseUrl.startsWith('/')) {
    return `${window.location.origin}${baseUrl}${normalizedPath}`
  }

  return `${baseUrl}${normalizedPath}`
}

// Deadlines that keep one stalled hop (an SSH tunnel hiccup, a hung GitHub call, an API that never
// answers) from freezing the whole sweep: without them a single pending `await` leaves the upload bar
// stuck at its last percentage and the busy state uncleared forever. Finite per request, and generous
// for the long steps (a batch conversion, a big experiment's commit).
const UPLOAD_REQUEST_TIMEOUT_MS = 120000
const UPLOAD_LONG_REQUEST_TIMEOUT_MS = 600000

// How many result files the browser streams at once. A sweep used to move one file at a time, which
// left the SSH-tunnel download hop idle between every file and made a many-file upload latency bound.
// A small pool keeps a little download parallelism without overwhelming the tunnel manager. Session
// bookkeeping and GitHub tree updates are serialized server-side, so a large browser-side pool only
// increases queued request bodies and memory pressure. Override with
// VITE_UPLOAD_FILE_CONCURRENCY if a link tolerates more.
const UPLOAD_FILE_CONCURRENCY = (() => {
  const configured = Number(import.meta.env.VITE_UPLOAD_FILE_CONCURRENCY)
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 8) : 2
})()

// Derived result preparation can start a Python conversion on the API host. Keep this lower than
// the file-transfer pool so a port-wide upload cannot start one conversion for every matrix cell.
const UPLOAD_PREPARATION_CONCURRENCY = 2
const UPLOAD_PROGRESS_UPDATE_INTERVAL_MS = 400

// `fetch` with an AbortController deadline. Every upload-related request goes through it so a hop that
// never answers surfaces as a retryable timeout instead of an unending wait.
async function fetchWithTimeout(url, options = {}, timeoutMs = UPLOAD_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutError = new Error(
        `The request timed out after ${Math.round(timeoutMs / 1000)}s: the tunnel or the server did not answer.`,
      )
      timeoutError.name = 'UploadTimeoutError'
      timeoutError.code = 'UPLOAD_TIMEOUT'
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// An HTTP failure that carries its status code, so the retryer can tell a transient 5xx from a 4xx that
// is a real answer (expired session, missing file) and must be surfaced immediately.
function uploadHttpError(message, status) {
  const error = new Error(message)
  error.status = Number(status)
  return error
}

function isRetryableUploadError(error) {
  if (!error) {
    return false
  }
  if (error.code === 'UPLOAD_TIMEOUT') {
    return true
  }
  const status = Number(error.status)
  return Number.isInteger(status) && status >= 500
}

// Retries a request a few times with linear backoff. Only transient failures (a timeout or a 5xx) are
// retried; a 4xx is returned at once, so a real client error is never hidden behind repeated attempts.
async function withUploadRetry(run, { attempts = 3, baseDelayMs = 750 } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run(attempt)
    } catch (error) {
      lastError = error
      if (!isRetryableUploadError(error) || attempt === attempts) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt))
    }
  }
  throw lastError
}

// Runs `worker` over `items` with at most `limit` in flight. Starts tasks from a shared cursor so slow
// items do not block the queue, and drains every in-flight task even after the first failure: the
// remaining started tasks finish, no new one starts, and the first error is rethrown. Draining (rather
// than rejecting immediately, as `Promise.all` would) matters here because a half-open upload session
// must see every posted file settle before the caller aborts it, and it keeps a late rejection from
// surfacing as an unhandled promise.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let nextIndex = 0
  let firstError = null
  const workers = Math.max(1, Math.min(limit, items.length))

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (firstError === null) {
        const index = nextIndex
        nextIndex += 1
        if (index >= items.length) {
          return
        }

        try {
          results[index] = await worker(items[index], index)
        } catch (error) {
          firstError = error
        }
      }
    }),
  )

  if (firstError) {
    throw firstError
  }

  return results
}

function parseExperimentPair(experimentName) {
  if (!experimentName) {
    return null
  }

  const separator = experimentName.includes('_') ? '_' : experimentName.includes(':') ? ':' : null
  if (!separator) {
    return null
  }

  const [inputRange, outputRange] = experimentName.split(separator)
  if (!inputRange || !outputRange) {
    return null
  }

  return {
    inputRange,
    outputRange,
  }
}

function intervalStart(interval) {
  if (!interval) {
    return Number.MAX_SAFE_INTEGER
  }

  const [startToken] = interval.split('-')
  const numeric = Number(startToken)
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER
}

function formatIntervalLabel(interval) {
  if (!interval) {
    return ''
  }

  const [start, end] = interval.split('-')

  // Treat the configured max sentinel as an open-ended interval, e.g. "4000+".
  if (end === '10000000') {
    return `${start}+`
  }

  return `${start}-${end}`
}

// `VITE_EXPERIMENT_LIST` mirrors the environment `TOKENS_LIST`: a comma-separated list of
// `inputRange:outputRange` pairs covering every combination a run may produce.
function parseConfiguredPairs(rawList) {
  if (!rawList) {
    return []
  }

  return rawList
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parseExperimentPair(item))
    .filter(Boolean)
}

function buildConfiguredExperimentList(rawList) {
  const normalized = parseConfiguredPairs(rawList).map(
    (pair) => `${pair.inputRange}_${pair.outputRange}`,
  )

  return [...new Set(normalized)]
}

// The additive matrix renders every configured combination, so its axes come from the same list and
// not from the mixes present in the results source. The profile intervals of a mix are decoded from
// its canonical label, so they use these exact tokens and land in the right cells.
function buildConfiguredMatrixAxes(rawList) {
  const pairs = parseConfiguredPairs(rawList)
  const rangesFor = (key) =>
    [...new Set(pairs.map((pair) => pair[key]))].sort((a, b) => intervalStart(a) - intervalStart(b))

  return {
    inputRanges: rangesFor('inputRange'),
    outputRanges: rangesFor('outputRange'),
  }
}

// The axes are build-time constants, so they are derived once instead of on every mix selection.
const CONFIGURED_MATRIX_AXES = buildConfiguredMatrixAxes(EXPERIMENT_LIST_RAW)

function formatExperimentLabel(experimentName) {
  if (!experimentName) {
    return 'No experiment selected'
  }

  return experimentName.replace('_', '/')
}

function formatExperimentType(value) {
  const normalized = value === null || value === undefined ? '' : String(value).trim()
  return normalized || DEFAULT_EXPERIMENT_TYPE
}

// Additive experiments (WORKLOAD_MIXES runs) store one folder per `mix_...` sub-experiment
// instead of one folder per input/output interval pair. The API mirrors that prefix, so the
// dashboard uses it to tell both layouts apart when deciding what to render.
const ADDITIVE_EXPERIMENT_PREFIX = 'mix_'

function isAdditiveExperimentName(experimentName) {
  return String(experimentName || '').trim().toLowerCase().startsWith(ADDITIVE_EXPERIMENT_PREFIX)
}

// The canonical mix (for example `[(1-100:1-100,0.5),(300-600:100-300,0.5)]`) is what the
// additivity of a sub-experiment is described by; fall back to the raw folder name when absent.
function formatAdditiveLabel(additive) {
  if (!additive) {
    return ''
  }

  const canonical = typeof additive.canonical === 'string' ? additive.canonical.trim() : ''
  return canonical || additive.name || ''
}

// Alphas arrive already normalised (they add up to 1) and the environment renders them compactly
// (`0.5`, `0.333333`, `1`), so the matrix cells use the same formatting.
const ADDITIVE_ALPHA_DECIMALS = 6

function formatAdditiveAlpha(alpha) {
  if (!Number.isFinite(alpha)) {
    return ''
  }

  const text = Number(alpha)
    .toFixed(ADDITIVE_ALPHA_DECIMALS)
    .replace(/0+$/, '')
    .replace(/\.$/, '')

  return text || '0'
}

// The comparison metrics reuse the matrix cell precision (two decimals); missing inputs render as
// `n/a`, the same token the matrix uses for a cell whose sigma cannot be derived.
function formatComparisonValue(value) {
  if (!Number.isFinite(value)) {
    return 'n/a'
  }

  return String(Math.round(value * 100) / 100)
}

// The distance is a relative error, so it is shown as a signed percentage; the raw ratio stays in
// the tooltip of the metric.
function formatDistanceValue(value) {
  if (!Number.isFinite(value)) {
    return 'n/a'
  }

  const percentage = value * 100
  return `${percentage > 0 ? '+' : ''}${percentage.toFixed(2)}%`
}

// `Experiment_<TYPE>_<timestamp>` names a MIT/MST archive while `Experiment_MIX_<TYPE>_<timestamp>`
// names an additive one, so the type is the token right after `Experiment_`: an additive results
// source therefore reports `MIX` and never matches the MIT/MST sources its mixes are compared with.
function readExperimentTypeFromScope(scope) {
  const match = /^Experiment_([A-Za-z0-9]+)(?:_|$)/i.exec(String(scope || '').trim())
  return match ? match[1].toUpperCase() : ''
}

// JSON `null` and CSV empty cells count as missing, unlike `Number(null) === 0`, so profiles that
// only carry a partial interval are ignored instead of producing a bogus `0-...` axis entry.
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return Number.NaN
  }

  return Number(value)
}

// A mix profile is a token interval pair plus the probability (`alpha`) it is drawn with, for
// example `1-100:1-100,0.5`. Both intervals use the same `min-max` shape as the matrix axes.
function additiveProfileIntervals(profile) {
  const values = [profile?.inMin, profile?.inMax, profile?.outMin, profile?.outMax].map(toFiniteNumber)

  if (!values.every((value) => Number.isFinite(value))) {
    return null
  }

  const [inMin, inMax, outMin, outMax] = values
  return {
    inputRange: `${inMin}-${inMax}`,
    outputRange: `${outMin}-${outMax}`,
  }
}

// `/api/experiments` describes every `mix_...` folder with its profiles; the latest `results.csv`
// of the experiment carries the same profiles, so it is only used as a fallback.
function resolveAdditiveProfiles(entry, status) {
  if (Array.isArray(entry?.profiles) && entry.profiles.length > 0) {
    return entry.profiles
  }

  return Array.isArray(status?.additive?.profiles) ? status.additive.profiles : []
}

// Adds up the alphas a mix puts in the same cell, mirroring the normalisation the environment
// applies to repeated profiles of one mix.
function accumulateAdditiveCellAlpha(cellMap, pairKey, mixName, alpha) {
  const cells = cellMap[pairKey] || []
  const existing = cells.find((cell) => cell.mixName === mixName)
  if (existing) {
    existing.alpha += alpha
    return
  }

  cellMap[pairKey] = [...cells, { mixName, alpha }]
}

// Builds the additive matrix. The axes start from the configured combinations (the same ones the
// interval matrix of a non-additive results source draws) and additionally collect every profile
// interval the mixes actually use, so a mix never loses a cell and selecting another mix only
// changes the highlighting. `cellMap` records which mix uses a cell and with which alpha.
function buildAdditiveMatrixModel(additiveExperiments, experimentStatuses, configuredAxes) {
  const inputRanges = new Set(configuredAxes?.inputRanges || [])
  const outputRanges = new Set(configuredAxes?.outputRanges || [])
  const cellMap = {}

  additiveExperiments.forEach((entry) => {
    const profiles = resolveAdditiveProfiles(entry, experimentStatuses?.[entry.name])

    profiles.forEach((profile) => {
      const intervals = additiveProfileIntervals(profile)
      const alpha = toFiniteNumber(profile?.alpha)
      if (!intervals || !(alpha > 0)) {
        return
      }

      inputRanges.add(intervals.inputRange)
      outputRanges.add(intervals.outputRange)
      accumulateAdditiveCellAlpha(
        cellMap,
        `${intervals.inputRange}__${intervals.outputRange}`,
        entry.name,
        alpha,
      )
    })
  })

  const compareByIntervalStart = (a, b) => intervalStart(a) - intervalStart(b)

  return {
    inputRanges: [...inputRanges].sort(compareByIntervalStart),
    outputRanges: [...outputRanges].sort(compareByIntervalStart),
    cellMap,
  }
}

// A comparison experiment folder and a mix profile may spell the same interval differently (`100`,
// `100-100`, `100.0-100.0`), so both sides are normalized to `start-end` with plain numbers before a
// profile is matched to the folder that measured it.
function normalizeIntervalText(interval) {
  const text = String(interval === null || interval === undefined ? '' : interval).trim()
  if (!text) {
    return ''
  }

  const [startToken, endToken = text] = text.split('-')
  const start = Number(startToken)
  const end = Number(endToken)
  if (!startToken || !endToken || !Number.isFinite(start) || !Number.isFinite(end)) {
    return text
  }

  return `${start}-${end}`
}

// Folder-name lookup of a MIT/MST results source, keyed like the additive matrix cells
// (`inputRange__outputRange`), so every profile of a mix finds the experiment that measured it.
function buildComparisonPairMap(experimentNames) {
  const names = experimentNames || []
  const pairMap = {}

  names.forEach((experimentName) => {
    const parsed = parseExperimentPair(experimentName)
    if (!parsed) {
      return
    }

    const pairKey = `${normalizeIntervalText(parsed.inputRange)}__${normalizeIntervalText(parsed.outputRange)}`
    pairMap[pairKey] = experimentName
  })

  return pairMap
}

// Reference value of a MIT/MST results source: the largest MIT/MST value (`LARGEST_TRUE`) found in
// its cells, finished or not. It plays the role of the fastest profile, which carries 1.0 CU.
function resolveComparisonSigma(experimentStatuses) {
  const values = Object.values(experimentStatuses || {})
    .map((status) => toFiniteNumber(status?.largestTrue))
    .filter((value) => Number.isFinite(value) && value > 0)

  return values.length > 0 ? Math.max(...values) : null
}

// Compares one additive mix with a MIT/MST results source using the additivity model:
//   sigma(p) = Sigma / MST(p)          MST(p) is the MIT/MST value of the cell of profile p
//   expected_sigma = sum(alpha(p) * sigma(p))
//   expected_throughput = Sigma / expected_sigma
//   true_sigma = Sigma / true_throughput
//   distance = (true_throughput - expected_throughput) / expected_throughput
// A mix whose profiles are not all present in the comparison source publishes no expected values
// (`complete: false`) instead of a partial sum.
function buildMixComparison({ profiles, trueValue, pairMap, comparisonStatuses, scopeSigma }) {
  const profileList = profiles || []
  const missingProfiles = []
  const hasSigma = Number.isFinite(scopeSigma) && scopeSigma > 0
  let expectedSigma = 0
  let usableProfiles = 0

  profileList.forEach((profile) => {
    const intervals = additiveProfileIntervals(profile)
    const alpha = toFiniteNumber(profile?.alpha)
    if (!intervals || !(alpha > 0)) {
      return
    }

    const pairKey = `${normalizeIntervalText(intervals.inputRange)}__${normalizeIntervalText(intervals.outputRange)}`
    const experiment = pairMap ? pairMap[pairKey] : null
    const value = toFiniteNumber(
      comparisonStatuses ? comparisonStatuses[experiment]?.largestTrue : null,
    )

    if (!hasSigma || !Number.isFinite(value) || value <= 0) {
      missingProfiles.push(profile?.label || `${intervals.inputRange}:${intervals.outputRange}`)
      return
    }

    expectedSigma += alpha * (scopeSigma / value)
    usableProfiles += 1
  })

  const trueThroughput = toFiniteNumber(trueValue)
  const hasTrueThroughput = Number.isFinite(trueThroughput) && trueThroughput > 0
  const complete = usableProfiles > 0 && missingProfiles.length === 0
  const expectedThroughput = complete && expectedSigma > 0 ? scopeSigma / expectedSigma : null
  const trueSigma = hasSigma && hasTrueThroughput ? scopeSigma / trueThroughput : null
  const distance =
    Number.isFinite(expectedThroughput) && expectedThroughput !== 0 && hasTrueThroughput
      ? (trueThroughput - expectedThroughput) / expectedThroughput
      : null

  return {
    hasSigma,
    scopeSigma: hasSigma ? scopeSigma : null,
    complete,
    expectedSigma: complete && expectedSigma > 0 ? expectedSigma : null,
    expectedThroughput: Number.isFinite(expectedThroughput) ? expectedThroughput : null,
    trueThroughput: hasTrueThroughput ? trueThroughput : null,
    trueSigma,
    distance,
    missingProfiles,
  }
}

function formatResultsScopeLabel(scope) {
  if (!scope || scope === DEFAULT_RESULTS_SCOPE) {
    return 'Current results'
  }

  return scope
}

function groupUploadExperiments(experiments) {
  const groups = new Map()

  for (const entry of experiments || []) {
    const scope = entry.resultsScope || DEFAULT_RESULTS_SCOPE
    if (!groups.has(scope)) {
      groups.set(scope, [])
    }
    groups.get(scope).push(entry)
  }

  return [...groups.entries()].map(([resultsScope, entries]) => ({
    resultsScope,
    entries,
  }))
}

// Labels the commit of an upload that covers a whole set of results sources at once: the archive name
// when there is exactly one (`Experiment_MIT_2026-09-29_10-00-00`), otherwise how many archives the
// commit merges. The live `current` source is never part of such a set (see
// collectFinishedExperimentsFromCompletedSources).
function formatUploadScopesLabel(resultsScopes) {
  const labels = [...new Set((resultsScopes || []).filter(Boolean).map(formatResultsScopeLabel))]
  if (labels.length === 0) {
    return ''
  }

  if (labels.length === 1) {
    return labels[0]
  }

  return `${labels.length} results sources`
}

// Shown when an upload is attempted while the panel views the still-running `current` results folder.
// That folder has no archive name yet, so it cannot name the experiment level of the repository folder
// the upload creates (see buildUploadExperimentFolder); the server refuses such an upload as well.
const CURRENT_SCOPE_UPLOAD_MESSAGE =
  'The ongoing "current" results source has no experiment name yet, so its sub-experiments cannot be uploaded. Upload the Experiment_* archive the run becomes once it ends.'

// The experiment level of an upload folder is the results source the files were read from, i.e. the
// archive folder of a finished run (`Experiment_<TYPE>_<timestamp>` /
// `Experiment_MIX_<TYPE>_<timestamp>`, for example `Experiment_MIT_2026-09-29_10-00-00`). The live
// `current` folder has no archive name yet, so it returns null, which is what blocks its upload.
function buildUploadExperimentFolder(resultsScope) {
  const normalized = String(resultsScope || '').trim()
  if (!normalized || normalized === DEFAULT_RESULTS_SCOPE) {
    return null
  }

  return normalized
}

// Tooltip of the matrix upload button, which covers a whole panel: every cell of the interval matrix,
// or every `mix_...` sub-experiment of an additive source. `scopeUploadable` is false while the panel
// shows the `current` results folder, which cannot name the experiment level of the upload.
function buildMatrixUploadTitle(configured, isAdditiveMode, message, scopeUploadable = true) {
  if (!configured) {
    return message || 'GitHub uploads are not configured.'
  }

  if (!scopeUploadable) {
    return CURRENT_SCOPE_UPLOAD_MESSAGE
  }

  return isAdditiveMode
    ? 'Upload every finished mix of this additive source to GitHub'
    : 'Upload every finished cell of this matrix to GitHub'
}

// Screen-reader label of the matrix upload button, mirroring its tooltip: the reason when the panel
// shows the upload-blocking `current` source, otherwise what the button covers.
function buildMatrixUploadAriaLabel(isAdditiveMode, scopeUploadable) {
  if (!scopeUploadable) {
    return CURRENT_SCOPE_UPLOAD_MESSAGE
  }

  return isAdditiveMode
    ? 'Upload every finished mix of this additive source to GitHub'
    : 'Upload every finished cell of this matrix to GitHub'
}

// The matrix/additive downloads cover a whole results source, so they are named after its archive
// folder (`Experiment_<TYPE>_<timestamp>` / `Experiment_MIX_<TYPE>_<timestamp>`, for example
// `Experiment_MIT_2026-09-29_10-00-00`). The live `current` results folder holds no archive name,
// so it keeps the generic `matrix` prefix; characters a filesystem may reject are replaced anyway,
// since the value is only ever used as a download name.
function buildResultsDownloadBaseName(scope) {
  const normalized = String(scope || '').trim()
  if (!normalized || normalized === DEFAULT_RESULTS_SCOPE) {
    return 'matrix'
  }

  return normalized.replace(/[\\/:*?"<>|]/g, '-')
}

function getHeatmapColor(value, min, max) {
  if (!Number.isFinite(value)) {
    return '#ffffff'
  }

  const t = max > min ? (value - min) / (max - min) : 1
  const clamped = Math.min(Math.max(t, 0), 1)

  const start = { r: 239, g: 239, b: 197 }
  const end = { r: 24, g: 48, b: 132 }

  const r = Math.round(start.r + (end.r - start.r) * clamped)
  const g = Math.round(start.g + (end.g - start.g) * clamped)
  const b = Math.round(start.b + (end.b - start.b) * clamped)

  return `rgb(${r}, ${g}, ${b})`
}

function getTextColorForBackground(bg) {
  if (!bg || typeof bg !== 'string') return '#000000'

  let r = 255, g = 255, b = 255

  try {
    if (bg.startsWith('rgb')) {
      const nums = bg.match(/\d+/g)
      if (nums && nums.length >= 3) {
        r = Number(nums[0]); g = Number(nums[1]); b = Number(nums[2])
      }
    } else if (bg.startsWith('#')) {
      const hex = bg.slice(1)
      if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16)
        g = parseInt(hex[1] + hex[1], 16)
        b = parseInt(hex[2] + hex[2], 16)
      } else if (hex.length === 6) {
        r = parseInt(hex.slice(0, 2), 16)
        g = parseInt(hex.slice(2, 4), 16)
        b = parseInt(hex.slice(4, 6), 16)
      }
    } else if (bg.startsWith('rgba')) {
      const nums = bg.match(/\d+(?:\.\d+)?/g)
      if (nums && nums.length >= 3) {
        r = Number(nums[0]); g = Number(nums[1]); b = Number(nums[2])
      }
    }
  } catch {
    return '#000000'
  }

  const sr = r / 255
  const sg = g / 255
  const sb = b / 255

  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const R = lin(sr)
  const G = lin(sg)
  const B = lin(sb)

  const L = 0.2126 * R + 0.7152 * G + 0.0722 * B

  const contrastWithBlack = (L + 0.05) / 0.33
  const contrastWithWhite = 1.05 / (L + 0.05)

  return contrastWithWhite >= contrastWithBlack ? '#ffffff' : '#000000'
}

// Reads a JSON endpoint. A deadline keeps a stalled hop (a tunnel hiccup, a server that never answers)
// from pinning a poller or a panel load forever; on timeout the promise rejects with a clear error, which
// the callers already turn into an `Unavailable`/`offline` state.
const FETCH_JSON_TIMEOUT_MS = 20000

async function fetchJson(pathname, port, queryParams = {}, timeoutMs = FETCH_JSON_TIMEOUT_MS) {
  const response = await fetchWithTimeout(buildApiUrl(pathname, port, queryParams), {}, timeoutMs)
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${pathname}`)
  }
  return response.json()
}

async function fetchExperimentIterations(experimentName, port, resultsScope) {
  const response = await fetch(
    buildApiUrl(
      `/api/experiments/${encodeURIComponent(experimentName)}/iterations`,
      port,
      { resultsScope },
    ),
  )

  if (!response.ok) {
    return []
  }

  const data = await response.json()
  return sortIterationsChronologically(data.iterations || [])
}

function buildEmptyExperimentStatus() {
  return {
    hasResults: false,
    finished: false,
    largestTrue: null,
    experimentType: null,
    additive: null,
  }
}

// Shared by the interval matrix and the additive sub-experiment list: both need the latest
// `results.csv` summary of an experiment. `additive` carries the API descriptor for `mix_...`
// experiments and stays null for interval-pair experiments.
async function fetchExperimentStatus(experiment, port, resultsScope) {
  try {
    const iterations = await fetchExperimentIterations(experiment, port, resultsScope)
    if (iterations.length === 0) {
      return buildEmptyExperimentStatus()
    }

    const latestIteration = iterations[iterations.length - 1]
    const csv = await fetchJson(
      `/api/experiments/${encodeURIComponent(experiment)}/iterations/${encodeURIComponent(latestIteration)}/results.csv`,
      port,
      { resultsScope },
    )

    const rows = csv.rows || []
    const latestRow = rows.length > 0 ? rows[rows.length - 1] : null
    if (!latestRow) {
      return buildEmptyExperimentStatus()
    }

    return {
      hasResults: true,
      finished: parseBoolean(getFieldValue(latestRow, FINISHED_KEYS)),
      largestTrue: parseNumber(getFieldValue(latestRow, LARGEST_TRUE_KEYS)),
      experimentType: formatExperimentType(getFieldValue(latestRow, EXPERIMENT_TYPE_KEYS)),
      additive: csv.additive && csv.additive.isAdditive ? csv.additive : null,
    }
  } catch {
    return buildEmptyExperimentStatus()
  }
}

async function fetchExperimentStatusForPort(port) {
  try {
    const data = await fetchJson('/api/experiment-status', port)
    return {
      isRunning: data.isRunning ?? null,
      slurmJobId: data.slurmJobId || null,
      logFile: data.logFile || null,
      logAvailable: Boolean(data.logAvailable),
    }
  } catch {
    return {
      isRunning: null,
      slurmJobId: null,
      logFile: null,
      logAvailable: false,
    }
  }
}

async function resolveModelEndpointForPort(port, resultsScope, envModelUrl) {
  const fromEnv = parseEndpointFromUrl(envModelUrl)
  if (fromEnv) {
    return { node: fromEnv.node, port: fromEnv.port, model: null }
  }

  try {
    const current = await fetchJson('/api/current-experiment', port, { resultsScope })
    const experiment = current?.experiment
    const iteration = current?.iteration
    if (!experiment || !iteration) {
      return null
    }

    const csv = await fetchJson(
      `/api/experiments/${encodeURIComponent(experiment)}/iterations/${encodeURIComponent(iteration)}/results.csv`,
      port,
      { resultsScope },
    )

    for (const row of csv.rows || []) {
      const endpoint = parseEndpointFromUrl(getFieldValue(row, MODEL_URL_KEYS))
      if (endpoint) {
        return {
          node: endpoint.node,
          port: endpoint.port,
          model: getFieldValue(row, MODEL_USED_KEYS),
        }
      }
    }

    return null
  } catch {
    return null
  }
}

async function fetchGpuCountForPort(port, resultsScope, modelUrl, fallbackModelId) {
  const endpoint = await resolveModelEndpointForPort(port, resultsScope, modelUrl)
  if (!endpoint) {
    return null
  }

  const modelCandidates = [endpoint.model, fallbackModelId].filter(
    (value) => value !== null && value !== undefined && String(value).trim() !== '',
  )

  for (const model of modelCandidates) {
    try {
      const data = await fetchJson('/api/job-gpu-count', port, {
        model,
        node: endpoint.node,
        port: endpoint.port,
      })

      const rawCount = data?.gpuCount
      if (rawCount === undefined || rawCount === null) {
        return null
      }

      const numeric = Number(rawCount)
      return Number.isInteger(numeric) && numeric >= 0 ? numeric : null
    } catch {
      // A non-matching model yields 404 JOB_NOT_FOUND; try the next candidate.
    }
  }

  return null
}

// The attributes the results themselves record: a finished run stores the model it served, the host it
// was served on and the GPU count it used in its own results.csv (MODEL_USED, URL, GPU_COUNT). They
// name the same upload folder the live API answers with, so they are the fallback for results whose
// serving job no longer responds (`/api/llm-name` reports "unknown" once the model process is gone and
// squeue can no longer see the job). Read lazily, only for values the live resolution is missing, and
// they never override one. The caller passes the results sources to try, most specific first, and the
// first usable value of every field wins.
async function readResultsUploadIdentity(port, resultsScopes) {
  const identity = { model: '', node: '', port: null, gpuCount: null, resultsScope: '' }
  const scopes = [...new Set((resultsScopes || []).filter(Boolean))]

  for (const resultsScope of scopes) {
    try {
      const current = await fetchJson('/api/current-experiment', port, { resultsScope })
      const experiment = current?.experiment
      const iteration = current?.iteration
      if (!experiment || !iteration) {
        continue
      }

      const csv = await fetchJson(
        `/api/experiments/${encodeURIComponent(experiment)}/iterations/${encodeURIComponent(iteration)}/results.csv`,
        port,
        { resultsScope, fields: UPLOAD_IDENTITY_FIELDS },
      )

      // The newest row is the state the run ended in, so it is read first. Every iteration of an
      // archive repeats the same columns, which is why the fields are collected row by row.
      const rows = [...(csv?.rows || [])].reverse()
      for (const row of rows) {
        if (!identity.model) {
          const model = getFieldValue(row, MODEL_USED_KEYS)
          if (isUsableUploadValue(model)) {
            identity.model = String(model).trim()
          }
        }

        if (!identity.node) {
          const endpoint = parseEndpointFromUrl(getFieldValue(row, MODEL_URL_KEYS))
          if (endpoint) {
            identity.node = endpoint.node
            identity.port = endpoint.port
          }
        }

        if (identity.gpuCount === null) {
          identity.gpuCount = parseUploadGpuCount(getFieldValue(row, GPU_COUNT_KEYS))
        }

        if (identity.model && identity.node && identity.gpuCount !== null) {
          break
        }
      }

      if (identity.model || identity.node || identity.gpuCount !== null) {
        identity.resultsScope = identity.resultsScope || resultsScope
      }

      if (identity.model && identity.node && identity.gpuCount !== null) {
        return identity
      }
    } catch {
      // A scope whose latest iteration has no readable results.csv contributes nothing; the next
      // scope is tried and an empty identity keeps the caller on its previous behavior.
    }
  }

  return identity
}

// Values the API-related helpers report when they could not resolve something. They must never end up
// in an upload folder name or in a GitHub commit message.
const UPLOAD_UNAVAILABLE_VALUES = new Set([
  '',
  'unavailable',
  'loading...',
  'unknown',
  'unknown model',
  'n/a',
  'null',
  'undefined',
])

const MAX_UPLOAD_GPU_COUNT = 64

function isUsableUploadValue(value) {
  if (value === null || value === undefined) {
    return false
  }

  return !UPLOAD_UNAVAILABLE_VALUES.has(String(value).trim().toLowerCase())
}

// `GPU_COUNT` is stored best-effort by the experiment environment and may be blank, so only a plain
// integer inside the range the uploader accepts may reach the folder name (`<model>-<gpuType>-<N>gpus`).
function parseUploadGpuCount(value) {
  const numeric = Number(String(value ?? '').trim())
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= MAX_UPLOAD_GPU_COUNT ? numeric : null
}

// Uploads are restricted to finished experiments: only those have a complete results.csv series.
function isFinishedExperiment(status) {
  return Boolean(status?.finished)
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const separator = result.indexOf(',')
      resolve(separator === -1 ? '' : result.slice(separator + 1))
    }
    reader.onerror = () => reject(new Error('Unable to read the results file.'))
    reader.readAsDataURL(blob)
  })
}

// Collector for the ZIP download: it builds one `<sub-experiment>/<iteration>/<file>` entry per
// available file, base64-encoded because a ZIP entry is written from a string. Every entry also carries
// the experiment (results source) it was read from, which the ZIP download ignores and keeps using
// `path` alone. The GitHub upload no longer shares this collector: it streams each CSV to the tunnel
// manager as raw bytes (`streamExperimentResultsToUploadSession`), so nothing here is base64-encoded for
// the upload, and only one file is ever held at a time.
async function collectExperimentResultFiles(
  experiment,
  port,
  resultsScope,
  fileNames = ['results.csv'],
  onProgress,
  iterationNames,
) {
  const iterations = iterationNames || (
    await fetchJson(
      `/api/experiments/${encodeURIComponent(experiment)}/iterations`,
      port,
      { resultsScope },
    )
  ).iterations || []
  const files = []
  const experimentFolder = buildUploadExperimentFolder(resultsScope)

  for (const iterationName of iterations) {
    // The two files for an iteration are independent. Fetching them together avoids making the
    // derived results_from_json.csv conversion wait behind results.csv, while Promise.all keeps
    // memory bounded to one iteration instead of collecting an entire port at once.
    const iterationFiles = await Promise.all(
      fileNames.map(async (fileName) => {
        onProgress?.({
          experiment: experimentFolder,
          subExperiment: experiment,
        })
        const endpoint = `/api/experiments/${encodeURIComponent(experiment)}/iterations/${encodeURIComponent(iterationName)}/download/${fileName}`
        const response = await fetch(buildApiUrl(endpoint, port, { resultsScope }))
        if (!response.ok) {
          onProgress?.({ completed: 1 })
          return null
        }

        const contentBase64 = await blobToBase64(await response.blob())
        if (!contentBase64) {
          onProgress?.({ completed: 1 })
          return null
        }

        onProgress?.({ ready: 1, completed: 1 })
        return {
          path: `${experiment}/${iterationName}/${fileName}`,
          experimentFolder,
          contentBase64,
        }
      }),
    )

    files.push(...iterationFiles.filter(Boolean))
  }

  return files
}

// Coalesces progress notifications so a sweep of thousands of files repaints a few hundred times
// instead of once per file. The caller keeps its counters exact and passes the current absolute
// snapshot every time; only the state setter (and therefore the re-render) is rate limited, with a
// trailing flush so a final value is never dropped. `cancel` stops a pending flush when the value
// is about to be replaced explicitly.
function createThrottledProgress(apply, minIntervalMs = 150) {
  let pending = null
  let lastRun = 0
  let timer = null

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    lastRun = Date.now()
    const next = pending
    pending = null
    if (next) {
      apply(next)
    }
  }

  const report = (payload) => {
    pending = payload
    if (timer) {
      return
    }
    const elapsed = Date.now() - lastRun
    if (elapsed >= minIntervalMs) {
      flush()
      return
    }
    timer = setTimeout(flush, minIntervalMs - elapsed)
  }

  report.flush = flush
  report.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }

  return report
}

// The fraction (0..1) the upload bar shows. Once files stream it tracks `completed`/`ready` against
// the expected file count; while a results source is still being prepared (no file streamed yet) it
// falls back to the source counter, so the bar can never sit pinned at 0% during the prepare phase.
function uploadProgressFraction(progress) {
  if (!progress) {
    return 0
  }

  if (progress.total > 0) {
    return Math.min((progress.completed ?? progress.ready ?? 0) / progress.total, 1)
  }

  if (progress.groupCount > 0) {
    return Math.min((progress.preparedGroups || 0) / progress.groupCount, 1)
  }

  return 0
}

// Asks the API to prepare every derived results_from_json.csv an experiment is missing in one
// server pass, so the upload that follows streams cache hits instead of spawning a Python process
// per file mid-sweep. Strictly best-effort and time-boxed: the per-file download endpoint still
// converts on demand, so a slow or failing pass must never block (or outlive) the upload it warms.
// No retries: the server's own batch budget is an hour, far past anything a progress bar should wait.
const ENSURE_RESULTS_TIMEOUT_MS = 120000

async function ensureExperimentResultsFromJson(
  experiment,
  port,
  resultsScope,
  timeoutMs = ENSURE_RESULTS_TIMEOUT_MS,
) {
  try {
    const endpoint = `/api/experiments/${encodeURIComponent(experiment)}/ensure-results-from-json`
    const response = await fetchWithTimeout(
      buildApiUrl(endpoint, port, { resultsScope }),
      { method: 'POST' },
      timeoutMs,
    )
    if (response.ok) {
      return await response.json()
    }
    throw uploadHttpError(`Results preparation failed (HTTP ${response.status}).`, response.status)
  } catch {
    // Best-effort: per-file downloads still convert on demand if this pass fails or times out.
    return null
  }
}

// Streams an experiment's result CSVs to an open upload session: each blob is posted as raw bytes as
// soon as it is fetched and then dropped, so the browser never holds the whole experiment (nor its
// base64 spelling). Transfers run through a small pool (`UPLOAD_FILE_CONCURRENCY`) instead of strictly
// one file at a time, because the SSH-tunnel download hop dominates and used to sit idle between files.
// Peak browser memory is the pool size times one file. The server serializes the per-session
// bookkeeping (see `addUploadSessionFile`), so the parallel posts stay correct. `onProgress` mirrors the
// batched collector so the progress bar keeps its meaning.
async function streamExperimentResultsToUploadSession({
  sessionId,
  experiment,
  port,
  resultsScope,
  experimentFolder,
  iterationNames,
  fileNames = ['results.csv', 'results_from_json.csv'],
  onProgress,
}) {
  const iterations = iterationNames || (
    await fetchJson(
      `/api/experiments/${encodeURIComponent(experiment)}/iterations`,
      port,
      { resultsScope },
    )
  ).iterations || []

  let fileCount = 0

  // One independent transfer per (iteration, file): the two files of an iteration are as independent of
  // each other as two iterations are, so they all share one pool instead of two nested serial loops.
  const tasks = []
  for (const iterationName of iterations) {
    for (const fileName of fileNames) {
      tasks.push({ iterationName, fileName })
    }
  }

  await runWithConcurrency(tasks, UPLOAD_FILE_CONCURRENCY, async ({ iterationName, fileName }) => {
    onProgress?.({
      experiment: experimentFolder,
      subExperiment: experiment,
    })

    const endpoint = `/api/experiments/${encodeURIComponent(experiment)}/iterations/${encodeURIComponent(iterationName)}/download/${fileName}`
    const blob = await withUploadRetry(async () => {
      const response = await fetchWithTimeout(buildApiUrl(endpoint, port, { resultsScope }))
      if (!response.ok) {
        throw uploadHttpError(
          `The file ${fileName} could not be downloaded (HTTP ${response.status}).`,
          response.status,
        )
      }
      return response.blob()
    }).catch(() => null)

    if (!blob) {
      // A missing file (or a download that keeps failing) is skipped; the rest of the sweep goes on.
      onProgress?.({ completed: 1 })
      return
    }

    await uploadGitHubSessionFile(sessionId, `${experiment}/${iterationName}/${fileName}`, blob)
    // A plain synchronous increment between awaits: the event loop never interleaves it, so the shared
    // counter stays exact however many transfers are in flight.
    fileCount += 1
    onProgress?.({ ready: 1, completed: 1 })
  })

  return { fileCount }
}

// Everything the port currently exposes (interval pairs and additive `mix_...` folders), split by the
// FINISHED flag of each experiment's latest results.csv.
async function collectFinishedExperimentsForPort(port, resultsScope) {
  const data = await fetchJson('/api/experiments', port, { resultsScope })
  const additiveNames = (data.additiveExperiments || []).map((entry) => entry?.name)
  const names = [...new Set([...(data.experiments || []), ...additiveNames])].filter(Boolean)
  const statuses = await Promise.all(
    names.map(async (name) => [name, await fetchExperimentStatus(name, port, resultsScope)]),
  )

  const finished = []
  const skipped = []

  for (const [name, status] of statuses) {
    if (isFinishedExperiment(status)) {
      finished.push(name)
    } else {
      skipped.push(name)
    }
  }

  return { finished, skipped }
}

// Results sources that only hold archives of runs that already ended. `current` is the folder of the
// execution that is still running: its cells can still be added or rewritten, so it is never uploaded
// on its own; the archive it becomes is picked up by the next upload once that run ends. The scopes are
// always fetched for the given port, which is not necessarily the port the dashboard is viewing.
async function fetchCompletedResultsScopes(port) {
  const data = await fetchJson('/api/results-scopes', port)
  const scopes = Array.isArray(data.scopes) ? data.scopes : []

  return [...new Set(scopes)].filter((scope) => scope && scope !== DEFAULT_RESULTS_SCOPE)
}

// The finished sub-experiments (interval pairs and additive `mix_...` folders) of every completed
// results source of the port, each one paired with the archive it was read from. Two archives hold the
// same cell names, so the source has to travel with every entry: the upload names the experiment level
// after it, which is what keeps the iterations of `1-100_100-300` of two runs apart in the repository.
async function collectFinishedExperimentsFromCompletedSources(port) {
  const resultsScopes = await fetchCompletedResultsScopes(port)
  const experiments = []
  const skipped = []

  for (const resultsScope of resultsScopes) {
    const collected = await collectFinishedExperimentsForPort(port, resultsScope)
    collected.finished.forEach((name) => experiments.push({ name, resultsScope }))
    collected.skipped.forEach((name) => skipped.push({ name, resultsScope }))
  }

  return { resultsScopes, experiments, skipped }
}

// One upload can span several results sources, so every experiment travels with the source it has to be
// read from. A bare name keeps the single-source behavior by falling back to the source the dashboard
// currently shows, and a repeated `source`+`name` pair (the panel lists a cell once) is collapsed.
function normalizeUploadExperimentEntries(experiments, fallbackResultsScope) {
  const entries = []
  const seen = new Set()

  for (const experiment of experiments || []) {
    const name = typeof experiment === 'string' ? experiment : experiment?.name
    if (!name) {
      continue
    }

    const resultsScope =
      typeof experiment === 'string' || !experiment.resultsScope
        ? fallbackResultsScope
        : experiment.resultsScope
    const key = `${resultsScope}::${name}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    entries.push({ name, resultsScope })
  }

  return entries
}

function buildUploadCommitMessage({ model, experimentCount, fileCount, sourceLabel }) {
  const scope = sourceLabel ? ` (${sourceLabel})` : ''
  const experimentLabel = experimentCount === 1 ? 'experiment' : 'experiments'
  return `Add ${experimentCount} ${experimentLabel} from ${model}: ${fileCount} result CSV file(s) via MoST-dashboard${scope}`
}

async function fetchGitHubUploadStatus() {
  const response = await fetch(buildTunnelUrl('/github/status'))
  if (!response.ok) {
    throw new Error(`GitHub status request failed (HTTP ${response.status}).`)
  }

  return response.json()
}

// Opens the server-side upload session an experiment's files stream into. The commit is still created
// by the tunnel manager (the only process that ever sees the GitHub token, which lives in the
// server-side .env and never in this bundle), but now the browser only ever has to send one file.
async function startGitHubUploadSession({
  model,
  node,
  gpuCount,
  uploadMode,
  experimentFolder,
  commitMessage,
}) {
  const response = await fetchWithTimeout(
    buildTunnelUrl('/github/upload/session'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, node, gpuCount, uploadMode, experimentFolder, commitMessage }),
    },
    UPLOAD_LONG_REQUEST_TIMEOUT_MS,
  )

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok || !payload?.sessionId) {
    throw new Error(
      payload?.error || `The GitHub upload session could not be opened (HTTP ${response.status}).`,
    )
  }

  return payload
}

// Posts one result CSV as raw bytes. The server stores it in the session's pending tree and commits it
// together with the rest of the experiment.
async function uploadGitHubSessionFile(sessionId, filePath, blob) {
  const query = `?path=${encodeURIComponent(filePath)}`
  const url = buildTunnelUrl(`/github/upload/session/${encodeURIComponent(sessionId)}/file${query}`)

  // Safe to retry: the manager replaces a pending entry with the same tree path, so replaying the file
  // after a timeout cannot add it to a commit twice.
  return withUploadRetry(async () => {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    })

    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    if (!response.ok) {
      throw uploadHttpError(
        payload?.error || `The results file ${filePath} could not be uploaded (HTTP ${response.status}).`,
        response.status,
      )
    }

    return payload || {}
  })
}

// Commits the session and returns the same summary `POST /github/upload` used to return.
async function commitGitHubUploadSession(sessionId) {
  const response = await fetchWithTimeout(
    buildTunnelUrl(`/github/upload/session/${encodeURIComponent(sessionId)}/commit`),
    { method: 'POST' },
    UPLOAD_LONG_REQUEST_TIMEOUT_MS,
  )

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw uploadHttpError(
      payload?.error || `The GitHub upload could not be committed (HTTP ${response.status}).`,
      response.status,
    )
  }

  return payload || {}
}

// Best-effort: a failed sweep drops its half-filled session instead of leaving it for the janitor.
async function abortGitHubUploadSession(sessionId) {
  try {
    await fetchWithTimeout(
      buildTunnelUrl(`/github/upload/session/${encodeURIComponent(sessionId)}/abort`),
      { method: 'POST' },
      UPLOAD_REQUEST_TIMEOUT_MS,
    )
  } catch {
    // The server prunes an abandoned session after a timeout anyway.
  }
}

function CustomNode({ cx, cy, payload, onHover, onHoverEnd, onSelect }) {
  if (!payload || cx === undefined || cy === undefined) {
    return null
  }

  const isPositive = payload.evaluation
  const interactionProps = {
    onMouseEnter: () => onHover?.(payload, { x: cx, y: cy }),
    onMouseMove: () => onHover?.(payload, { x: cx, y: cy }),
    onMouseLeave: () => onHoverEnd?.(),
    onClick: () => onSelect?.(payload.iteration),
  }

  const color = payload.stage === 2 ? STAGE_TWO_COLOR : STAGE_ONE_COLOR

  if (isPositive) {
    return (
      <g className="chart-node" {...interactionProps}>
        <circle cx={cx} cy={cy} r={NODE_HIT_RADIUS_PX} className="chart-node-hitarea" />
        <circle cx={cx} cy={cy} r={6} fill={color} stroke="#ffffff" strokeWidth={1.6} className="chart-node-mark" />
      </g>
    )
  }

  const size = 7

  return (
    <g className="chart-node chart-node-false" {...interactionProps}>
      <circle cx={cx} cy={cy} r={NODE_HIT_RADIUS_PX} className="chart-node-hitarea" />
      <line
        x1={cx - size}
        y1={cy - size}
        x2={cx + size}
        y2={cy + size}
        stroke={color}
        strokeWidth={2.9}
        strokeLinecap="round"
        className="chart-node-mark"
      />
      <line
        x1={cx - size}
        y1={cy + size}
        x2={cx + size}
        y2={cy - size}
        stroke={color}
        strokeWidth={2.9}
        strokeLinecap="round"
        className="chart-node-mark"
      />
    </g>
  )
}

function IterationSummary({ point }) {
  if (!point) {
    return null
  }

  return (
    <div className="custom-tooltip">
      <p>{point.dateLabel}</p>
      <p>Iteration: {point.index}</p>
      <p>REQ_MIN: {point.reqMin ?? 'N/A'}</p>
      <p>Stage: {point.stage}</p>
      <p>Evaluation: {String(point.evaluation).toUpperCase()}</p>
      <p>Success: {point.successLabel}</p>
    </div>
  )
}

// The four comparison metrics of one mix, shared by the list rows and the block under the matrix.
// The list rows show the distance alone, while the block under the matrix keeps all of them so the
// expected and true values that explain that distance stay readable next to the selected mix.
const COMPARISON_METRIC_LABELS = ['expected_sigma', 'expected_throughput', 'true_sigma', 'distance']
const ADDITIVE_ITEM_METRIC_LABELS = ['distance']

function ComparisonMetrics({ comparison, only = COMPARISON_METRIC_LABELS }) {
  const metrics = [
    { label: 'expected_sigma', value: formatComparisonValue(comparison?.expectedSigma) },
    { label: 'expected_throughput', value: formatComparisonValue(comparison?.expectedThroughput) },
    { label: 'true_sigma', value: formatComparisonValue(comparison?.trueSigma) },
    {
      label: 'distance',
      value: formatDistanceValue(comparison?.distance),
      title: Number.isFinite(comparison?.distance) ? String(comparison.distance) : undefined,
    },
  ].filter((metric) => only.includes(metric.label))

  return (
    <>
      {metrics.map((metric) => (
        <span className="comparison-metric" key={metric.label} title={metric.title}>
          <span className="comparison-metric-label">{metric.label}</span>
          <span className="comparison-metric-value">{metric.value}</span>
        </span>
      ))}
    </>
  )
}

function App() {
  const chartWrapperRef = useRef(null)
  // Popover of the matrix download icon: the ZIP keeps the folder structure, the merged CSV is a
  // single file built by the API (see downloadMatrixMergedCsv below).
  const matrixDownloadMenuRef = useRef(null)
  const [activeApiPort, setActiveApiPort] = useState(CONFIGURED_API_PORTS[0])
  const [resultsScopeOptions, setResultsScopeOptions] = useState([DEFAULT_RESULTS_SCOPE])
  const [selectedResultsScope, setSelectedResultsScope] = useState(DEFAULT_RESULTS_SCOPE)
  const [headerData, setHeaderData] = useState({ llm: 'Loading...', gpu: 'Loading...', modelUrl: 'Loading...' })
  const [experiments, setExperiments] = useState([])
  const [additiveExperiments, setAdditiveExperiments] = useState([])
  const [selectedExperiment, setSelectedExperiment] = useState('')
  const [iterationData, setIterationData] = useState([])
  const [selectedIteration, setSelectedIteration] = useState('')
  const [selectedIterationRows, setSelectedIterationRows] = useState([])
  const [requestTimeline, setRequestTimeline] = useState({ data: [], profiles: [] })
  const [requestTimelineLoading, setRequestTimelineLoading] = useState(false)
  const [requestTimelineCalculatedFor, setRequestTimelineCalculatedFor] = useState('')
  const [requestMetric, setRequestMetric] = useState('concurrent')
  const requestTimelineRequestIdRef = useRef(0)
  const [hoveredSummary, setHoveredSummary] = useState(null)
  const [loadingIterations, setLoadingIterations] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [busyExperimentDownload, setBusyExperimentDownload] = useState('')
  const [busyMatrixDownload, setBusyMatrixDownload] = useState(false)
  const [matrixDownloadMenuOpen, setMatrixDownloadMenuOpen] = useState(false)
  const [experimentStatuses, setExperimentStatuses] = useState({})
  const [loadingMatrixStatus, setLoadingMatrixStatus] = useState(false)
  // MIT/MST results source the additive panel compares its mixes against. It is used only by the
  // comparison metrics: the matrix, chart and detail panels keep reading `selectedResultsScope`.
  const [comparisonScope, setComparisonScope] = useState('')
  const [comparisonExperiments, setComparisonExperiments] = useState([])
  const [comparisonStatuses, setComparisonStatuses] = useState({})
  const [loadingComparison, setLoadingComparison] = useState(false)
  const [tunnelState, setTunnelState] = useState({
    loading: true,
    reachable: false,
    tunnels: [],
    message: 'Checking...',
  })
  const [tunnelBusyByPort, setTunnelBusyByPort] = useState({})
  const [portIdentityByPort, setPortIdentityByPort] = useState({})
  const [experimentStatusByPort, setExperimentStatusByPort] = useState({})
  const [logVisible, setLogVisible] = useState(false)
  const [logContent, setLogContent] = useState('')
  const [logMeta, setLogMeta] = useState(null)
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState('')
  const [logReloadKey, setLogReloadKey] = useState(0)
  const [githubStatus, setGitHubStatus] = useState({
    loading: true,
    configured: false,
    repo: '',
    branch: '',
    resultsPath: '',
    message: '',
  })
  const [uploadBusyKey, setUploadBusyKey] = useState('')
  const [githubUploadMode, setGitHubUploadMode] = useState('update')
  const [uploadProgress, setUploadProgress] = useState(null)
  const [uploadNotice, setUploadNotice] = useState(null)
  const [portUploadSelection, setPortUploadSelection] = useState(null)
  // Answers given through the GPU-count prompt, remembered per port for the rest of the session.
  const uploadGpuCountOverridesRef = useRef({})

  useEffect(() => {
    let isMounted = true
    // Guards against overlapping polls: a slow (or stalled) `/status` must not stack timers on top of each
    // other while an upload is running. The deadline keeps one unresponsive call from pinning the poller.
    let statusInFlight = false

    async function refreshTunnelStatus() {
      if (statusInFlight) {
        return
      }
      statusInFlight = true
      try {
        const response = await fetchWithTimeout(buildTunnelUrl('/status'), {}, 15000)
        if (!response.ok) {
          throw new Error('Tunnel manager status failed.')
        }

        const data = await response.json()
        if (!isMounted) {
          return
        }

        const tunnels = Array.isArray(data.tunnels)
          ? data.tunnels
          : data.config
            ? [
                {
                  port: data.config.localPort,
                  running: Boolean(data.running),
                  apiHealth: data.apiHealth || { ok: false, message: 'Unknown status' },
                  config: data.config,
                },
              ]
            : []

        setTunnelState({
          loading: false,
          reachable: true,
          tunnels,
          message: 'Tunnel manager online.',
        })

        if (tunnels.length > 0 && !tunnels.some((entry) => entry.port === activeApiPort)) {
          setActiveApiPort(tunnels[0].port)
        }
      } catch {
        if (!isMounted) {
          return
        }

        setTunnelState({
          loading: false,
          reachable: false,
          tunnels: [],
          message: 'Tunnel manager is offline.',
        })
      } finally {
        statusInFlight = false
      }
    }

    refreshTunnelStatus()
    const timer = setInterval(refreshTunnelStatus, 8000)

    return () => {
      isMounted = false
      clearInterval(timer)
    }
  }, [activeApiPort])

  useEffect(() => {
    async function loadResultsScopes() {
      try {
        const data = await fetchJson('/api/results-scopes', activeApiPort)
        const scopes = Array.isArray(data.scopes) ? data.scopes : []
        const defaultScope = data.defaultScope || DEFAULT_RESULTS_SCOPE
        const merged = [...new Set([defaultScope, ...scopes])]

        setResultsScopeOptions(merged.length > 0 ? merged : [DEFAULT_RESULTS_SCOPE])
        setSelectedResultsScope((previous) => {
          if (merged.includes(previous)) {
            return previous
          }

          return defaultScope
        })
      } catch {
        setResultsScopeOptions([DEFAULT_RESULTS_SCOPE])
        setSelectedResultsScope(DEFAULT_RESULTS_SCOPE)
      }
    }

    loadResultsScopes()
  }, [activeApiPort])

  useEffect(() => {
    async function loadHeader() {
      try {
        const [llmResponse, gpuResponse] = await Promise.all([
          fetchJson('/api/llm-name', activeApiPort, { resultsScope: selectedResultsScope }),
          fetchJson('/api/gpu-used', activeApiPort, { resultsScope: selectedResultsScope }),
        ])

        setHeaderData({
          llm: extractModelName(llmResponse),
          gpu: extractGpuUsed(gpuResponse),
          modelUrl: extractModelUrl(gpuResponse),
        })
      } catch {
        setHeaderData({ llm: 'Unavailable', gpu: 'Unavailable', modelUrl: 'Unavailable' })
      }
    }

    async function loadExperiments() {
      try {
        const data = await fetchJson('/api/experiments', activeApiPort, {
          resultsScope: selectedResultsScope,
        })
        const apiList = data.experiments || []
        const additiveList = (data.additiveExperiments || []).filter((entry) => entry && entry.name)
        const additiveNames = new Set(additiveList.map((entry) => entry.name))
        const configuredList = buildConfiguredExperimentList(EXPERIMENT_LIST_RAW)
        const intervalList = (configuredList.length > 0 ? configuredList : apiList).filter(
          (experiment) => !additiveNames.has(experiment) && !isAdditiveExperimentName(experiment),
        )
        // An additive results source exposes only `mix_...` sub-experiments, so the panel lists
        // them instead of the interval matrix. `experiments` stays "the selectable experiments of
        // this results source", which keeps the status, chart and detail flows untouched.
        const selectableList =
          additiveList.length > 0 ? additiveList.map((entry) => entry.name) : intervalList

        setAdditiveExperiments(additiveList)
        setExperiments(selectableList)
        setSelectedExperiment((previous) => {
          if (selectableList.length === 0) {
            return ''
          }

          return selectableList.includes(previous) ? previous : selectableList[0]
        })
      } catch {
        setErrorMessage('Unable to load experiments from API.')
      }
    }

    loadHeader()
    loadExperiments()
  }, [activeApiPort, selectedResultsScope])

  useEffect(() => {
    if (experiments.length === 0) {
      setExperimentStatuses({})
      return
    }

    let isCancelled = false

    async function loadExperimentStatuses() {
      setLoadingMatrixStatus(true)

      try {
        const statuses = await Promise.all(
          experiments.map(async (experiment) => [
            experiment,
            await fetchExperimentStatus(experiment, activeApiPort, selectedResultsScope),
          ]),
        )

        if (!isCancelled) {
          setExperimentStatuses(Object.fromEntries(statuses))
        }
      } finally {
        if (!isCancelled) {
          setLoadingMatrixStatus(false)
        }
      }
    }

    loadExperimentStatuses()

    return () => {
      isCancelled = true
    }
  }, [experiments, activeApiPort, selectedResultsScope])

  // The comparison metrics of the additive panel read a second, MIT/MST results source without
  // touching the main *Results source*: its `mix_...` folders are filtered out (they are additive
  // sub-experiments) and every remaining interval pair reports the cell value it measured.
  useEffect(() => {
    if (!comparisonScope) {
      setComparisonExperiments([])
      setComparisonStatuses({})
      setLoadingComparison(false)
      return
    }

    let isCancelled = false

    async function loadComparisonStatuses() {
      setLoadingComparison(true)

      try {
        const data = await fetchJson('/api/experiments', activeApiPort, {
          resultsScope: comparisonScope,
        })
        const names = (data.experiments || []).filter(
          (experiment) => !isAdditiveExperimentName(experiment),
        )
        const statuses = await Promise.all(
          names.map(async (experiment) => [
            experiment,
            await fetchExperimentStatus(experiment, activeApiPort, comparisonScope),
          ]),
        )

        if (!isCancelled) {
          setComparisonExperiments(names)
          setComparisonStatuses(Object.fromEntries(statuses))
        }
      } catch {
        if (!isCancelled) {
          setComparisonExperiments([])
          setComparisonStatuses({})
        }
      } finally {
        if (!isCancelled) {
          setLoadingComparison(false)
        }
      }
    }

    loadComparisonStatuses()

    return () => {
      isCancelled = true
    }
  }, [comparisonScope, activeApiPort])

  useEffect(() => {
    if (!selectedExperiment) {
      return
    }

    async function loadExperimentData() {
      setLoadingIterations(true)
      setErrorMessage('')

      try {
        const iterations = await fetchExperimentIterations(
          selectedExperiment,
          activeApiPort,
          selectedResultsScope,
        )

        if (iterations.length === 0) {
          setIterationData([])
          setSelectedIteration('')
          setSelectedIterationRows([])
          return
        }

        const points = await Promise.all(
          iterations.map(async (iterationName, index) => {
            const csv = await fetchJson(
              `/api/experiments/${encodeURIComponent(selectedExperiment)}/iterations/${encodeURIComponent(iterationName)}/results.csv`,
              activeApiPort,
              { resultsScope: selectedResultsScope },
            )

            const firstRow = csv.rows?.[0] || {}
            const reqMinRaw = getFieldValue(firstRow, REQ_MIN_KEYS)
            const evaluationRaw = getFieldValue(firstRow, EVALUATION_KEYS)
            const dateRaw = getFieldValue(firstRow, DATE_KEYS) || iterationName
            const successRaw = getFieldValue(firstRow, SUCCESS_KEYS)
            const stage = detectStage(iterationName, firstRow)
            const reqMin = parseNumber(reqMinRaw)
            const evaluation = parseBoolean(evaluationRaw)

            return {
              index: index + 1,
              iteration: iterationName,
              dateLabel: dateRaw,
              reqMin,
              stage,
              evaluation,
              successLabel: formatSuccessRate(successRaw),
              stage1ReqMin: stage === 1 ? reqMin : null,
              stage2ReqMin: stage === 2 ? reqMin : null,
              experimentType: formatExperimentType(
                getFieldValue(firstRow, EXPERIMENT_TYPE_KEYS),
              ),
              rows: csv.rows || [],
            }
          }),
        )

        setIterationData(points)
        if (points.length > 0) {
          setSelectedIteration(points[0].iteration)
          setSelectedIterationRows(points[0].rows)
        } else {
          setSelectedIteration('')
          setSelectedIterationRows([])
        }
      } catch {
        setIterationData([])
        setSelectedIteration('')
        setSelectedIterationRows([])
        setErrorMessage(`Unable to load iteration data for ${selectedExperiment} on port ${activeApiPort}.`)
      } finally {
        setLoadingIterations(false)
      }
    }

    loadExperimentData()
  }, [selectedExperiment, activeApiPort, selectedResultsScope])

  useEffect(() => {
    requestTimelineRequestIdRef.current += 1
    setRequestTimeline({ data: [], profiles: [] })
    setRequestTimelineCalculatedFor('')
    setRequestTimelineLoading(false)
  }, [selectedExperiment, selectedIteration, activeApiPort, selectedResultsScope])

  async function calculateRequestTimeline() {
    if (!selectedExperiment || !selectedIteration || requestTimelineLoading) {
      return
    }

    const requestId = requestTimelineRequestIdRef.current + 1
    requestTimelineRequestIdRef.current = requestId
    setRequestTimelineLoading(true)
    setRequestTimelineCalculatedFor('')

    try {
      const endpoint = `/api/experiments/${encodeURIComponent(selectedExperiment)}/iterations/${encodeURIComponent(selectedIteration)}/download/results_from_json.csv`
      const response = await fetch(
        buildApiUrl(endpoint, activeApiPort, { resultsScope: selectedResultsScope }),
      )
      if (!response.ok) {
        throw new Error(`Request timeline failed (${response.status}).`)
      }

      const timeline = buildRequestTimeline(parseCsv(await response.text()))
      if (requestTimelineRequestIdRef.current !== requestId) {
        return
      }

      setRequestTimeline(timeline)
      setRequestTimelineCalculatedFor(selectedIteration)
    } catch {
      if (requestTimelineRequestIdRef.current === requestId) {
        setRequestTimeline({ data: [], profiles: [] })
        setErrorMessage(
          `Unable to load request timeline for ${selectedIteration} on port ${activeApiPort}.`,
        )
      }
    } finally {
      if (requestTimelineRequestIdRef.current === requestId) {
        setRequestTimelineLoading(false)
      }
    }
  }

  const selectedPoint = useMemo(
    () => iterationData.find((point) => point.iteration === selectedIteration) || null,
    [iterationData, selectedIteration],
  )

  const selectedExperimentType = useMemo(
    () =>
      selectedPoint?.experimentType ||
      experimentStatuses[selectedExperiment]?.experimentType ||
      null,
    [selectedPoint, experimentStatuses, selectedExperiment],
  )

  const matrixModel = useMemo(() => {
    const pairEntries = experiments
      // Additive sub-experiments (`mix_...`) do not describe an interval pair, so feeding them to
      // parseExperimentPair would fabricate bogus matrix cells.
      .filter((experiment) => !isAdditiveExperimentName(experiment))
      .map((experiment) => {
        const parsed = parseExperimentPair(experiment)
        if (!parsed) {
          return null
        }

        return {
          experiment,
          inputRange: parsed.inputRange,
          outputRange: parsed.outputRange,
        }
      })
      .filter(Boolean)

    const inputRanges = [...new Set(pairEntries.map((entry) => entry.inputRange))].sort(
      (a, b) => intervalStart(a) - intervalStart(b),
    )
    const outputRanges = [...new Set(pairEntries.map((entry) => entry.outputRange))].sort(
      (a, b) => intervalStart(a) - intervalStart(b),
    )

    const pairMap = pairEntries.reduce((accumulator, entry) => {
      accumulator[`${entry.inputRange}__${entry.outputRange}`] = entry.experiment
      return accumulator
    }, {})

    return {
      inputRanges,
      outputRanges,
      pairMap,
    }
  }, [experiments])

  const matrixExperiments = useMemo(() => {
    const entries = Object.values(matrixModel.pairMap).filter(Boolean)
    return [...new Set(entries)]
  }, [matrixModel])

  // The header download menu covers whatever the panel shows: the interval matrix cells, or the
  // `mix_...` sub-experiments of an additive (Experiment_MIX_*) source. Those mixes are not matrix
  // cells, but their `results.csv` files download the same way: the merged CSV helper merges any
  // explicitly requested folder, additive ones included.
  const downloadableExperiments = useMemo(
    () =>
      matrixExperiments.length > 0
        ? matrixExperiments
        : additiveExperiments.map((entry) => entry.name),
    [matrixExperiments, additiveExperiments],
  )

  // Only finished experiments can be uploaded: their results.csv series is complete. The experiment
  // level of the uploaded folder tree is named after the results source the panel reads, so the live
  // `current` folder (no archive name yet) can only be uploaded once the run ends and it becomes an
  // `Experiment_*` archive.
  const finishedDownloadableExperiments = useMemo(
    () =>
      downloadableExperiments.filter((experiment) =>
        isFinishedExperiment(experimentStatuses[experiment]),
      ),
    [downloadableExperiments, experimentStatuses],
  )
  const viewedScopeUploadable = buildUploadExperimentFolder(selectedResultsScope) !== null

  const matrixExperimentType = useMemo(() => {
    const types = Object.values(experimentStatuses)
      .map((status) => status?.experimentType)
      .filter(Boolean)

    return types[0] || null
  }, [experimentStatuses])

  // An additive results source exposes `mix_...` sub-experiments and no interval pairs, so the
  // panel renders that vertical list instead of the matrix.
  const isAdditiveMode = additiveExperiments.length > 0

  const additiveDescriptorByName = useMemo(
    () => Object.fromEntries(additiveExperiments.map((entry) => [entry.name, entry])),
    [additiveExperiments],
  )

  const selectedAdditive = isAdditiveMode
    ? additiveDescriptorByName[selectedExperiment] || null
    : null

  const selectedExperimentLabel = selectedAdditive
    ? formatAdditiveLabel(selectedAdditive)
    : formatExperimentLabel(selectedExperiment)

  // The additive matrix marks the cells of the selected mix only, so the model stays shared and the
  // per-cell alpha of the current selection is looked up separately.
  const additiveMatrixModel = useMemo(
    () =>
      buildAdditiveMatrixModel(additiveExperiments, experimentStatuses, CONFIGURED_MATRIX_AXES),
    [additiveExperiments, experimentStatuses],
  )

  const displayedAdditiveInputRanges = useMemo(
    () => [...additiveMatrixModel.inputRanges].reverse(),
    [additiveMatrixModel.inputRanges],
  )

  const selectedAdditiveCellAlphaByKey = useMemo(() => {
    const alphaByKey = {}

    Object.entries(additiveMatrixModel.cellMap).forEach(([pairKey, cells]) => {
      const selectedAlpha = cells
        .filter((cell) => cell.mixName === selectedExperiment)
        .reduce((sum, cell) => sum + cell.alpha, 0)

      if (selectedAlpha > 0) {
        alphaByKey[pairKey] = selectedAlpha
      }
    })

    return alphaByKey
  }, [additiveMatrixModel.cellMap, selectedExperiment])

  const finishedLargestTrueValues = useMemo(
    () =>
      Object.values(experimentStatuses)
        .filter((status) => status?.hasResults && status?.finished && Number.isFinite(status?.largestTrue))
        .map((status) => status.largestTrue),
    [experimentStatuses],
  )

  const maxLargestTrueValue = useMemo(() => {
    if (finishedLargestTrueValues.length === 0) {
      return 0
    }

    return Math.max(...finishedLargestTrueValues)
  }, [finishedLargestTrueValues])

  // The comparison metrics come from a source of the same experiment type as the additivity run: an
  // MIT additive source compares against `Experiment_MIT_*`, an MST one against `Experiment_MST_*`.
  const additiveExperimentType = useMemo(() => {
    if (matrixExperimentType) {
      return matrixExperimentType.toUpperCase()
    }

    return readExperimentTypeFromScope(selectedResultsScope) || DEFAULT_EXPERIMENT_TYPE
  }, [matrixExperimentType, selectedResultsScope])

  const comparisonScopeOptions = useMemo(
    () =>
      resultsScopeOptions.filter(
        (scope) => readExperimentTypeFromScope(scope) === additiveExperimentType,
      ),
    [resultsScopeOptions, additiveExperimentType],
  )

  // A source left selected after the main results source changes type (or disappears) is cleared,
  // so the panel never shows metrics computed against a foreign experiment type.
  useEffect(() => {
    if (comparisonScope && !comparisonScopeOptions.includes(comparisonScope)) {
      setComparisonScope('')
    }
  }, [comparisonScope, comparisonScopeOptions])

  // Every mix is compared in one pass so the list rows (one mix each) and the block under the matrix
  // (the selected mix) read from the same numbers.
  const comparisonByMix = useMemo(() => {
    if (!comparisonScope) {
      return {}
    }

    const pairMap = buildComparisonPairMap(comparisonExperiments)
    const comparisonSigma = resolveComparisonSigma(comparisonStatuses)
    const entries = additiveExperiments.map((entry) => [
      entry.name,
      buildMixComparison({
        profiles: resolveAdditiveProfiles(entry, experimentStatuses?.[entry.name]),
        trueValue: experimentStatuses?.[entry.name]?.largestTrue,
        pairMap,
        comparisonStatuses,
        scopeSigma: comparisonSigma,
      }),
    ])

    return Object.fromEntries(entries)
  }, [
    comparisonScope,
    comparisonExperiments,
    comparisonStatuses,
    additiveExperiments,
    experimentStatuses,
  ])

  const selectedComparison = comparisonByMix[selectedExperiment] || null

  const heatScale = useMemo(() => {
    if (finishedLargestTrueValues.length === 0) {
      return { min: 0, max: 1 }
    }

    return {
      min: Math.min(...finishedLargestTrueValues),
      max: Math.max(...finishedLargestTrueValues),
    }
  }, [finishedLargestTrueValues])

  const displayedInputRanges = useMemo(
    () => [...matrixModel.inputRanges].reverse(),
    [matrixModel.inputRanges],
  )

  const tableColumns = useMemo(() => {
    const columns = new Set()
    selectedIterationRows.forEach((row) => {
      Object.keys(row).forEach((key) => columns.add(key))
    })
    return [...columns]
  }, [selectedIterationRows])

  function handleSelectPoint(iteration) {
    const found = iterationData.find((point) => point.iteration === iteration)
    if (!found) {
      return
    }

    setSelectedIteration(found.iteration)
    setSelectedIterationRows(found.rows)
  }

  function formatMatrixValue(value) {
    if (!Number.isFinite(value)) {
      return ''
    }

    return String(Math.round(value * 100) / 100)
  }

  function getInverseNormalizedValue(originalValue) {
    if (!Number.isFinite(originalValue) || originalValue === 0 || maxLargestTrueValue === 0) {
      return null
    }

    return maxLargestTrueValue / originalValue
  }

  function handlePointHover(point, position) {
    if (!point || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      return
    }

    const wrapperRect = chartWrapperRef.current?.getBoundingClientRect()
    const wrapperWidth = wrapperRect?.width || 0
    const wrapperHeight = wrapperRect?.height || 0

    const rawLeft = position.x - TOOLTIP_FALLBACK_WIDTH_PX - TOOLTIP_OFFSET_PX
    const rawTop = position.y - TOOLTIP_FALLBACK_HEIGHT_PX / 2

    const maxLeft = Math.max(TOOLTIP_MARGIN_PX, wrapperWidth - TOOLTIP_FALLBACK_WIDTH_PX - TOOLTIP_MARGIN_PX)
    const maxTop = Math.max(TOOLTIP_MARGIN_PX, wrapperHeight - TOOLTIP_FALLBACK_HEIGHT_PX - TOOLTIP_MARGIN_PX)

    const clampedLeft = wrapperWidth
      ? Math.min(Math.max(rawLeft, TOOLTIP_MARGIN_PX), maxLeft)
      : rawLeft
    const clampedTop = wrapperHeight
      ? Math.min(Math.max(rawTop, TOOLTIP_MARGIN_PX), maxTop)
      : rawTop

    setHoveredSummary({
      point,
      position: {
        x: clampedLeft,
        y: clampedTop,
      },
    })
  }

  function handlePointHoverEnd() {
    setHoveredSummary(null)
  }

  function handleChartMouseLeave() {
    setHoveredSummary(null)
  }

  async function downloadIterationFile(fileType) {
    if (!selectedExperiment || !selectedIteration) {
      return
    }

    if (
      fileType === 'results.json' &&
      !window.confirm('This download may take a long time. Do you want to continue?')
    ) {
      return
    }

    try {
      const endpoint = `/api/experiments/${encodeURIComponent(selectedExperiment)}/iterations/${encodeURIComponent(selectedIteration)}/download/${fileType}`
      const response = await fetch(
        buildApiUrl(endpoint, activeApiPort, { resultsScope: selectedResultsScope }),
      )
      if (!response.ok) {
        throw new Error('Download failed.')
      }

      const blob = await response.blob()
      saveAs(blob, `${selectedExperiment}-${selectedIteration}-${fileType}`)
    } catch {
      setErrorMessage(`Unable to download ${fileType} for ${selectedIteration} on port ${activeApiPort}.`)
    }
  }

  // The ZIP download reads the results through `collectExperimentResultFiles`: a folder tree of
  // `<sub-experiment>/<iteration>/<file>`. (The GitHub upload streams the same files to the tunnel
  // manager instead, see `streamExperimentResultsToUploadSession`.)
  async function appendExperimentCsvToZip(experiment, zip, fileNames = ['results.csv']) {
    const files = await collectExperimentResultFiles(
      experiment,
      activeApiPort,
      selectedResultsScope,
      fileNames,
    )

    for (const file of files) {
      zip.file(file.path, file.contentBase64, { base64: true })
    }

    return files.length
  }

  async function downloadExperimentCsvZip(experiment) {
    setBusyExperimentDownload(experiment)
    setErrorMessage('')

    try {
      const zip = new JSZip()
      const fileCount = await appendExperimentCsvToZip(experiment, zip)
      if (fileCount === 0) {
        setErrorMessage(`No results.csv files found for ${experiment}.`)
        return
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' })
      saveAs(zipBlob, `${experiment}-iterations-results-csv.zip`)
    } catch {
      setErrorMessage(`Unable to build zip for ${experiment} on port ${activeApiPort}.`)
    } finally {
      setBusyExperimentDownload('')
    }
  }

  async function downloadMatrixCsvZip() {
    if (busyMatrixDownload) {
      return
    }

    setBusyMatrixDownload(true)
    setErrorMessage('')

    try {
      if (downloadableExperiments.length === 0) {
        setErrorMessage('No experiments available to download.')
        return
      }

      const zip = new JSZip()
      let fileCount = 0

      for (const experiment of downloadableExperiments) {
        try {
          fileCount += await appendExperimentCsvToZip(experiment, zip)
        } catch {
          continue
        }
      }

      if (fileCount === 0) {
        setErrorMessage('No results.csv files found in the selected results source.')
        return
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' })
      saveAs(zipBlob, `${buildResultsDownloadBaseName(selectedResultsScope)}-iterations-results-csv.zip`)
    } catch {
      setErrorMessage(`Unable to build matrix zip on port ${activeApiPort}.`)
    } finally {
      setBusyMatrixDownload(false)
    }
  }

  async function downloadMatrixResultsFromJsonCsvZip() {
    if (busyMatrixDownload) {
      return
    }

    setBusyMatrixDownload(true)
    setErrorMessage('')

    try {
      if (downloadableExperiments.length === 0) {
        setErrorMessage('No experiments available to download.')
        return
      }

      const zip = new JSZip()
      let fileCount = 0

      for (const experiment of downloadableExperiments) {
        try {
          fileCount += await appendExperimentCsvToZip(experiment, zip, ['results_from_json.csv'])
        } catch {
          continue
        }
      }

      if (fileCount === 0) {
        setErrorMessage('No results_from_json.csv files found in the selected results source.')
        return
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' })
      saveAs(
        zipBlob,
        `${buildResultsDownloadBaseName(selectedResultsScope)}-iterations-results-from-json-csv.zip`,
      )
    } catch {
      setErrorMessage(`Unable to build results_from_json.csv matrix zip on port ${activeApiPort}.`)
    } finally {
      setBusyMatrixDownload(false)
    }
  }

  // Merged single-file variant of the ZIP download: the API runs MergeResultsCsv.py over the same
  // experiments (matrix cells, or the `mix_...` sub-experiments of an additive source) and streams
  // back one CSV, with the experiment name in `IDENTIFIER` and the iteration timestamp in `DATE`.
  async function downloadMatrixMergedCsv() {
    if (busyMatrixDownload) {
      return
    }

    if (downloadableExperiments.length === 0) {
      setErrorMessage('No experiments available to download.')
      return
    }

    setBusyMatrixDownload(true)
    setErrorMessage('')

    try {
      const response = await fetch(
        buildApiUrl('/api/experiments/download/merged-results.csv', activeApiPort, {
          resultsScope: selectedResultsScope,
          experiments: downloadableExperiments.join(','),
        }),
      )
      if (!response.ok) {
        throw new Error('Merged CSV download failed.')
      }

      const blob = await response.blob()
      saveAs(blob, `${buildResultsDownloadBaseName(selectedResultsScope)}-iterations-results-merged.csv`)
    } catch {
      setErrorMessage(`Unable to build merged CSV on port ${activeApiPort}.`)
    } finally {
      setBusyMatrixDownload(false)
    }
  }

  // The GPU count names the upload folder (`<model>-<gpuType>-<N>gpus`). `/api/job-gpu-count` answers
  // from squeue while the serving job runs and then from the results the scope holds, and the uploaded
  // results themselves carry the count in their GPU_COUNT column. Only when every source is silent is
  // the operator asked, once per port and session.
  async function resolveUploadGpuCount(port, model, node, identity, resultsGpuCount) {
    if (Number.isInteger(identity?.gpuCount) && identity.gpuCount > 0) {
      return identity.gpuCount
    }

    if (Number.isInteger(resultsGpuCount) && resultsGpuCount > 0) {
      return resultsGpuCount
    }

    const remembered = uploadGpuCountOverridesRef.current[port]
    if (Number.isInteger(remembered) && remembered > 0) {
      return remembered
    }

    const detected = await fetchGpuCountForPort(
      port,
      selectedResultsScope,
      identity?.modelUrl,
      model,
    )
    if (Number.isInteger(detected) && detected > 0) {
      return detected
    }

    const answer = window.prompt(
      `Could not detect how many GPUs ${model} used on ${node}.\nEnter the GPU count for the upload folder (1-${MAX_UPLOAD_GPU_COUNT}):`,
      '',
    )
    if (answer === null) {
      return null
    }

    const numeric = Number(String(answer).trim())
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_UPLOAD_GPU_COUNT) {
      return null
    }

    uploadGpuCountOverridesRef.current[port] = numeric
    return numeric
  }

  // Everything the tunnel manager needs to name the commit folder: the model of the serving job, the
  // cluster node (which resolves the GPU type through GPU_TYPE_MAP) and the GPU count. The live API and
  // the MoST `.env` model URL answer first; the attributes the uploaded results record about themselves
  // (MODEL_USED, URL, GPU_COUNT in results.csv) fill in whatever those cannot answer, which is what
  // makes an upload of an archive whose serving job already ended possible without guessing.
  async function resolveUploadTarget(port, identity, entries) {
    const endpoint = await resolveModelEndpointForPort(
      port,
      selectedResultsScope,
      identity?.modelUrl,
    )

    let model = isUsableUploadValue(identity?.llm) ? String(identity.llm).trim() : ''
    if (!model && isUsableUploadValue(endpoint?.model)) {
      model = String(endpoint.model).trim()
    }

    let gpuCount =
      Number.isInteger(identity?.gpuCount) && identity.gpuCount > 0 ? identity.gpuCount : null
    let resultsIdentity = null

    // Read lazily: an upload of a run whose serving job still answers costs no extra request. The
    // scopes of the experiments being uploaded are tried first, then the source selected in the panel.
    if (!endpoint?.node || !model || gpuCount === null) {
      resultsIdentity = await readResultsUploadIdentity(port, [
        ...(entries || []).map((entry) => entry?.resultsScope),
        selectedResultsScope,
      ])

      if (!model && isUsableUploadValue(resultsIdentity.model)) {
        model = String(resultsIdentity.model).trim()
      }

      if (gpuCount === null) {
        gpuCount = resultsIdentity.gpuCount
      }
    }

    const node = endpoint?.node || resultsIdentity?.node || ''

    if (!node) {
      return {
        ok: false,
        error: `Unable to determine the GPU host of port ${port}: neither the MoST .env model URL nor the URL column of the results.csv of its results sources names one, so the GPU type of the upload folder cannot be mapped.`,
      }
    }

    if (!model) {
      return {
        ok: false,
        error: `Unable to determine the model name of port ${port}: neither the serving API nor the MODEL_USED column of the results.csv of its results sources reports one.`,
      }
    }

    const resolvedGpuCount = await resolveUploadGpuCount(port, model, node, identity, gpuCount)
    if (!Number.isInteger(resolvedGpuCount)) {
      return {
        ok: false,
        error: `Upload cancelled: an integer GPU count between 1 and ${MAX_UPLOAD_GPU_COUNT} is required to name the folder of ${model}.`,
      }
    }

    return { ok: true, model, node, gpuCount: resolvedGpuCount }
  }

  // Shared by the three upload entry points: collect the folder-style results of the given experiments
  // and upload them together. Large uploads are split into request-sized batches. Every experiment
  // travels with the results source it has to be read from, which lets one upload sweep several
  // completed archives (`Experiment_*`) at once.
  async function uploadExperimentsToGitHub({
    port,
    experiments,
    busyKey,
    identity,
    skippedCount = 0,
    uploadMode = 'full',
  }) {
    if (uploadBusyKey) {
      return
    }

    const entries = normalizeUploadExperimentEntries(experiments, selectedResultsScope)
    if (entries.length === 0) {
      return
    }

    // The folder tree names the experiment level after the results source, so a source without an
    // archive name (the still-running `current` folder) cannot be uploaded at all.
    if (entries.some((entry) => !buildUploadExperimentFolder(entry.resultsScope))) {
      setUploadNotice(null)
      setErrorMessage(CURRENT_SCOPE_UPLOAD_MESSAGE)
      return
    }

    const sourceLabel = formatUploadScopesLabel(entries.map((entry) => entry.resultsScope))
    const sourceCount = new Set(entries.map((entry) => entry.resultsScope)).size
    const sourceLabelSuffix = sourceCount > 1 ? ` across ${sourceLabel}` : ''

    setUploadBusyKey(busyKey)
    setUploadProgress({ ready: 0, total: 0, phase: 'collecting' })
    setUploadNotice(null)
    setErrorMessage('')

    // Rate-limits the progress re-renders: a sweep of thousands of files would otherwise set state
    // twice per file. The counters below stay exact; only the render is coalesced, and `cancel` in
    // the finally stops a trailing update from resurrecting the bar after it has been cleared.
    const reportProgress = createThrottledProgress(
      (payload) => setUploadProgress(payload),
      UPLOAD_PROGRESS_UPDATE_INTERVAL_MS,
    )

    try {
      const target = await resolveUploadTarget(port, identity, entries)
      if (!target.ok) {
        setErrorMessage(target.error)
        return
      }

      let experimentCount = 0
      let preparedFileCount = 0
      let completedFileCount = 0
      let expectedFileCount = 0
      const collectionPlans = []
      let currentExperiment = ''
      let currentSubExperiment = ''
      const uploadResults = []
      let uploadedFileCount = 0

      for (const entry of entries) {
        try {
          const iterationResponse = await fetchJson(
            `/api/experiments/${encodeURIComponent(entry.name)}/iterations`,
            port,
            { resultsScope: entry.resultsScope },
            UPLOAD_LONG_REQUEST_TIMEOUT_MS,
          )
          const iterations = iterationResponse.iterations || []
          const fileCount = iterations.length * 2
          expectedFileCount += fileCount
          collectionPlans.push({ entry, iterations })
        } catch {
          // A folder that cannot be listed is skipped; the remaining experiments still upload.
        }
      }

      setUploadProgress({
        ready: 0,
        completed: 0,
        total: expectedFileCount,
        phase: 'collecting',
      })

      // Group the experiments by results source. Preparation is shared per source, while the upload
      // session below is deliberately scoped to one sub-experiment. This bounds the lifetime and memory
      // of every session and makes a failed cell independent from the rest of the archive.
      const planGroups = new Map()
      for (const plan of collectionPlans) {
        const experimentFolder = buildUploadExperimentFolder(plan.entry.resultsScope)
        if (!planGroups.has(experimentFolder)) {
          planGroups.set(experimentFolder, [])
        }
        planGroups.get(experimentFolder).push(plan)
      }

      let failedSourceCount = 0
      let lastUploadError = ''

      // Prepare the derived per-request CSV of every iteration in one server pass so the upload that
      // follows streams cache hits instead of spawning a Python process per file mid-sweep (deriving
      // lazily, one file at a time interleaved with the upload, is what used to stall a large sweep).
      // Best-effort and time-boxed: the per-file download endpoint still converts on demand, so the
      // pass can never pin the sweep at 0%. Sources are pipelined: while one streams and commits, the
      // next source's CSVs are warmed in the background.
      const groups = [...planGroups.entries()]
      const prepareGroup = (groupPlans) =>
        runWithConcurrency(
          groupPlans || [],
          UPLOAD_PREPARATION_CONCURRENCY,
          (plan) => ensureExperimentResultsFromJson(plan.entry.name, port, plan.entry.resultsScope),
        )

      let prepareAhead = null
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        const [experimentFolder, groupPlans] = groups[groupIndex]

        // Report the preparing state (a real, advancing per-source counter) so the bar is never a
        // frozen 0.0% while the first files are being derived and no session exists yet.
        reportProgress({
          ready: preparedFileCount,
          completed: completedFileCount,
          total: expectedFileCount,
          phase: 'preparing',
          experiment: experimentFolder,
          subExperiment: groupPlans[0]?.entry?.name,
          preparedGroups: groupIndex,
          groupCount: groups.length,
        })
        // Render the preparing state and drop its pending timer before the explicit `uploading` state.
        reportProgress.flush()

        // Wait (bounded) for this source's preparation, then warm the next one while this one streams.
        await prepareAhead
        prepareAhead = prepareGroup(groups[groupIndex + 1]?.[1])

        for (const plan of groupPlans) {
          // One session per sub-experiment: raw CSVs stream directly to the manager and are committed
          // together, without retaining the rest of the source in the browser or server.
          let session
          try {
            session = await startGitHubUploadSession({
              model: target.model,
              node: target.node,
              gpuCount: target.gpuCount,
              uploadMode,
              experimentFolder,
              commitMessage: buildUploadCommitMessage({
                model: target.model,
                experimentCount: 1,
                fileCount: plan.iterations.length * 2,
                sourceLabel,
              }),
            })
          } catch (error) {
            failedSourceCount += 1
            lastUploadError =
              error instanceof Error
                ? error.message
                : `Unable to start the GitHub upload session for ${plan.entry.name}.`
            continue
          }

          let subExperimentFileCount = 0
          try {
            setUploadProgress({
              ready: preparedFileCount,
              completed: completedFileCount,
              total: expectedFileCount,
              phase: 'uploading',
              experiment: experimentFolder,
              subExperiment: plan.entry.name,
            })

            const streamed = await streamExperimentResultsToUploadSession({
              sessionId: session.sessionId,
              experiment: plan.entry.name,
              port,
              resultsScope: plan.entry.resultsScope,
              experimentFolder,
              iterationNames: plan.iterations,
              onProgress: ({
                ready = 0,
                completed = 0,
                experiment = '',
                subExperiment = '',
              } = {}) => {
                preparedFileCount += ready
                completedFileCount += completed
                currentExperiment = experiment
                currentSubExperiment = subExperiment
                reportProgress({
                  ready: preparedFileCount,
                  completed: completedFileCount,
                  total: expectedFileCount,
                  phase: 'uploading',
                  experiment,
                  subExperiment,
                })
              },
            })
            reportProgress.flush()
            subExperimentFileCount = streamed.fileCount
          } catch (error) {
            failedSourceCount += 1
            lastUploadError =
              error instanceof Error
                ? error.message
                : `Unable to upload the results of ${plan.entry.name} to GitHub.`
            await abortGitHubUploadSession(session.sessionId)
            continue
          }

          if (subExperimentFileCount > 0) {
            try {
              uploadResults.push(await commitGitHubUploadSession(session.sessionId))
            } catch (error) {
              failedSourceCount += 1
              lastUploadError =
                error instanceof Error
                  ? error.message
                  : `The GitHub upload could not be committed for ${plan.entry.name}.`
              await abortGitHubUploadSession(session.sessionId)
              continue
            }
          } else {
            await abortGitHubUploadSession(session.sessionId)
          }

          experimentCount += subExperimentFileCount > 0 ? 1 : 0
          uploadedFileCount += subExperimentFileCount

          setUploadProgress({
            ready: preparedFileCount,
            completed: completedFileCount,
            total: expectedFileCount,
            phase: 'uploading',
            experiment: currentExperiment || experimentFolder,
            subExperiment: currentSubExperiment,
          })
        }
      }

      if (uploadedFileCount === 0) {
        setErrorMessage(
          failedSourceCount > 0 && lastUploadError
            ? lastUploadError
            : `No results files found to upload for port ${port}.`,
        )
        return
      }

      const result = {
        ...uploadResults[uploadResults.length - 1],
        unchanged: uploadResults.every((entry) => entry.unchanged),
        commitCount: uploadResults.reduce((count, entry) => count + (entry.commitCount || 0), 0),
        batchCount: uploadResults.reduce((count, entry) => count + (entry.batchCount || 0), 0),
        fileCount: uploadedFileCount,
        experimentFolders: [
          ...new Set(uploadResults.flatMap((entry) => entry.experimentFolders || [])),
        ],
        trimmed: {
          count: uploadResults.reduce((count, entry) => count + (entry.trimmed?.count || 0), 0),
          examples: uploadResults.flatMap((entry) => entry.trimmed?.examples || []).slice(0, 10),
        },
      }

      const targetPath = result.folderPath || result.folder
      const experimentFolders = Array.isArray(result.experimentFolders) ? result.experimentFolders : []
      // The experiment level is part of where the files landed: the notice shows the full path when the
      // upload covered a single archive, and counts the folders when it swept several archives.
      let targetLabel = targetPath
      if (experimentFolders.length === 1) {
        targetLabel = `${targetPath}/${experimentFolders[0]}`
      } else if (experimentFolders.length > 1) {
        targetLabel = `${targetPath} (${experimentFolders.length} experiment folders)`
      }
      const skippedLabel =
        skippedCount > 0 ? ` ${skippedCount} unfinished experiment(s) were skipped.` : ''
      // Folder names git cannot check out are shortened by the server (the paths above are the ones the
      // repository actually has), so the notice says how many: the tunnel manager log maps them back.
      const trimmedCount = Number(result.trimmed?.count) || 0
      const trimmedLabel =
        trimmedCount > 0
          ? ` ${trimmedCount} folder name(s) were shortened to fit git path limits.`
          : ''

      setUploadNotice({
        text: result.unchanged
          ? `GitHub already had this content in ${targetLabel}; no new commit was created.${skippedLabel}${trimmedLabel}`
          : `Uploaded ${result.fileCount} file(s) from ${experimentCount} experiment(s)${sourceLabelSuffix} to ${result.repo} (${targetLabel} on ${result.branch}).${skippedLabel}${trimmedLabel}`,
        commitUrl: result.commitUrl || '',
        commitLabel: result.commitSha ? result.commitSha.slice(0, 7) : '',
        unchanged: Boolean(result.unchanged),
      })
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : `Unable to upload the results of port ${port} to GitHub.`,
      )
    } finally {
      setUploadBusyKey('')
      reportProgress.cancel()
      setUploadProgress(null)
    }
  }

  // Panel menu entry: every finished sub-experiment of every completed results source of the port the
  // dashboard is connected to — the interval matrix cells, or the `mix_...` sub-experiments of an
  // additive source. The ongoing `current` source is not part of that set: the matrix of a run that is
  // still executing may still change, so the archive it becomes is uploaded once the run ends.
  async function uploadPanelResultsToGitHub() {
    if (uploadBusyKey) {
      return
    }

    setUploadBusyKey('matrix-completed')
    setUploadProgress({ ready: 0, total: 0, phase: 'collecting' })
    setUploadNotice(null)
    setErrorMessage('')

    let collected = { resultsScopes: [], experiments: [], skipped: [] }

    try {
      collected = await collectFinishedExperimentsFromCompletedSources(activeApiPort)
    } catch {
      setUploadBusyKey('')
      setUploadProgress(null)
      setErrorMessage(
        `Unable to list the completed results sources of port ${activeApiPort} for the upload.`,
      )
      return
    }

    setUploadBusyKey('')
    setUploadProgress(null)

    if (collected.experiments.length === 0) {
      setErrorMessage(
        `Only finished experiments can be uploaded. No finished experiment was found in the completed results sources of port ${activeApiPort}.`,
      )
      return
    }

    await uploadExperimentsToGitHub({
      port: activeApiPort,
      experiments: collected.experiments,
      busyKey: 'matrix-completed',
      identity: portIdentityByPort[activeApiPort],
      skippedCount: collected.skipped.length,
      uploadMode: githubUploadMode,
    })
  }

  // Matrix button: the whole matrix the panel shows — every matrix cell, or every `mix_...`
  // sub-experiment of an additive source — instead of only the selected one, read from
  // the results source the dashboard is viewing. FINISHED is what makes a sub-experiment uploadable,
  // so the cells of a run that is still in progress are skipped instead of blocking the rest; a
  // completed archive is covered in full by the menu entry above. The experiment level of the committed
  // folder tree is named after that results source, so the button only works while the panel shows an
  // archive: the still-running `current` folder has no name to give (see buildUploadExperimentFolder).
  async function uploadMatrixResultsToGitHub() {
    if (!viewedScopeUploadable) {
      setUploadNotice(null)
      setErrorMessage(CURRENT_SCOPE_UPLOAD_MESSAGE)
      return
    }

    if (finishedDownloadableExperiments.length === 0) {
      setUploadNotice(null)
      setErrorMessage(
        'Only finished experiments can be uploaded. No finished experiment was found in the selected results source.',
      )
      return
    }

    await uploadExperimentsToGitHub({
      port: activeApiPort,
      experiments: finishedDownloadableExperiments,
      busyKey: 'matrix-viewed',
      identity: portIdentityByPort[activeApiPort],
      skippedCount: downloadableExperiments.length - finishedDownloadableExperiments.length,
      uploadMode: githubUploadMode,
    })
  }

  // Per-tunnel button: collect every finished sub-experiment first, then let the operator choose which
  // entries to upload. The ongoing `current` source is not part of that set.
  async function uploadTunnelResultsToGitHub(port) {
    if (uploadBusyKey || portUploadSelection) {
      return
    }

    setPortUploadSelection({ port, loading: true, experiments: [], selectedKeys: new Set() })
    setUploadProgress({ ready: 0, total: 0, phase: 'collecting' })
    setUploadNotice(null)
    setErrorMessage('')

    let collected = { resultsScopes: [], experiments: [], skipped: [] }

    try {
      collected = await collectFinishedExperimentsFromCompletedSources(port)
    } catch {
      setPortUploadSelection(null)
      setUploadProgress(null)
      setErrorMessage(
        `Unable to list the completed results sources of port ${port} for the upload.`,
      )
      return
    }

    setUploadProgress(null)

    if (collected.experiments.length === 0) {
      setPortUploadSelection(null)
      setErrorMessage(
        `No finished experiment with results was found in the completed results sources of port ${port}${
          collected.skipped.length > 0
            ? ` (${collected.skipped.length} unfinished experiment(s) skipped)`
            : ''
        }.`,
      )
      return
    }

    setPortUploadSelection({
      port,
      loading: false,
      experiments: collected.experiments,
      skippedCount: collected.skipped.length,
      expandedScopes: new Set(collected.resultsScopes),
      selectedKeys: new Set(
        collected.experiments.map((entry) => `${entry.resultsScope}::${entry.name}`),
      ),
    })
  }

  function cancelPortUploadSelection() {
    if (uploadBusyKey) {
      return
    }

    setPortUploadSelection(null)
  }

  async function confirmPortUploadSelection() {
    if (!portUploadSelection || portUploadSelection.loading || uploadBusyKey) {
      return
    }

    const selectedExperiments = portUploadSelection.experiments.filter((entry) =>
      portUploadSelection.selectedKeys.has(`${entry.resultsScope}::${entry.name}`),
    )
    if (selectedExperiments.length === 0) {
      setErrorMessage('Select at least one finished experiment to upload.')
      return
    }

    const { port, skippedCount } = portUploadSelection
    setPortUploadSelection(null)
    await uploadExperimentsToGitHub({
      port,
      experiments: selectedExperiments,
      busyKey: `port:${port}`,
      identity: portIdentityByPort[port],
      skippedCount,
      uploadMode: githubUploadMode,
    })
  }

  async function restartTunnel(port) {
    setTunnelBusyByPort((previous) => ({ ...previous, [port]: true }))

    try {
      const response = await fetch(buildTunnelUrl('/restart'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ port }),
      })

      if (!response.ok) {
        throw new Error('Restart failed.')
      }
    } catch {
      setErrorMessage(`Unable to restart SSH tunnel for port ${port}.`)
    } finally {
      setTunnelBusyByPort((previous) => ({ ...previous, [port]: false }))
    }
  }

  const activeTunnelInfo = useMemo(
    () => tunnelState.tunnels.find((entry) => entry.port === activeApiPort) || null,
    [tunnelState.tunnels, activeApiPort],
  )

  const visiblePorts = useMemo(() => {
    const merged = [...CONFIGURED_API_PORTS, ...tunnelState.tunnels.map((entry) => entry.port)]
    return [...new Set(merged)]
  }, [tunnelState.tunnels])

  // `visiblePorts` is rebuilt every 8 s (the status poll replaces the `tunnels` array), so keying the
  // port pollers on its identity would restart them constantly. A key string that only changes when the
  // port set actually changes keeps those effects stable.
  const visiblePortsKey = useMemo(() => visiblePorts.join(','), [visiblePorts])

  // The matrix download icon now opens a two-entry menu, so it has to close like a popover.
  useEffect(() => {
    if (!matrixDownloadMenuOpen) {
      return undefined
    }

    function handlePointerDown(event) {
      if (matrixDownloadMenuRef.current && !matrixDownloadMenuRef.current.contains(event.target)) {
        setMatrixDownloadMenuOpen(false)
      }
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setMatrixDownloadMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [matrixDownloadMenuOpen])

  useEffect(() => {
    let isCancelled = false
    // Overlap guards: the 20 s poll must not stack a new round on top of one that is still running.
    let statusesInFlight = false
    let identitiesInFlight = false
    // Snapshot the ports from the stable key, so the effect depends on the key (which only changes when
    // the port set changes) instead of the array identity that the 8 s status poll replaces each time.
    const ports = visiblePortsKey ? visiblePortsKey.split(',').map(Number) : []

    async function fetchPortIdentity(port) {
      try {
        const [llmResponse, gpuResponse] = await Promise.all([
          fetchJson('/api/llm-name', port, { resultsScope: selectedResultsScope }),
          fetchJson('/api/gpu-used', port, { resultsScope: selectedResultsScope }),
        ])

        const llm = extractModelName(llmResponse)
        const modelUrl = extractModelUrl(gpuResponse)
        const gpuCount = await fetchGpuCountForPort(
          port,
          selectedResultsScope,
          modelUrl,
          llm,
        )

        return {
          llm,
          gpu: extractGpuUsed(gpuResponse),
          modelUrl,
          gpuCount,
        }
      } catch {
        return {
          llm: 'Unavailable',
          gpu: 'Unavailable',
          modelUrl: 'Unavailable',
          gpuCount: null,
        }
      }
    }

    async function refreshPortStatuses() {
      if (statusesInFlight) {
        return
      }
      statusesInFlight = true
      try {
        const statusEntries = await Promise.all(
          ports.map(async (port) => [port, await fetchExperimentStatusForPort(port)]),
        )

        if (isCancelled) {
          return
        }

        setExperimentStatusByPort((previous) => ({
          ...previous,
          ...Object.fromEntries(statusEntries),
        }))
      } finally {
        statusesInFlight = false
      }
    }

    async function refreshPortIdentities() {
      if (identitiesInFlight) {
        return
      }
      identitiesInFlight = true
      try {
        const entries = await Promise.all(
          ports.map(async (port) => [port, await fetchPortIdentity(port)]),
        )

        if (isCancelled) {
          return
        }

        setPortIdentityByPort((previous) => ({
          ...previous,
          ...Object.fromEntries(entries),
        }))
      } finally {
        identitiesInFlight = false
      }
    }

    setPortIdentityByPort((previous) => {
      const next = { ...previous }
      for (const port of ports) {
        if (!next[port]) {
          next[port] = {
            llm: 'Loading...',
            gpu: 'Loading...',
            modelUrl: 'Loading...',
            gpuCount: 'Loading...',
          }
        }
      }
      return next
    })

    setExperimentStatusByPort((previous) => {
      const next = { ...previous }
      for (const port of ports) {
        if (!next[port]) {
          next[port] = {
            isRunning: null,
            slurmJobId: null,
            logFile: null,
            logAvailable: false,
          }
        }
      }
      return next
    })

    refreshPortStatuses()
    refreshPortIdentities()
    const timer = setInterval(() => {
      refreshPortStatuses()
      refreshPortIdentities()
    }, 20000)

    return () => {
      isCancelled = true
      clearInterval(timer)
    }
  }, [visiblePortsKey, selectedResultsScope])

  // `GET /github/status` only reports whether a token and a repository are configured; the token itself
  // never reaches this bundle. Re-checking when the manager becomes reachable again keeps the upload
  // buttons honest after the manager restarts with different .env values.
  useEffect(() => {
    let isCancelled = false

    async function loadGitHubStatus() {
      try {
        const data = await fetchGitHubUploadStatus()
        if (isCancelled) {
          return
        }

        setGitHubStatus({
          loading: false,
          configured: Boolean(data.configured),
          repo: data.repo || '',
          branch: data.branch || '',
          resultsPath: data.resultsPath || '',
          message: data.message || '',
        })
      } catch {
        if (isCancelled) {
          return
        }

        setGitHubStatus({
          loading: false,
          configured: false,
          repo: '',
          branch: '',
          resultsPath: '',
          message: 'The tunnel manager is unreachable, so GitHub uploads are unavailable.',
        })
      }
    }

    loadGitHubStatus()

    return () => {
      isCancelled = true
    }
  }, [tunnelState.reachable])

  useEffect(() => {
    if (!logVisible) {
      return
    }

    let isCancelled = false

    async function loadLog() {
      setLogLoading(true)
      setLogError('')

      try {
        const data = await fetchJson('/api/experiment-log', activeApiPort, { lines: 100 })
        if (isCancelled) {
          return
        }

        setLogContent(data.content || '')
        setLogMeta({
          slurmJobId: data.slurmJobId || null,
          logFile: data.logFile || null,
          logPath: data.logPath || null,
          truncated: Boolean(data.truncated),
          returnedLines: data.returnedLines ?? null,
          requestedLines: data.requestedLines ?? null,
        })
      } catch {
        if (isCancelled) {
          return
        }

        setLogContent('')
        setLogMeta(null)
        setLogError(
          `Unable to load the log file from port ${activeApiPort}. The API or the slurm log may be unreachable.`,
        )
      } finally {
        if (!isCancelled) {
          setLogLoading(false)
        }
      }
    }

    loadLog()

    return () => {
      isCancelled = true
    }
  }, [logVisible, activeApiPort, logReloadKey])

  function getTunnelTone(tunnel) {
    if (!tunnelState.reachable) {
      return 'down'
    }
    if (!tunnel) {
      return 'warn'
    }
    if (tunnel.running && tunnel.apiHealth?.ok) {
      return 'ok'
    }
    if (tunnel.running) {
      return 'warn'
    }
    return 'down'
  }

  function getTunnelLabel(tunnel) {
    if (!tunnelState.reachable) {
      return 'Tunnel manager offline'
    }
    if (!tunnel) {
      return 'Tunnel not configured'
    }
    if (tunnel.running && tunnel.apiHealth?.ok) {
      return 'Tunnel active'
    }
    if (tunnel.running) {
      return 'Tunnel running, API unreachable'
    }
    return 'Tunnel stopped'
  }

  function getExperimentStatusLabel(status) {
    if (status?.isRunning === true) {
      return status.slurmJobId ? `Running (job ${status.slurmJobId})` : 'Running'
    }
    if (status?.isRunning === false) {
      return 'Stopped'
    }
    return 'Unknown'
  }

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <h1>MoST Dashboard</h1>
      </header>

      <section className="tunnel-strip" data-tone={getTunnelTone(activeTunnelInfo)}>
        <div className="tunnel-strip-header">
          <strong>
            Active API: {buildApiBaseUrlForPort(activeApiPort)} ({getTunnelLabel(activeTunnelInfo)})
          </strong>
          <p className="tunnel-model">Model: {headerData.llm}</p>
          <p>GPU used: {headerData.gpu}</p>
          <p>
            {activeTunnelInfo?.config
              ? `Forward ${activeTunnelInfo.config.localBind}:${activeTunnelInfo.config.localPort} to ${activeTunnelInfo.config.remoteHost}:${activeTunnelInfo.config.remotePort}`
              : tunnelState.message}
          </p>
        </div>

        <div className="tunnel-grid">
          {visiblePorts.map((port) => {
            const tunnel = tunnelState.tunnels.find((entry) => entry.port === port) || null
            const tunnelTone = getTunnelTone(tunnel)
            const restartBusy = Boolean(tunnelBusyByPort[port])
            const isSelected = port === activeApiPort
            const identity = portIdentityByPort[port] || {
              llm: 'Loading...',
              gpu: 'Loading...',
              modelUrl: 'Loading...',
              gpuCount: 'Loading...',
            }
            const experimentStatus = experimentStatusByPort[port] || {
              isRunning: null,
              slurmJobId: null,
              logFile: null,
              logAvailable: false,
            }

            return (
              <div
                className={`tunnel-card ${isSelected ? 'is-active' : ''}`}
                data-tone={tunnelTone}
                key={`tunnel-${port}`}
                role="button"
                tabIndex={0}
                onClick={() => setActiveApiPort(port)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setActiveApiPort(port)
                  }
                }}
                aria-pressed={isSelected}
                title={`View API from port ${port}`}
              >
                <div className="tunnel-card-meta">
                  <strong>{`Model: ${identity.llm}`}</strong>
                  <p className="tunnel-model">GPU used: {identity.gpu}</p>
                  <p className="tunnel-gpu-count">GPUs: {formatGpuCount(identity.gpuCount)}</p>
                  <p>{getTunnelLabel(tunnel)} (Port {port})</p>
                  <p className="experiment-status">
                    <span
                      className={`status-bubble ${
                        experimentStatus.isRunning === true
                          ? 'is-running'
                          : experimentStatus.isRunning === false
                          ? 'is-stopped'
                          : 'is-unknown'
                      }`}
                      aria-hidden="true"
                    />
                    {getExperimentStatusLabel(experimentStatus)}
                  </p>
                </div>
                <div className="tunnel-card-actions">
                  <button
                    type="button"
                    className="tunnel-refresh"
                    onClick={(event) => {
                      event.stopPropagation()
                      restartTunnel(port)
                    }}
                    disabled={restartBusy || !tunnelState.reachable}
                    title={`Restart tunnel for port ${port}`}
                  >
                    <RotateCcw size={16} />
                    {restartBusy ? 'Restarting...' : 'Restart tunnel'}
                  </button>
                  <button
                    type="button"
                    className="tunnel-upload"
                    onClick={(event) => {
                      event.stopPropagation()
                      uploadTunnelResultsToGitHub(port)
                    }}
                    disabled={
                      !githubStatus.configured ||
                      tunnelTone === 'down' ||
                      restartBusy ||
                      Boolean(uploadBusyKey) ||
                      Boolean(portUploadSelection)
                    }
                    title={
                      githubStatus.configured
                        ? `Upload every finished experiment of every completed results source of port ${port} to GitHub`
                        : githubStatus.message || 'GitHub uploads are not configured.'
                    }
                  >
                    <Upload size={16} />
                    {uploadBusyKey === `port:${port}`
                      ? 'Uploading...'
                      : portUploadSelection?.port === port
                        ? 'Selecting...'
                        : 'Upload results'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {portUploadSelection && (
        <section
          className="port-upload-selector"
          role="dialog"
          aria-labelledby="port-upload-selector-title"
        >
          <div className="port-upload-selector-header">
            <div>
              <h2 id="port-upload-selector-title">
                Select experiments for port {portUploadSelection.port}
              </h2>
              <p>
                Choose which finished experiments should be uploaded to GitHub.
              </p>
            </div>
            <button
              type="button"
              className="selector-close"
              onClick={cancelPortUploadSelection}
              disabled={portUploadSelection.loading}
              aria-label="Cancel experiment selection"
            >
              Cancel
            </button>
          </div>
          {portUploadSelection.loading ? (
            <p className="placeholder">Finding finished experiments...</p>
          ) : (
            <>
              <div className="port-upload-checklist">
                {groupUploadExperiments(portUploadSelection.experiments).map(
                  ({ resultsScope, entries }) => {
                    const groupKeys = entries.map(
                      (entry) => `${entry.resultsScope}::${entry.name}`,
                    )
                    const selectedGroupCount = groupKeys.filter((key) =>
                      portUploadSelection.selectedKeys.has(key),
                    ).length
                    const expanded = portUploadSelection.expandedScopes.has(resultsScope)

                    function updateGroupSelection(select) {
                      setPortUploadSelection((previous) => {
                        if (!previous) {
                          return previous
                        }
                        const selectedKeys = new Set(previous.selectedKeys)
                        groupKeys.forEach((key) => {
                          if (select) {
                            selectedKeys.add(key)
                          } else {
                            selectedKeys.delete(key)
                          }
                        })
                        return { ...previous, selectedKeys }
                      })
                    }

                    return (
                      <div className="port-upload-group" key={resultsScope}>
                        <div className="port-upload-group-header">
                          <button
                            type="button"
                            className="port-upload-group-toggle"
                            onClick={() => {
                              setPortUploadSelection((previous) => {
                                if (!previous) {
                                  return previous
                                }
                                const expandedScopes = new Set(previous.expandedScopes)
                                if (expandedScopes.has(resultsScope)) {
                                  expandedScopes.delete(resultsScope)
                                } else {
                                  expandedScopes.add(resultsScope)
                                }
                                return { ...previous, expandedScopes }
                              })
                            }}
                            aria-expanded={expanded}
                          >
                            <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                            <span>
                              <strong>{formatResultsScopeLabel(resultsScope)}</strong>
                              <small>
                                {selectedGroupCount} of {entries.length} sub-experiments selected
                              </small>
                            </span>
                          </button>
                          <div className="port-upload-group-actions">
                            <button
                              type="button"
                              className="port-upload-group-action"
                              onClick={() => updateGroupSelection(true)}
                              disabled={selectedGroupCount === entries.length}
                            >
                              Select all
                            </button>
                            <button
                              type="button"
                              className="port-upload-group-action"
                              onClick={() => updateGroupSelection(false)}
                              disabled={selectedGroupCount === 0}
                            >
                              Deselect all
                            </button>
                          </div>
                        </div>
                        {expanded && (
                          <div className="port-upload-group-entries">
                            {entries.map((entry) => {
                              const entryKey = `${entry.resultsScope}::${entry.name}`
                              const checked = portUploadSelection.selectedKeys.has(entryKey)
                              return (
                                <label className="port-upload-option" key={entryKey}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => {
                                      setPortUploadSelection((previous) => {
                                        if (!previous) {
                                          return previous
                                        }
                                        const selectedKeys = new Set(previous.selectedKeys)
                                        if (selectedKeys.has(entryKey)) {
                                          selectedKeys.delete(entryKey)
                                        } else {
                                          selectedKeys.add(entryKey)
                                        }
                                        return { ...previous, selectedKeys }
                                      })
                                    }}
                                  />
                                  <span>
                                    <strong>{entry.name}</strong>
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  },
                )}
              </div>
              <div className="port-upload-selector-actions">
                <span>
                  {portUploadSelection.selectedKeys.size} of {portUploadSelection.experiments.length}{' '}
                  selected
                </span>
                <button type="button" className="tunnel-upload" onClick={confirmPortUploadSelection}>
                  <Upload size={16} />
                  Upload selected experiments
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      {uploadProgress && (
        <div className="upload-progress" role="status" aria-live="polite">
          <div className="upload-progress-label">
            <span>
              {uploadProgress.phase === 'uploading'
                ? `Uploading ${uploadProgress.ready} file(s) to GitHub...`
                : uploadProgress.phase === 'preparing'
                  ? `Preparing result files for ${uploadProgress.subExperiment || uploadProgress.experiment}${
                      uploadProgress.groupCount > 1
                        ? ` (source ${(uploadProgress.preparedGroups || 0) + 1} of ${uploadProgress.groupCount})`
                        : ''
                    }...`
                  : uploadProgress.total > 0
                    ? `Preparing upload: ${uploadProgress.ready} of ${uploadProgress.total} file(s) ready`
                    : 'Preparing upload: finding result files...'}
            </span>
            {(uploadProgress.total > 0 || uploadProgress.groupCount > 0) && (
              <span>
                {(
                  Math.floor(uploadProgressFraction(uploadProgress) * 1000 + Number.EPSILON * 1000) / 10
                ).toFixed(1)}
                %
              </span>
            )}
          </div>
          {(uploadProgress.experiment || uploadProgress.subExperiment) && (
              <div className="upload-progress-current">
                {uploadProgress.experiment && `Experiment: ${uploadProgress.experiment}`}
                {uploadProgress.subExperiment && ` · Sub-experiment: ${uploadProgress.subExperiment}`}
              </div>
          )}
          <progress
            value={Math.round(uploadProgressFraction(uploadProgress) * 100)}
            max={100}
            aria-label="GitHub upload file preparation progress"
          />
        </div>
      )}

      {uploadNotice && (
        <div className="upload-banner" role="status">
          <span>{uploadNotice.text}</span>
          {uploadNotice.commitUrl && (
            <a href={uploadNotice.commitUrl} target="_blank" rel="noreferrer">
              {uploadNotice.unchanged
                ? `Existing commit ${uploadNotice.commitLabel}`
                : `Commit ${uploadNotice.commitLabel}`}
            </a>
          )}
        </div>
      )}

      <main className={`dashboard-main ${isAdditiveMode ? 'is-additive' : ''}`}>
        <aside className="experiment-panel">
          <div className="experiment-panel-header">
            <h2>
              {isAdditiveMode
                ? `${matrixExperimentType ? `${matrixExperimentType} ` : ''}Additive Experiments`
                : matrixExperimentType
                  ? `${matrixExperimentType} Experiments Matrix`
                  : 'Experiments Matrix'}
            </h2>
            <div className="button-group">
              <label className="upload-mode-control">
                <span>GitHub upload</span>
                <select
                  value={githubUploadMode}
                  onChange={(event) => setGitHubUploadMode(event.target.value)}
                  disabled={Boolean(uploadBusyKey)}
                  aria-label="GitHub upload mode"
                >
                  <option value="update">Update (missing iterations only)</option>
                  <option value="full">Full upload</option>
                </select>
              </label>
              <div className="download-menu-wrapper" ref={matrixDownloadMenuRef}>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setMatrixDownloadMenuOpen((previous) => !previous)}
                  title={
                    isAdditiveMode ? 'Download additive results' : 'Download matrix results'
                  }
                  aria-label={
                    isAdditiveMode ? 'Download additive results' : 'Download matrix results'
                  }
                  aria-haspopup="menu"
                  aria-expanded={matrixDownloadMenuOpen}
                  data-active={matrixDownloadMenuOpen}
                  disabled={downloadableExperiments.length === 0 || busyMatrixDownload}
                >
                  <Download size={16} />
                </button>
                {matrixDownloadMenuOpen && (
                  <div className="download-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="download-menu-item"
                      onClick={() => {
                        setMatrixDownloadMenuOpen(false)
                        downloadMatrixCsvZip()
                      }}
                    >
                      ZIP (folder structure)
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="download-menu-item"
                      onClick={() => {
                        setMatrixDownloadMenuOpen(false)
                        downloadMatrixMergedCsv()
                      }}
                    >
                      Merged CSV (single file)
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="download-menu-item"
                      onClick={() => {
                        setMatrixDownloadMenuOpen(false)
                        downloadMatrixResultsFromJsonCsvZip()
                      }}
                    >
                      results_from_json.csv (folder structure)
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="download-menu-item"
                      onClick={() => {
                        setMatrixDownloadMenuOpen(false)
                        uploadPanelResultsToGitHub()
                      }}
                      disabled={
                        !githubStatus.configured ||
                        uploadBusyKey !== '' ||
                        busyMatrixDownload
                      }
                      title={
                        githubStatus.configured
                          ? 'Upload every finished experiment of every completed results source to GitHub'
                          : githubStatus.message || 'GitHub uploads are not configured.'
                      }
                    >
                      {uploadBusyKey === 'matrix-completed'
                        ? 'Uploading to GitHub...'
                        : 'Upload to GitHub (folder structure)'}
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => selectedExperiment && downloadExperimentCsvZip(selectedExperiment)}
                title={isAdditiveMode ? 'Download selected mix CSV zip' : 'Download selected cell CSV zip'}
                aria-label={
                  isAdditiveMode ? 'Download selected mix CSV zip' : 'Download selected cell CSV zip'
                }
                disabled={!selectedExperiment || busyExperimentDownload === selectedExperiment}
              >
                <FileDown size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={uploadMatrixResultsToGitHub}
                title={buildMatrixUploadTitle(
                  githubStatus.configured,
                  isAdditiveMode,
                  githubStatus.message,
                  viewedScopeUploadable,
                )}
                aria-label={buildMatrixUploadAriaLabel(isAdditiveMode, viewedScopeUploadable)}
                disabled={
                  !githubStatus.configured ||
                  uploadBusyKey !== '' ||
                  busyMatrixDownload ||
                  !viewedScopeUploadable ||
                  finishedDownloadableExperiments.length === 0
                }
              >
                <Upload size={16} />
              </button>
            </div>
          </div>
          <div className="results-scope-picker">
            <label htmlFor="results-scope-select">Results source</label>
            <select
              id="results-scope-select"
              value={selectedResultsScope}
              onChange={(event) => setSelectedResultsScope(event.target.value)}
            >
              {resultsScopeOptions.map((scope) => (
                <option key={`scope-${scope}`} value={scope}>
                  {formatResultsScopeLabel(scope)}
                </option>
              ))}
            </select>
          </div>
          <p className="matrix-helper">
            {isAdditiveMode
              ? 'Rows: input intervals. Columns: output intervals. Every combination of VITE_EXPERIMENT_LIST is shown; the cells the selected mix uses are highlighted with the alpha that mix assigns to them.'
              : 'Rows: input intervals. Columns: output intervals. Cells show absolute (top) and inverse-normalized (bottom) values.'}
          </p>

          {isAdditiveMode ? (
            additiveExperiments.length === 0 ? (
              <p className="placeholder">No additive experiments found.</p>
            ) : (
              <div className="additive-layout">
                <div className="additive-list">
                  {additiveExperiments.map((entry) => {
                    const status = experimentStatuses[entry.name]
                    const isSelected = entry.name === selectedExperiment
                    const hasValue = Number.isFinite(status?.largestTrue)
                    const absoluteValue = hasValue ? status.largestTrue : null
                    const absoluteText = absoluteValue !== null ? formatMatrixValue(absoluteValue) : ''
                    const itemExperimentType = status?.hasResults
                      ? status?.experimentType || matrixExperimentType
                      : null

                    let backgroundColor = '#ffffff'
                    let tone = 'empty'

                    if (status?.hasResults && !status?.finished) {
                      backgroundColor = '#ffd1e3'
                      tone = 'pending'
                    } else if (status?.hasResults && status?.finished) {
                      backgroundColor = getHeatmapColor(absoluteValue, heatScale.min, heatScale.max)
                      tone = 'finished'
                    }

                    return (
                      <button
                        key={`additive-${entry.name}`}
                        type="button"
                        className={`additive-item ${isSelected ? 'is-selected' : ''}`}
                        data-tone={tone}
                        style={{ backgroundColor, color: getTextColorForBackground(backgroundColor) }}
                        onClick={() => setSelectedExperiment(entry.name)}
                        title={entry.name}
                      >
                        <span className="additive-item-canonical">{formatAdditiveLabel(entry)}</span>
                        <span className="additive-item-value">
                          {itemExperimentType ? `${itemExperimentType}: ` : ''}
                          {absoluteText}
                        </span>
                        {comparisonScope && (
                          <span className="additive-item-comparison">
                            <ComparisonMetrics
                              comparison={comparisonByMix[entry.name]}
                              only={ADDITIVE_ITEM_METRIC_LABELS}
                            />
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
                <div className="additive-matrix-column">
                  <div className="comparison-picker">
                    <label htmlFor="comparison-scope-select">MIT/MST results to compare</label>
                    <select
                      id="comparison-scope-select"
                      value={comparisonScope}
                      onChange={(event) => setComparisonScope(event.target.value)}
                      disabled={comparisonScopeOptions.length === 0}
                    >
                      {comparisonScopeOptions.length === 0 && (
                        <option value="">{`No ${additiveExperimentType} results source`}</option>
                      )}
                      <option value="">None</option>
                      {comparisonScopeOptions.map((scope) => (
                        <option key={`comparison-scope-${scope}`} value={scope}>
                          {formatResultsScopeLabel(scope)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="experiment-matrix-wrapper">
                    {displayedAdditiveInputRanges.length === 0 || additiveMatrixModel.outputRanges.length === 0 ? (
                      <p className="placeholder">
                        No workload profile intervals found for this results source.
                      </p>
                    ) : (
                      <div
                        className="experiment-matrix additive-matrix"
                        style={{
                          gridTemplateColumns: `minmax(68px, 1.2fr) repeat(${additiveMatrixModel.outputRanges.length}, minmax(0, 1fr))`,
                        }}
                      >
                        {displayedAdditiveInputRanges.map((inputRange) => (
                          <Fragment key={`additive-matrix-row-${inputRange}`}>
                            <div className="matrix-header matrix-row-header">
                              {formatIntervalLabel(inputRange)}
                            </div>
                            {additiveMatrixModel.outputRanges.map((outputRange) => {
                              const pairKey = `${inputRange}__${outputRange}`
                              const alpha = selectedAdditiveCellAlphaByKey[pairKey]
                              const isUsed = Number.isFinite(alpha)

                              return (
                                <div
                                  key={`additive-${inputRange}-${outputRange}`}
                                  className="matrix-cell"
                                  data-tone={isUsed ? 'mix' : 'empty'}
                                  style={isUsed ? { backgroundColor: ADDITIVE_MIX_CELL_COLOR } : undefined}
                                  title={
                                    isUsed
                                      ? `${selectedExperimentLabel} · alpha=${formatAdditiveAlpha(alpha)}`
                                      : 'Not used by the selected mix'
                                  }
                                >
                                  <span className="matrix-cell-values">
                                    <span className="matrix-cell-subvalue">
                                      {isUsed ? formatAdditiveAlpha(alpha) : ''}
                                    </span>
                                  </span>
                                </div>
                              )
                            })}
                          </Fragment>
                        ))}

                        <div className="matrix-corner matrix-footer-corner">
                          <span className="matrix-corner-label matrix-corner-label-input">Input</span>
                          <span className="matrix-corner-label matrix-corner-label-output">Output</span>
                        </div>
                        {additiveMatrixModel.outputRanges.map((outputRange) => (
                          <div
                            className="matrix-header matrix-col-footer"
                            key={`additive-footer-${outputRange}`}
                          >
                            {formatIntervalLabel(outputRange)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="comparison-summary">
                    <p className="comparison-summary-title">
                      {comparisonScope
                        ? `Comparison · ${selectedExperimentLabel} vs ${formatResultsScopeLabel(comparisonScope)}`
                        : 'Comparison'}
                    </p>
                    {comparisonScope ? (
                      <>
                        <div className="comparison-summary-values">
                          <ComparisonMetrics comparison={selectedComparison} />
                        </div>
                        <p className="comparison-summary-note">
                          {`Sigma = ${formatComparisonValue(selectedComparison?.scopeSigma)} (largest MIT/MST value of the source)`}
                          {` · true throughput = ${formatComparisonValue(selectedComparison?.trueThroughput)}`}
                        </p>
                        {selectedComparison?.missingProfiles?.length > 0 && (
                          <p className="comparison-summary-note">
                            {'Profiles without a MIT/MST measurement (every profile is needed for the expected values): '}
                            {selectedComparison.missingProfiles.join(', ')}
                          </p>
                        )}
                        {loadingComparison && (
                          <p className="comparison-summary-note">Loading comparison results...</p>
                        )}
                      </>
                    ) : (
                      <p className="comparison-summary-note">
                        {comparisonScopeOptions.length > 0
                          ? `Select an ${additiveExperimentType} results source above to compare the expected and true values of every mix.`
                          : `No Experiment_${additiveExperimentType}_* results source found for this additive run.`}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )
          ) : matrixModel.inputRanges.length === 0 || matrixModel.outputRanges.length === 0 ? (
            <p className="placeholder">No interval-pair experiments found.</p>
          ) : (
            <div className="experiment-matrix-wrapper">
              <div
                className="experiment-matrix"
                style={{
                  gridTemplateColumns: `minmax(68px, 1.2fr) repeat(${matrixModel.outputRanges.length}, minmax(0, 1fr))`,
                }}
              >
                {displayedInputRanges.map((inputRange) => (
                  <Fragment key={`matrix-row-${inputRange}`}>
                    <div className="matrix-header matrix-row-header" key={`row-${inputRange}`}>
                      {formatIntervalLabel(inputRange)}
                    </div>
                    {matrixModel.outputRanges.map((outputRange) => {
                      const pairKey = `${inputRange}__${outputRange}`
                      const experiment = matrixModel.pairMap[pairKey] || null
                      const status = experiment ? experimentStatuses[experiment] : null
                      const isSelected = experiment === selectedExperiment
                      const hasValue = Number.isFinite(status?.largestTrue)
                      const absoluteValue = hasValue ? status.largestTrue : null
                      const inverseNormalizedValue = hasValue
                        ? getInverseNormalizedValue(status.largestTrue)
                        : null
                      const absoluteText = absoluteValue !== null ? formatMatrixValue(absoluteValue) : ''
                      const cellExperimentType = status?.hasResults
                        ? status?.experimentType || matrixExperimentType
                        : null
                      const inverseText = hasValue
                        ? inverseNormalizedValue === null
                          ? 'n/a'
                          : formatMatrixValue(inverseNormalizedValue)
                        : ''

                      let backgroundColor = '#ffffff'
                      let tone = 'empty'

                      if (status?.hasResults && !status?.finished) {
                        backgroundColor = '#ffd1e3'
                        tone = 'pending'
                      } else if (status?.hasResults && status?.finished) {
                        backgroundColor = getHeatmapColor(absoluteValue, heatScale.min, heatScale.max)
                        tone = 'finished'
                      }

                      return (
                        <button
                          key={`${inputRange}-${outputRange}`}
                          type="button"
                          className={`matrix-cell ${isSelected ? 'is-selected' : ''}`}
                          data-tone={tone}
                          style={{ backgroundColor, color: getTextColorForBackground(backgroundColor) }}
                          onClick={() => experiment && setSelectedExperiment(experiment)}
                          disabled={!experiment}
                          title={experiment || 'No experiment mapped for this pair'}
                        >
                          <span className="matrix-cell-values">
                            <span className="matrix-cell-subvalue">{cellExperimentType ? `${cellExperimentType}: ` : ''}{absoluteText}</span>
                            <span className="matrix-cell-subvalue">&sigma;: {inverseText}</span>
                          </span>
                        </button>
                      )
                    })}
                  </Fragment>
                ))}

                <div className="matrix-corner matrix-footer-corner">
                  <span className="matrix-corner-label matrix-corner-label-input">Input</span>
                  <span className="matrix-corner-label matrix-corner-label-output">Output</span>
                </div>
                {matrixModel.outputRanges.map((outputRange) => (
                  <div className="matrix-header matrix-col-footer" key={`footer-${outputRange}`}>
                    {formatIntervalLabel(outputRange)}
                  </div>
                ))}
              </div>
            </div>
          )}
          {loadingMatrixStatus && (
            <p className="matrix-loading">
              {isAdditiveMode ? 'Updating additive status...' : 'Updating matrix status...'}
            </p>
          )}
        </aside>

        <section className="chart-panel">
          <div className="chart-header">
            <h2>
              {selectedExperimentType
                ? `${selectedExperimentType} · ${selectedExperimentLabel}`
                : selectedExperimentLabel}
            </h2>
            <div className="chart-legend">
              <span><i className="dot stage-1" />Stage 1</span>
              <span><i className="dot stage-2" />Stage 2</span>
            </div>
          </div>

          <div className="chart-wrapper" ref={chartWrapperRef}>
            {loadingIterations ? (
              <p className="placeholder">Loading iteration metrics...</p>
            ) : iterationData.length === 0 ? (
              <p className="placeholder">No iterations available for this experiment.</p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={380}>
                  <ComposedChart
                    data={iterationData}
                    margin={{ top: 16, right: 16, left: 8, bottom: 8 }}
                    onMouseLeave={handleChartMouseLeave}
                  >
                    <CartesianGrid strokeDasharray="4 6" stroke="#d2dce5" />
                    <XAxis
                      type="number"
                      dataKey="index"
                      domain={[1, 'dataMax']}
                      label={{ value: 'Iteration Number', position: 'insideBottom', offset: -4 }}
                      allowDecimals={false}
                    />
                    <YAxis label={{ value: 'Requests/minute', angle: -90, position: 'insideLeft' }} />
                    <Line
                      type="linear"
                      dataKey="stage1ReqMin"
                      stroke={STAGE_ONE_COLOR}
                      strokeWidth={2.6}
                      connectNulls
                      dot={false}
                    />
                    <Line
                      type="linear"
                      dataKey="stage2ReqMin"
                      stroke={STAGE_TWO_COLOR}
                      strokeWidth={2.6}
                      connectNulls
                      dot={false}
                    />
                    <Scatter
                      dataKey="reqMin"
                      data={iterationData}
                      shape={(props) => (
                        <CustomNode
                          {...props}
                          onHover={handlePointHover}
                          onHoverEnd={handlePointHoverEnd}
                          onSelect={handleSelectPoint}
                        />
                      )}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
                {hoveredSummary && (
                  <div
                    className="custom-tooltip-overlay"
                    style={{ left: `${hoveredSummary.position.x}px`, top: `${hoveredSummary.position.y}px` }}
                  >
                    <IterationSummary point={hoveredSummary.point} />
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </main>

      <section className="detail-panel">
        <div className="detail-header">
          <div>
            <h2>Iteration Detail</h2>
            <p>
              {selectedPoint
                ? `Iteration ${selectedPoint.index} - ${selectedPoint.dateLabel}`
                : 'Select a point in the chart'}
            </p>
          </div>
          <div className="detail-actions">
            <button
              type="button"
              onClick={() => downloadIterationFile('results.csv')}
              disabled={!selectedIteration}
              className="icon-button"
              title="Download results.csv"
            >
              <FileDown size={16} />
            </button>
            <button
              type="button"
              onClick={() => downloadIterationFile('results.json')}
              disabled={!selectedIteration}
              className="icon-button"
              title="Download results.json"
            >
              <Download size={16} />
            </button>
            <button
              type="button"
              onClick={() => downloadIterationFile('results_from_json.csv')}
              disabled={!selectedIteration}
              className="icon-button"
              title="Download results_from_json.csv"
            >
              <Download size={16} />
            </button>
          </div>
        </div>

        <div className="table-wrapper">
          {tableColumns.length === 0 ? (
            <p className="placeholder">Click an iteration node to inspect all results.csv fields.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  {tableColumns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selectedIterationRows.map((row, rowIndex) => (
                  <tr key={`${rowIndex}-${selectedIteration}`}>
                    {tableColumns.map((column) => (
                      <td key={`${rowIndex}-${column}`}>{row[column] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="log-panel">
        <div className="log-panel-header">
          <div>
            <h2>Job Log</h2>
            {logLoading ? (
              <p>Loading the latest log...</p>
            ) : logMeta || logContent || logError ? (
              <p>
                {logMeta
                  ? `${logMeta.logFile || 'slurm log'} (job ${logMeta.slurmJobId ?? '?'})${
                      logMeta.truncated ? ' · last 100 lines (truncated)' : ''
                    }`
                  : logError || 'No log file available.'}
              </p>
            ) : (
              <p>Display the latest slurm log file for the active API.</p>
            )}
          </div>
          <div className="log-actions">
            <button
              type="button"
              className="log-toggle-button"
              onClick={() => setLogVisible((previous) => !previous)}
              aria-expanded={logVisible}
            >
              <Terminal size={16} />
              {logVisible ? 'Hide log' : 'View log'}
            </button>
            {logVisible && (
              <button
                type="button"
                className="log-refresh-button"
                onClick={() => setLogReloadKey((previous) => previous + 1)}
                disabled={logLoading}
                title="Reload the latest log"
              >
                <RefreshCw size={16} />
                Reload
              </button>
            )}
          </div>
        </div>

        {logVisible && (
          <div className="log-view">
            {logLoading ? (
              <p className="placeholder">Loading log...</p>
            ) : logError ? (
              <p className="placeholder">{logError}</p>
            ) : (
              <pre className="log-content">{logContent || 'The log file is empty.'}</pre>
            )}
          </div>
        )}
      </section>

      <section className="request-timeline-panel">
        <div className="request-timeline-header">
          <div>
            <h2>Requests in flight</h2>
            <p>
              {requestTimelineCalculatedFor === selectedIteration && selectedIteration
                ? requestMetric === 'cumulative'
                  ? `Cumulative requests sent during iteration ${selectedIteration}`
                  : requestMetric === 'total'
                    ? `Total concurrent requests during iteration ${selectedIteration}`
                    : `Concurrent requests by workload during iteration ${selectedIteration}`
                : selectedIteration
                  ? 'Calculate the request timeline for the selected iteration'
                  : 'Select an iteration to inspect concurrent requests'}
            </p>
          </div>
          <div className="request-timeline-actions">
            <button
              type="button"
              className="request-timeline-calculate"
              onClick={calculateRequestTimeline}
              disabled={!selectedIteration || requestTimelineLoading}
            >
              {requestTimelineLoading
                ? 'Calculating...'
                : requestTimelineCalculatedFor === selectedIteration
                  ? 'Recalculate'
                  : 'Calculate requests in flight'}
            </button>
            <label className="request-timeline-picker">
              <span>Request information</span>
              <select
                value={requestMetric}
                onChange={(event) => setRequestMetric(event.target.value)}
                disabled={requestTimeline.profiles.length === 0}
              >
                <option value="concurrent">Concurrent by workload</option>
                <option value="total">Total concurrent</option>
                <option value="cumulative">Cumulative sent</option>
              </select>
            </label>
          </div>
        </div>

        <div className="request-timeline-chart">
          {requestTimelineLoading ? (
            <p className="placeholder">Loading request timeline...</p>
          ) : requestTimeline.data.length === 0 ? (
            <p className="placeholder">
              No request timing data is available for this iteration.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={330}>
              <ComposedChart
                data={requestTimeline.data}
                margin={{ top: 16, right: 18, left: 8, bottom: 12 }}
              >
                <CartesianGrid strokeDasharray="4 6" stroke="#d2dce5" />
                <XAxis
                  type="number"
                  dataKey="time"
                  domain={[0, 'dataMax']}
                  label={{ value: 'Time (seconds)', position: 'insideBottom', offset: -6 }}
                  tickFormatter={(value) => `${value}s`}
                />
                <YAxis
                  allowDecimals={false}
                  label={{
                    value: requestMetric === 'cumulative' ? 'Requests sent' : 'Requests ongoing',
                    angle: -90,
                    position: 'insideLeft',
                  }}
                />
                <Tooltip
                  formatter={(value, name) => [
                    value,
                    name === 'total'
                      ? 'Total requests'
                      : requestMetric === 'cumulative'
                        ? `${name} requests sent`
                        : name,
                  ]}
                  labelFormatter={(value, payload) =>
                    payload?.[0]?.payload?.displayTime
                      ? `${payload[0].payload.displayTime} (${value}s)`
                      : `${value}s`
                  }
                />
                <Legend
                  formatter={(value) => (value === 'total' ? 'Total requests' : value)}
                />
                {requestMetric === 'total' ? (
                  <Line
                    type="stepAfter"
                    dataKey="total"
                    name="total"
                    stroke="#111827"
                    strokeWidth={2.8}
                    dot={false}
                  />
                ) : requestMetric === 'cumulative' ? (
                  requestTimeline.profiles.map((profile, index) => (
                    <Line
                      type="stepAfter"
                      dataKey={(entry) => entry.cumulative[profile]}
                      name={profile}
                      key={profile}
                      stroke={WORKLOAD_PROFILE_COLORS[index % WORKLOAD_PROFILE_COLORS.length]}
                      strokeWidth={2.4}
                      dot={false}
                    />
                  ))
                ) : (
                  requestTimeline.profiles.map((profile, index) => (
                    <Line
                      type="stepAfter"
                      dataKey={profile}
                      name={profile}
                      key={profile}
                      stroke={WORKLOAD_PROFILE_COLORS[index % WORKLOAD_PROFILE_COLORS.length]}
                      strokeWidth={2.4}
                      dot={false}
                    />
                  ))
                )}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>
    </div>
  )
}

export default App
