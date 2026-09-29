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
} from 'recharts'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import { Download, FileDown, RefreshCw, RotateCcw, Terminal } from 'lucide-react'
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

function formatResultsScopeLabel(scope) {
  if (!scope || scope === DEFAULT_RESULTS_SCOPE) {
    return 'Current results'
  }

  return scope
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

async function fetchJson(pathname, port, queryParams = {}) {
  const response = await fetch(buildApiUrl(pathname, port, queryParams))
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

function App() {
  const chartWrapperRef = useRef(null)
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
  const [hoveredSummary, setHoveredSummary] = useState(null)
  const [loadingIterations, setLoadingIterations] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [busyExperimentDownload, setBusyExperimentDownload] = useState('')
  const [busyMatrixDownload, setBusyMatrixDownload] = useState(false)
  const [experimentStatuses, setExperimentStatuses] = useState({})
  const [loadingMatrixStatus, setLoadingMatrixStatus] = useState(false)
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

  useEffect(() => {
    let isMounted = true

    async function refreshTunnelStatus() {
      try {
        const response = await fetch(buildTunnelUrl('/status'))
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

  async function appendExperimentCsvToZip(experiment, zip) {
    const iterationResponse = await fetchJson(
      `/api/experiments/${encodeURIComponent(experiment)}/iterations`,
      activeApiPort,
      { resultsScope: selectedResultsScope },
    )
    const iterations = iterationResponse.iterations || []
    let fileCount = 0

    for (const iterationName of iterations) {
      const endpoint = `/api/experiments/${encodeURIComponent(experiment)}/iterations/${encodeURIComponent(iterationName)}/download/results.csv`
      const response = await fetch(
        buildApiUrl(endpoint, activeApiPort, { resultsScope: selectedResultsScope }),
      )
      if (!response.ok) {
        continue
      }

      const csvBlob = await response.blob()
      zip.file(`${experiment}/${iterationName}/results.csv`, csvBlob)
      fileCount += 1
    }

    return fileCount
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
      if (matrixExperiments.length === 0) {
        setErrorMessage('No matrix experiments available to download.')
        return
      }

      const zip = new JSZip()
      let fileCount = 0

      for (const experiment of matrixExperiments) {
        try {
          fileCount += await appendExperimentCsvToZip(experiment, zip)
        } catch {
          continue
        }
      }

      if (fileCount === 0) {
        setErrorMessage('No results.csv files found for the matrix.')
        return
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' })
      saveAs(zipBlob, 'matrix-iterations-results-csv.zip')
    } catch {
      setErrorMessage(`Unable to build matrix zip on port ${activeApiPort}.`)
    } finally {
      setBusyMatrixDownload(false)
    }
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

  useEffect(() => {
    let isCancelled = false

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
      const statusEntries = await Promise.all(
        visiblePorts.map(async (port) => [port, await fetchExperimentStatusForPort(port)]),
      )

      if (isCancelled) {
        return
      }

      setExperimentStatusByPort((previous) => ({
        ...previous,
        ...Object.fromEntries(statusEntries),
      }))
    }

    async function refreshPortIdentities() {
      const entries = await Promise.all(
        visiblePorts.map(async (port) => [port, await fetchPortIdentity(port)]),
      )

      if (isCancelled) {
        return
      }

      setPortIdentityByPort((previous) => ({
        ...previous,
        ...Object.fromEntries(entries),
      }))
    }

    setPortIdentityByPort((previous) => {
      const next = { ...previous }
      for (const port of visiblePorts) {
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
      for (const port of visiblePorts) {
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
  }, [visiblePorts, selectedResultsScope])

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
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}

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
              <button
                type="button"
                className="icon-button"
                onClick={downloadMatrixCsvZip}
                title={
                  isAdditiveMode
                    ? 'Matrix CSV zip is unavailable for additive results'
                    : 'Download matrix CSV zip'
                }
                aria-label={
                  isAdditiveMode
                    ? 'Matrix CSV zip is unavailable for additive results'
                    : 'Download matrix CSV zip'
                }
                disabled={matrixExperiments.length === 0 || busyMatrixDownload}
              >
                <Download size={16} />
              </button>
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
                      </button>
                    )
                  })}
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
    </div>
  )
}

export default App
