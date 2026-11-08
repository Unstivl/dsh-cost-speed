/**
 * Cost and speed monitor, host half.
 *
 * Captures every LLM call the process makes - live, through the `llm/stream`
 * waterfall, and retroactively, by replaying the in-memory session logs - turns
 * token counts into RMB with a user-editable price table, keeps 1-minute
 * buckets plus a durable ledger, and serves the result to the browser half over
 * a small set of plain HTTP routes on the webserver service.
 *
 * Persistence goes through plain `node:fs`, not the agent-facing `fs` service:
 * a host-plane plugin runs in the real Node process, while that service is
 * scoped to the session's workspace-write sandbox and refuses the DSH home.
 * @see @deepseek-ai/dsh-session-persistence-jsonl for the same split.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
// Real DeepSeek V4 BPE, ported from dsh-live-token-stats (MIT). Imported
// eagerly so a missing data file surfaces at boot, not on the first token.
import { tokenCount } from './tokenizer/bpe.js'
import { EMPTY_INCREMENTAL, incrementalFeed } from './tokenizer/incremental.js'
import { EMPTY_UNESCAPE, unescapeFeed } from './tokenizer/unescape.js'

const MIN_STEP_MS = 60000
const HOUR_MS = 3600000
const DAY_MS = 86400000
const RETENTION_DAYS = 400
const LEDGER_MAX = 200000
const MARKER = 'dsh-cost-speed@0.2.0'
const BASE_PATH = '/dsh-cost-speed'
const SNAPSHOT_PATH = BASE_PATH + '/snapshot'
const CONFIG_PATH = BASE_PATH + '/config'
const SELFTEST_PATH = BASE_PATH + '/selftest'
const BACKFILL_LOOKBACK_MS = RETENTION_DAYS * DAY_MS
// The hour view spans this many one-minute buckets (a one-hour window).
const HOUR_WINDOW_MIN = 60
// Two captures within this window that report byte-identical token counts are
// the same API call seen twice (live tap + session-log replay), not two calls.
const SIG_TOL_MS = 5000
// Models below this spend in a window are recorded but not listed, so a long
// tail of near-zero experiments cannot bury the models that cost real money.
const MODEL_TRIVIAL_YUAN = 0.1
/**
 * Display labels for models whose wire name differs from the name users know.
 *
 * The DeepSeek official API serves `deepseek-flash` and its legacy aliases from
 * V4.1-Flash, but usage events still report the old wire names. Without this map
 * the same model appears as two rows and its spend splits.
 *
 * Presentation only: capture, pricing and dedup stay on the reported name, so a
 * future rename cannot corrupt stored history.
 */
const DISPLAY_NAME = new Map([
  ['deepseek-flash', 'DeepSeek-V4.1-Flash'],
  ['deepseek-v4-flash', 'DeepSeek-V4.1-Flash'],
  ['deepseek-v4-flash-vision-exp', 'DeepSeek-V4.1-Flash']
])

/**
 * Human-facing label for one model key.
 *
 * Keys arrive in two shapes: live capture stores "provider/model", imported
 * bills store the bare model name. Both denote the same model, so the label
 * normalises them into one row. The provider prefix is dropped unless two
 * providers price the same model differently or one route is free; then a
 * suffix keeps the rate cards apart.
 */
const PROVIDER_SUFFIX = new Map([
  ['deepseek-official', '（官方 API）']
])

function displayLabel(key) {
  const slash = key.lastIndexOf('/')
  const provider = slash < 0 ? null : key.slice(0, slash)
  const model = slash < 0 ? key : key.slice(slash + 1)
  const mapped = DISPLAY_NAME.get(model)
  const name = mapped === undefined ? model : mapped
  if (provider === null) return name
  const suffix = PROVIDER_SUFFIX.get(provider)
  return suffix === undefined ? name : name + suffix
}

const OFFICIAL_PEAK = {
  multiplier: 2,
  // Beijing time Mon-Fri 09:00-12:00 and 14:00-18:00 (the pricing page says
  // 北京时间周一至周五 9:00-12:00、14:00-18:00); off-peak is half, all other hours.
  windows: [[9, 12], [14, 18]],
  weekdaysOnly: true,
  timezoneOffsetMinutes: 480
}

const DEFAULT_CONFIG = {
  note: '默认价（元 / 百万 tokens），只是示例：请按你的服务商账单改成实际价格。DeepSeek 官方 API 空闲价为输入 1 / 输出 4 / 缓存命中 0.02；高峰（北京时间周一至周五 9:00-12:00、14:00-18:00）翻倍。未匹配到的模型只统计 token、不计金额。价格可在停靠面板里编辑，保存后写入 ~/.dsh/cost-monitor/pricing.json。',
  rules: [
    { provider: 'deepseek-official', model: 'deepseek-flash', price: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 4 }, peak: OFFICIAL_PEAK, note: 'DeepSeek 官方 API：空闲 1/4/0.02，高峰翻倍' },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', price: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 4 }, peak: OFFICIAL_PEAK, note: '官方兼容名：路由至 V4.1-Flash' },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', price: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 4 }, peak: OFFICIAL_PEAK, note: '官方兼容名：路由至 V4.1-Flash' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', price: { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 13.5 }, peak: OFFICIAL_PEAK, note: '官方 API V4-Pro：空闲 4.5/13.5/0.15，高峰翻倍' },
    { provider: '*', model: '*', price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, note: '兜底：0 = 未计价，只统计 token' }
  ]
}

function positive(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Loopback and request-origin checks for the plugin's local HTTP surface.
 *
 * The webserver registers raw route handlers and performs no authentication or
 * CORS checks of its own. Without these checks any web page could POST to
 * 127.0.0.1 with a simple `text/plain` request and rewrite the price table or
 * replace the imported bill history. Browsers attach `Origin` to such writes,
 * and modern browsers also send `Sec-Fetch-Site`; comparing the two against
 * `Host` rejects the request before the body is parsed.
 *
 * When the server is bound to a loopback address the `Host` header must name a
 * loopback host as well, which also blocks DNS-rebinding pages. Requests from
 * local scripts (curl, the CLI) carry no `Origin` and remain allowed.
 */
function isLoopbackAddress(value) {
  const address = String(value === undefined || value === null ? '' : value).toLowerCase()
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true
  if (address.startsWith('::ffff:')) return address.slice(7).startsWith('127.')
  return address.startsWith('127.')
}

function hostNameOf(hostHeader) {
  if (typeof hostHeader !== 'string') return ''
  if (hostHeader.startsWith('[')) {
    const close = hostHeader.indexOf(']')
    return close > 0 ? hostHeader.slice(0, close + 1) : hostHeader
  }
  const colon = hostHeader.lastIndexOf(':')
  return colon > 0 ? hostHeader.slice(0, colon) : hostHeader
}

function isLoopbackHost(hostHeader) {
  const raw = String(hostHeader).toLowerCase()
  if (raw === '127.0.0.1' || raw === 'localhost' || raw === '::1' || raw === '[::1]') return true
  const name = hostNameOf(raw)
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]'
}

function isTrustedRequest(req, loopbackOnly = false) {
  const headers = req !== null && typeof req === 'object' && req.headers !== undefined && req.headers !== null
    ? req.headers
    : {}
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const host = headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  const origin = headers.origin
  if (origin !== undefined) {
    if (typeof origin !== 'string' || origin.length === 0) return false
    try {
      if (new URL(origin).host !== host) return false
    } catch (error) {
      return false
    }
  }
  if (loopbackOnly) {
    if (!isLoopbackHost(host)) return false
    const remote = req.socket !== undefined && req.socket !== null ? req.socket.remoteAddress : undefined
    if (typeof remote === 'string' && remote.length > 0 && !isLoopbackAddress(remote)) return false
  }
  return true
}

function sanitizeRules(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue
    const price = raw.price !== null && typeof raw.price === 'object' ? raw.price : {}
    const hours = Array.isArray(raw.hours)
      ? raw.hours.slice(0, 24).map((h) => {
        const v = Number(h)
        return Number.isFinite(v) && v >= 0 ? v : 1
      })
      : null
    // Peak/off-peak schedule (see hourMultiplier). Kept only when it names at
    // least one usable window, so a malformed schedule degrades to "always base".
    let peak = null
    if (raw.peak !== null && typeof raw.peak === 'object') {
      const windows = Array.isArray(raw.peak.windows)
        ? raw.peak.windows
          .filter((w) => Array.isArray(w) && w.length >= 2
            && Number.isFinite(Number(w[0])) && Number.isFinite(Number(w[1])))
          .map((w) => [Number(w[0]), Number(w[1])])
        : []
      const mult = Number(raw.peak.multiplier)
      if (windows.length > 0) {
        peak = {
          multiplier: Number.isFinite(mult) && mult > 0 ? mult : 2,
          windows,
          weekdaysOnly: raw.peak.weekdaysOnly !== false,
          timezoneOffsetMinutes: Number.isFinite(Number(raw.peak.timezoneOffsetMinutes))
            ? Number(raw.peak.timezoneOffsetMinutes)
            : 480
        }
      }
    }
    out.push({
      provider: typeof raw.provider === 'string' && raw.provider.length > 0 ? raw.provider : '*',
      model: typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : '*',
      price: {
        input: positive(price.input),
        output: positive(price.output),
        cacheRead: positive(price.cacheRead),
        cacheWrite: positive(price.cacheWrite)
      },
      hours,
      peak,
      // Marks a route that is intentionally free, so its zero cost is reported
      // as free rather than as an unknown price (see applyRecord).
      free: raw.free === true,
      note: typeof raw.note === 'string' ? raw.note.slice(0, 300) : undefined
    })
  }
  return out
}

function wildcard(pattern, text) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped.replace(/\\\*/g, '.*') + '$', 'i').test(text)
}

function matchRule(rules, provider, model) {
  const p = typeof provider === 'string' ? provider : ''
  const m = typeof model === 'string' ? model : ''
  let fallback = null
  for (const rule of rules) {
    if (!wildcard(rule.model, m)) continue
    if (!wildcard(rule.provider, p)) continue
    if (rule.provider !== '*' && rule.model !== '*') return rule
    if (fallback === null) fallback = rule
    if (rule.provider !== '*' && rule.model === '*') return rule
  }
  return fallback
}

/**
 * Peak/off-peak multiplier for one call.
 *
 * A rule may carry `hours`: an array of 24 multipliers applied by local hour.
 * A rule may instead carry `peak`: { multiplier, windows, timezoneOffsetMinutes? },
 * which expresses a weekday-and-hour schedule that `hours` alone cannot — the
 * DeepSeek official API charges double only on weekdays 09:00-12:00 and
 * 14:00-18:00 Beijing time, so a Saturday 10:00 call is off-peak while a
 * Friday 10:00 call is peak with an identical hour number.
 *
 * `windows` are [startHour, endHour) pairs in the schedule's own timezone,
 * converted from the call's local time. Providers without a peak schedule
 * leave both fields out of their rules.
 */
function hourMultiplier(rule, atMs) {
  if (rule === null) return 1
  if (Array.isArray(rule.hours)) {
    const v = Number(rule.hours[new Date(atMs).getHours()])
    return Number.isFinite(v) && v >= 0 ? v : 1
  }
  const peak = rule.peak
  if (peak === null || typeof peak !== 'object') return 1
  const mult = Number(peak.multiplier)
  const base = Number.isFinite(mult) && mult > 0 ? mult : 2
  const offset = Number.isFinite(Number(peak.timezoneOffsetMinutes)) ? Number(peak.timezoneOffsetMinutes) : 480
  const windows = Array.isArray(peak.windows) ? peak.windows : []
  const weekdaysOnly = peak.weekdaysOnly !== false
  // Read the weekday and hour in the schedule's own timezone.
  //
  // Work the shift out from first principles rather than guessing a sign.
  // getTimezoneOffset() = (UTC - local) in minutes; for UTC+8 that is -480.
  // Wall-clock fields of an instant `at` in a zone with UTC offset `O` are the
  // UTC fields of the instant `at + O minutes`. So shift by exactly the target
  // zone's own offset, and read with the UTC getters — the machine's own offset
  // must not enter at all, since UTC getters never apply it.
  const shifted = new Date(atMs + offset * 60000)
  if (weekdaysOnly) {
    const dow = shifted.getUTCDay()
    if (dow === 0 || dow === 6) return 1
  }
  const h = shifted.getUTCHours()
  for (const w of windows) {
    if (!Array.isArray(w) || w.length < 2) continue
    const from = Number(w[0])
    const to = Number(w[1])
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    if (h >= from && h < to) return base
  }
  return 1
}

function normalizeUsage(raw) {
  if (raw === null || typeof raw !== 'object') return null
  // The four counters are DISJOINT: inputTokens is the cache-miss prompt
  // portion and cacheReadTokens the cache-hit portion. Verified against a
  // provider bill: per hour the recorded cacheReadTokens equals the bill's
  // cached-input column exactly, while inputTokens is much smaller than it. So
  // inputTokens must NOT be read as a total that already contains the cache
  // hits. An earlier `if (input < cacheRead) input = cacheRead` clamp assumed
  // exactly that; it replaced the small cache-miss count with the large
  // cache-hit count, so every cached token was billed twice (once at the input
  // rate, once at the cache rate) and reported twice in the token total. That
  // inflated the daily figure by roughly 10x.
  const input = positive(raw.inputTokens)
  const output = positive(raw.outputTokens)
  const cacheRead = positive(raw.cacheReadTokens)
  const cacheWrite = positive(raw.cacheWriteTokens)
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null
  return { input, output, cacheRead, cacheWrite }
}

function pad2(n) { return n < 10 ? '0' + String(n) : String(n) }
function hhmm(ms) { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) }
function ymdLocal(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}
function localDayStart(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
}
function localMonthStart(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime()
}
function localMonthEnd(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime()
}
function localWeekStart(ms) {
  const start = localDayStart(ms)
  const dow = new Date(start).getDay()
  return start - (dow === 0 ? 6 : dow - 1) * DAY_MS
}
const WEEK_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

const inject = ['timer']

/**
 * ── live throughput (TPS / TTFT) ───────────────────────────────────────────
 *
 * Ported from dsh-live-token-stats (MIT, better-er/dsh-live-token-stats), both
 * the tracker and now its tokenizer.
 *
 * Counting: `lib/tokenizer/` is the upstream DeepSeek V4 byte-level BPE, which
 * matches HF transformers token id for token id. It replaces the earlier
 * character-density guess, which under-counted by a median 25% against the
 * official usage measured over 33k real steps on this machine. Two properties
 * are what make it usable live: incremental cross-delta segmentation (each
 * delta is priced as it lands, and the running total still equals one pass over
 * the whole text) and streaming JSON unescape for tool-call arguments (the wire
 * form doubles every newline and quote, so counting it raw over-states).
 *
 * Even a real tokenizer cannot be exact mid-stream, because the last few
 * characters may not have formed a token yet, so every readout it feeds keeps
 * the `~` prefix until the official `usage` chunk arrives for that step. That
 * calibration is the point: the mid-stream figure only has to be close, and the
 * settled figure is then exact.
 *
 * The tracker is fed from the existing `llm/stream` tap below, which already
 * walks every chunk; it previously discarded everything except `usage`.
 */
const TPS_WINDOW_MS = 3000
const TPS_STALL_GRACE_MS = 300
/** Drop a session's cell once its stream has been closed this long. */
const TPS_CELL_TTL_MS = 600000
/**
 * Structural overhead the local count cannot see, in tokens per tool call.
 *
 * The provider bills the tool-call message template and the call id, neither of
 * which ever appears in the streamed text. Measured on 33,457 real steps from
 * this machine's session logs: a step with no tool call is off by -1 token, with
 * one by -31, two by -62, three by -81 — linear at roughly -22 per call. Adding
 * 22 per call drops the median relative error from 11.7% to 6.5% and the median
 * absolute error from 36 to 18 tokens.
 *
 * This is deliberately a flat per-call constant rather than a fitted
 * multiplier: a regression found 0.977 * bpe + 24.3 * calls + 12.5 and scored
 * better (4.4% median), but its coefficients are tuned to this account's model
 * mix and would silently stop meaning anything on a different provider. The
 * constant degrades gracefully; a fitted slope does not. The official usage
 * replaces both at step end, so this only has to be close while generating.
 */
const TPS_TOOL_CALL_OVERHEAD = 22

/** True for the chunk kinds that carry generated output. */
function isDeltaChunk(chunk) {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta'
}

/**
 * Per-step tokenizer state, or null when the tokenizer could not be loaded.
 *
 * Text, reasoning and tool-call arguments each need their own incremental
 * segmenter and their own unescape tail: their deltas interleave, and feeding
 * one stream's text into another's buffer would merge across a boundary the
 * real generation never had. Tool-call argument text is unescaped first,
 * because the protocol escapes it while the usage counts the decoded form.
 */
function newTokenState() {
  return {
    text: EMPTY_INCREMENTAL,
    reasoning: EMPTY_INCREMENTAL,
    toolArgs: EMPTY_INCREMENTAL,
    toolEsc: EMPTY_UNESCAPE,
    /** Tool-call names already counted, so repeated frames are not re-billed. */
    namedCallIds: new Set(),
    /** Set once this stream reported usage; later deltas add nothing. */
    sealed: false
  }
}

/**
 * Count one delta's contribution with the real tokenizer.
 *
 * Returns 0 on any failure: a live readout is not worth breaking the stream tap
 * for, and the official usage still arrives at the end of the step.
 */
function countDeltaTokens(state, chunk) {
  if (chunk.type === 'text-delta') {
    const text = typeof chunk.text === 'string' ? chunk.text : ''
    if (text.length === 0) return 0
    const r = incrementalFeed(state.text, text)
    state.text = r.state
    return r.added
  }
  if (chunk.type === 'reasoning-delta') {
    const text = typeof chunk.text === 'string' ? chunk.text : ''
    if (text.length === 0) return 0
    const r = incrementalFeed(state.reasoning, text)
    state.reasoning = r.state
    return r.added
  }
  if (chunk.type === 'tool-call-delta') {
    let added = 0
    const raw = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
    if (raw.length > 0) {
      const dec = unescapeFeed(state.toolEsc, raw)
      state.toolEsc = dec.state
      if (dec.text.length > 0) {
        const r = incrementalFeed(state.toolArgs, dec.text)
        state.toolArgs = r.state
        added += r.added
      }
    }
    // The call name is model output too and the official count includes it;
    // every frame repeats it, so count it once per call id. That is also the
    // moment the call exists, so its structural overhead is charged here.
    const name = chunk.name
    const id = chunk.id
    if (typeof name === 'string' && name.length > 0) {
      // Frames of one call share an id; adapters that omit it still give a
      // stable block index. Keying on name+index rather than index alone keeps
      // two same-named concurrent calls apart. Whatever key is used, it must be
      // stable across the frames of one call, or the overhead is charged per
      // frame instead of per call.
      const key = id === undefined || id === null
        ? 'idx:' + String(chunk.index) + ':' + name
        : String(id)
      if (!state.namedCallIds.has(key)) {
        state.namedCallIds.add(key)
        added += tokenCount(name) + TPS_TOOL_CALL_OVERHEAD
      }
    }
    return added
  }
  return 0
}

function newTpsCell() {
  return {
    samples: [],
    stepStartAt: 0,
    lastSampleAt: 0,
    firstSampleAt: 0,
    stallMs: 0,
    activeStreams: 0,
    totalTokens: 0,
    usageOutputTokens: undefined,
    lastTouchedAt: Date.now(),
    // When the last live stream of the step closed. Everything the snapshot
    // reports after that is frozen at this instant: an ended generation must
    // not keep dividing by a denominator that grows with wall-clock time.
    lastEndedAt: 0,
    /** Tokens reported by official usage chunks (usage appears only at the end). */
    usageInputTokens: undefined,
    usageCacheReadTokens: undefined,
    usageCacheWriteTokens: undefined,
    /** Measured decode time of the step, excluding reported stalls. */
    generationMs: 0,
    /** Wall-clock instant the frozen averages are measured at. */
    settleAt: 0,
    settled: null,
    /** Live tokenizer state for the step. */
    tok: null
  }
}

function apply(ctx) {
  const buckets = new Map()
  const seen = new Set()
  // The same API call reaches us twice: once live through `llm/stream`, and
  // again when a session log is replayed - at boot, and after any restart,
  // because a fresh process re-reads logs that an earlier process had already
  // captured live. Their ledger keys differ by construction ("live:N:ts" vs
  // "log:session:id:seq"), so the key cache alone cannot collapse them.
  // Identical provider+model+token counts within SIG_TOL_MS is the same call,
  // not two, so a content signature catches what the key cannot.
  const sigIndex = new Map()
  const unpricedTokens = new Map()
  const ledger = []
  const errors = []
  const resolvedCache = {}
  // Hourly totals imported from the vendor bill, keyed "YYYY-MM-DDTHH" in local
  // time. They are NOT replayed through the minute buckets: 40k+ synthetic rows
  // would drown the live data. Instead they carry precomputed cost/tokens/
  // requests per hour and are merged only where the live ledger has no data.
  const importedHistory = new Map()
  // Per-session live throughput cells, keyed by sessionId. Single-threaded
  // host process and `llm/stream` runs one request at a time per session, so
  // no locking is needed.
  const tpsCells = new Map()

  /**
   * Mark a step boundary. Called when a stream opens.
   *
   * `stepStartAt` is the denominator's origin for both the live rate and TTFT,
   * so it must be stamped from wall-clock time at the moment the request goes
   * out, not from the first chunk (that would erase the very latency we want).
   */
  function tpsBeginStream(sessionId, at) {
    let cell = tpsCells.get(sessionId)
    if (cell === undefined) {
      cell = newTpsCell()
      tpsCells.set(sessionId, cell)
    }
    // ONE STEP CAN OPEN SEVERAL STREAMS. A step that emits text and then two
    // tool calls arrives as several overlapping llm/stream requests; resetting
    // on every one of them meant the last stream of the step decided the
    // counters — and that stream often carries no text at all (see
    // `tryTakeover`). Upstream models the same thing with a live-stream count
    // (dsh-live-token-stats beginStep: `fresh = cell.activeStreams === 0`), and
    // so do we: reset only when this is the first stream of a new step.
    if (cell.activeStreams > 0) {
      cell.activeStreams += 1
      cell.lastTouchedAt = at
      return
    }
    // A new stream = a new step. Reset the per-step counters but keep nothing
    // stale from the previous one.
    cell.samples = []
    cell.tok = newTokenState()
    cell.stepStartAt = at
    cell.lastSampleAt = 0
    cell.firstSampleAt = 0
    cell.stallMs = 0
    cell.totalTokens = 0
    cell.usageOutputTokens = undefined
    cell.usageInputTokens = undefined
    cell.usageCacheReadTokens = undefined
    cell.usageCacheWriteTokens = undefined
    cell.settled = null
    cell.settleAt = 0
    cell.generationMs = 0
    cell.activeStreams += 1
    cell.lastTouchedAt = at
  }

  /**
   * True when the last population of samples predates the stream that is
   * opening, i.e. the new stream has nothing to contribute.
   *
   * A step reaches us as several overlapping llm/stream calls, and the ones
   * for later tool calls frequently carry no text delta at all (the call is
   * already complete in its first chunk). If such a stream is left open it
   * wins the race to close last, and then its own 300 ms lifetime becomes the
   * decoded duration — the 2.7 tok/s nonsense — while its early close freezes
   * the step before the text-carrying stream has finished.
   */
  function tryTakeover(cell, at) {
    // Only meaningful for a stream that opens on an otherwise idle cell: while
    // another stream of the same step is still open, this one is a sibling and
    // must be counted, not retired.
    if (cell.activeStreams > 0) return false
    if (cell.samples.length === 0) return false
    const newest = cell.samples[cell.samples.length - 1].time
    if (cell.lastSampleAt <= at) return false
    if (newest <= at || cell.stepStartAt + 1 >= at) return false
    return true
  }

  /** Fold one adapter chunk into its session's cell. Pure w.r.t. the stream. */
  function tpsFoldChunk(sessionId, chunk, at) {
    const cell = tpsCells.get(sessionId)
    if (cell === undefined) return
    cell.lastTouchedAt = at
    if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
      // Exact counts for this step: the calibration point. Usage arrives once,
      // at the end of the stream, and it covers the WHOLE step (input, cache
      // hits and cache writes included), which is what the money side needs.
      const u = chunk.usage
      if (typeof u.outputTokens === 'number') cell.usageOutputTokens = u.outputTokens
      if (typeof u.inputTokens === 'number') cell.usageInputTokens = u.inputTokens
      if (typeof u.cacheReadTokens === 'number') cell.usageCacheReadTokens = u.cacheReadTokens
      if (typeof u.cacheWriteTokens === 'number') cell.usageCacheWriteTokens = u.cacheWriteTokens
      // usage is authoritative for this step; stop growing the running estimate.
      if (cell.tok !== null) cell.tok.sealed = true
      return
    }
    if (!isDeltaChunk(chunk)) return
    let tokens = 0
    if (cell.tok !== null && !cell.tok.sealed) tokens = countDeltaTokens(cell.tok, chunk)
    if (tokens <= 0) return
    // A gap past the grace window is a stall, not normal batched streaming, and
    // is excluded from the rate's moving part but counted for display.
    if (cell.lastSampleAt > 0 && at - cell.lastSampleAt >= TPS_STALL_GRACE_MS) {
      cell.stallMs += at - cell.lastSampleAt
    }
    if (cell.firstSampleAt === 0) cell.firstSampleAt = at
    cell.lastSampleAt = at
    cell.totalTokens += tokens
    cell.samples.push({ time: at, tokens })
    const cutoff = at - TPS_WINDOW_MS
    while (cell.samples.length > 0 && cell.samples[0].time < cutoff) cell.samples.shift()
  }

  /**
   * Close a stream. Once the LAST stream of the step closes, the step is frozen
   * into `settled` and every later snapshot reads those numbers instead of
   * recomputing averages against a denominator that grows while the user reads
   * them. That was the visible bug: with nothing generating, "准确速度" counted
   * down from 28 to 2 tok/s forever because elapsedMs = now - stepStartAt.
   */
  function tpsEndStream(sessionId, at) {
    const cell = tpsCells.get(sessionId)
    if (cell === undefined) return
    cell.activeStreams = Math.max(0, cell.activeStreams - 1)
    cell.lastTouchedAt = at
    cell.lastEndedAt = at
    if (cell.activeStreams > 0) return
    // Decode time = from request start to last delta, minus the stalls that
    // were measured while the stream was open. Usage arrives AFTER the last
    // delta, so stopping the clock at the delta end keeps a post-stream tail
    // from diluting the rate.
    const lastDelta = cell.lastSampleAt > 0 ? cell.lastSampleAt : at
    // A step's sibling streams open and close at different moments; the silence
    // between them is not the model pausing, so it is not a stall. Only a gap
    // between consecutive deltas counts, and the tail after the last delta is
    // trimmed anyway (see `lastDelta`).
    const gaps = cell.stallMs
    const tailGap = cell.lastSampleAt > 0 && at - cell.lastSampleAt >= TPS_STALL_GRACE_MS
      ? at - cell.lastSampleAt
      : 0
    const countedStalls = Math.max(0, gaps - tailGap)
    const span = Math.max(0, lastDelta - cell.stepStartAt - countedStalls)
    const tokens = cell.usageOutputTokens !== undefined ? cell.usageOutputTokens : cell.totalTokens
    cell.generationMs = Math.max(1, span)
    cell.settleAt = lastDelta
    cell.settled = {
      outputTokens: tokens,
      exact: cell.usageOutputTokens !== undefined,
      tokensPerSecond: span > 0 ? tokens / (span / 1000) : undefined,
      firstTokenDelayMs: cell.firstSampleAt > 0 && cell.stepStartAt > 0
        ? Math.max(0, cell.firstSampleAt - cell.stepStartAt)
        : undefined,
      // Output-only vs whole-call rate: a step whose output is mostly cache
      // hits looks absurd if the cache reads are counted as "generated".
      contextTokens: cell.usageInputTokens !== undefined
        ? cell.usageInputTokens + (cell.usageCacheReadTokens || 0) + (cell.usageCacheWriteTokens || 0)
        : undefined,
      inputTokens: cell.usageInputTokens,
      cacheReadTokens: cell.usageCacheReadTokens,
      cacheWriteTokens: cell.usageCacheWriteTokens,
      generationMs: span,
      stallMs: countedStalls,
      endedAt: lastDelta,
      tokensEstimated: cell.usageOutputTokens === undefined
    }
  }

  /**
   * Live snapshot for one session, or null when there is nothing to show.
   *
   * While a stream is open the rate's denominator is the smaller of elapsed
   * since step start and the window; after it closes the frozen settlement is
   * reported, so an idle dock shows the last real measurement, unchanged.
   */
  function tpsSnapshot(sessionId, asOf) {
    // STRICTLY PER SESSION. There used to be a fallback to "the most recently
    // touched cell", which meant a session sitting idle would borrow whichever
    // other conversation happened to be generating — a visible speed in a pane
    // where nothing was running. Each dock row now reports only its own
    // session; with no cell of its own it reports nothing.
    if (sessionId === undefined) return null
    const cell = tpsCells.get(sessionId)
    if (cell === undefined) return null
    const window = TPS_WINDOW_MS
    const generating = cell.activeStreams > 0
    const out = { generating }
    if (!generating && cell.settled !== null) {
      const s = cell.settled
      out.stallMs = s.stallMs
      out.outputTokens = s.outputTokens
      out.exact = s.exact
      out.settledAt = s.endedAt
      out.sinceSettleMs = Math.max(0, asOf - s.endedAt)
      if (Number.isFinite(s.tokensPerSecond)) {
        out.tokensPerSecond = s.tokensPerSecond
        out.settledRate = s.tokensPerSecond
      }
      if (Number.isFinite(s.contextTokens) && s.generationMs > 0) {
        out.contextTokensPerSecond = s.contextTokens / (s.generationMs / 1000)
      }
      if (Number.isFinite(s.inputTokens)) out.inputTokens = s.inputTokens
      if (Number.isFinite(s.cacheReadTokens)) out.cacheReadTokens = s.cacheReadTokens
      if (Number.isFinite(s.cacheWriteTokens)) out.cacheWriteTokens = s.cacheWriteTokens
      if (Number.isFinite(s.firstTokenDelayMs)) out.firstTokenDelayMs = s.firstTokenDelayMs
      out.generationMs = s.generationMs
      return out
    }
    const samples = cell.samples
    let rate
    if (samples.length > 0) {
      const elapsedMs = cell.stepStartAt > 0 ? Math.max(0, asOf - cell.stepStartAt) : asOf - samples[0].time
      const spanMs = Math.max(50, Math.min(elapsedMs, window))
      rate = samples.reduce((acc, s) => acc + s.tokens, 0) / (spanMs / 1000)
    }
    const exact = cell.usageOutputTokens !== undefined
    const outputTokens = exact ? cell.usageOutputTokens : cell.totalTokens
    const elapsedMs = cell.stepStartAt > 0 ? Math.max(0, asOf - cell.stepStartAt) : 0
    out.stallMs = cell.stallMs + (generating && cell.lastSampleAt > 0 && asOf - cell.lastSampleAt >= TPS_STALL_GRACE_MS
      ? asOf - cell.lastSampleAt
      : 0)
    out.outputTokens = outputTokens
    out.exact = exact
    if (rate !== undefined) out.tokensPerSecond = rate
    if (cell.firstSampleAt > 0 && cell.stepStartAt > 0) {
      out.firstTokenDelayMs = Math.max(0, cell.firstSampleAt - cell.stepStartAt)
    }
    if (elapsedMs > 0) out.elapsedMs = elapsedMs
    if (out.elapsedMs > 0 && outputTokens > 0) out.averageTokensPerSecond = outputTokens / (out.elapsedMs / 1000)
    return out
  }

  /** Forget cells whose stream closed long ago, so the map cannot grow forever. */
  function tpsPrune(asOf) {
    let removed = 0
    for (const [key, cell] of tpsCells) {
      if (cell.activeStreams === 0 && asOf - cell.lastTouchedAt > TPS_CELL_TTL_MS) {
        tpsCells.delete(key)
        removed += 1
      }
    }
    return removed
  }

  let ledgerRestored = 0
  let callsRecorded = 0
  let routesLive = false
  let liveCount = 0
  let backfillCount = 0
  let backfillScanned = 0
  let duplicateSkipped = 0
  let ledgerDiscarded = 0
  let oldestEvent = null
  let saveTimer = null
  let dirty = false
  let historyDirty = false
  let historyImported = 0
  let historyHoursKept = 0
  let historyHoursShadowed = 0
  let ledgerSaved = 0
  let saveFailures = 0
  let lastSaveError = null
  let snapshotCalls = 0
  let persistedBytes = null
  let liveProvider = undefined
  let liveModel = undefined
  const startedAt = Date.now()

  let config = { note: DEFAULT_CONFIG.note, rules: sanitizeRules(DEFAULT_CONFIG.rules) }
  let ledgerPath = null
  let configPath = null
  let historyPath = null
  let storageHome = null

  function note(where, error) {
    const text = where + ': ' + String(error)
    if (errors.length < 8) errors.push(text)
    lastSaveError = text
  }

  // ── accounting ────────────────────────────────────────────────────────────

  function bucketFor(index) {
    let b = buckets.get(index)
    if (b === undefined) {
      b = { cost: 0, tokens: 0, requests: 0, unpriced: 0, models: new Map() }
      buckets.set(index, b)
    }
    return b
  }

  function applyRecord(provider, model, usage, atMs) {
    const at = Number.isFinite(atMs) ? atMs : Date.now()
    const rule = matchRule(config.rules, provider, model)
    const mult = hourMultiplier(rule, at)
    const rate = rule === null ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : rule.price
    const cost = (usage.input * rate.input + usage.output * rate.output
      + usage.cacheRead * rate.cacheRead + usage.cacheWrite * rate.cacheWrite) / 1000000 * mult
    const priced = rate.input > 0 || rate.output > 0 || rate.cacheRead > 0 || rate.cacheWrite > 0
    // A rule marked `free` is deliberately priced at zero (a subscription route
    // or a self-hosted model), which is a different thing from a model we have
    // no price for. Both cost 0, but only the latter is "unpriced": reporting a
    // free route as unpriced invites the user to look for a price that does not
    // exist.
    const free = rule !== null && rule.free === true
    const key = String(provider) + '/' + String(model)
    const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
    if (!priced && !free) {
      const cur = unpricedTokens.get(key) || { tokens: 0, requests: 0 }
      cur.tokens += tokens
      cur.requests += 1
      unpricedTokens.set(key, cur)
    }
    const b = bucketFor(Math.floor(at / MIN_STEP_MS))
    b.cost += cost
    b.tokens += tokens
    b.requests += 1
    if (!priced && !free) b.unpriced += 1
    let entry = b.models.get(key)
    if (entry === undefined) { entry = { cost: 0, tokens: 0, requests: 0 }; b.models.set(key, entry) }
    entry.cost += cost
    entry.tokens += tokens
    entry.requests += 1
    callsRecorded += 1
    dirty = true
    return true
  }

  function pushLedger(entry) {
    ledger.push(entry)
    if (ledger.length > LEDGER_MAX) ledger.splice(0, ledger.length - LEDGER_MAX)
  }

  function signatureOf(provider, model, usage) {
    return String(provider) + '|' + String(model) + '|' + String(usage.input) + '|'
      + String(usage.output) + '|' + String(usage.cacheRead) + '|' + String(usage.cacheWrite)
  }

  function sameCallAlreadySeen(provider, model, usage, at) {
    const times = sigIndex.get(signatureOf(provider, model, usage))
    if (times === undefined) return false
    for (let i = 0; i < times.length; i += 1) {
      if (Math.abs(times[i] - at) <= SIG_TOL_MS) return true
    }
    return false
  }

  function rememberCall(provider, model, usage, at) {
    const sig = signatureOf(provider, model, usage)
    const times = sigIndex.get(sig)
    if (times === undefined) sigIndex.set(sig, [at])
    else times.push(at)
  }

  /**
   * The single entry point for every captured call. Dedupes by ledger key and
   * by content signature, then records and aggregates. Returns false when the
   * call was already accounted for.
   */
  function recordCall(provider, model, usage, at, key, source) {
    if (seen.has(key)) { duplicateSkipped += 1; return false }
    seen.add(key)
    if (sameCallAlreadySeen(provider, model, usage, at)) { duplicateSkipped += 1; return false }
    rememberCall(provider, model, usage, at)
    pushLedger({ k: key, s: source, t: at, p: String(provider), m: String(model), i: usage.input, o: usage.output, cr: usage.cacheRead, cw: usage.cacheWrite })
    applyRecord(provider, model, usage, at)
    return true
  }

  // `global` so every session's streams are seen, not just the one that happens
  // to own this plugin instance (an idle dock must not go blind because another
  // session is the active one); `prepend` so the tap runs before other
  // listeners and observes the chunks untouched.
  ctx.on('llm/stream', (options, next) => {
    const outer = next()
    const provider = options !== null && typeof options === 'object' ? options.provider : undefined
    const model = options !== null && typeof options === 'object' ? options.model : undefined
    // Same tap, second consumer: the live throughput cell for this session.
    // Absent on some paths, in which case only the TPS readout is skipped and
    // cost accounting is unaffected.
    const sessionId = options !== null && typeof options === 'object' && options.sessionId !== undefined
      ? String(options.sessionId)
      : undefined
    async function* tapped() {
      let usage = null
      // A stream that opens on a cell which already holds a complete set of
      // samples cannot belong to a new step: it is one of the extra streams a
      // single step opens for its later tool calls, and those carry no text.
      // Register it as closed at once instead of letting it hold the step open
      // and then become the one that freezes the settlement.
      let retired = false
      if (sessionId !== undefined) {
        const opening = tpsCells.get(sessionId)
        const at = Date.now()
        if (opening !== undefined && opening.activeStreams === 0 && tryTakeover(opening, at)) {
          tpsBeginStream(sessionId, at)
          tpsEndStream(sessionId, at)
          retired = true
        } else {
          tpsBeginStream(sessionId, at)
        }
      }
      try {
        for await (const chunk of outer) {
          if (chunk !== null && typeof chunk === 'object') {
            if (chunk.type === 'usage') {
              const normalized = normalizeUsage(chunk.usage)
              if (normalized !== null) usage = normalized
            }
            if (sessionId !== undefined) tpsFoldChunk(sessionId, chunk, Date.now())
          }
          yield chunk
        }
      } finally {
        if (sessionId !== undefined && !retired) tpsEndStream(sessionId, Date.now())
      }
      if (usage !== null) {
        liveCount += 1
        liveProvider = provider
        liveModel = model
        const at = Date.now()
        const key = 'live:' + String(liveCount) + ':' + String(at)
        if (recordCall(String(provider), String(model), usage, at, key, 'live')) scheduleSave()
      }
    }
    return tapped()
  }, { global: true, prepend: true })

  /**
   * Rebuild history by replaying this process's in-memory session logs.
   *
   * `sessions.list()` is ASYNC and resolves to live Session objects whose
   * `snapshotEvents()` lives on the prototype, so it must be reached through
   * the instance. An earlier version called it synchronously and read
   * `session.snapshotEvents` off the returned value; the await was missing, so
   * the value was a pending Promise, every session was skipped, and a restart
   * silently recovered nothing at all.
   */
  async function backfillFromSessions() {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || typeof sessions.list !== 'function') return
    let list = []
    try {
      list = await sessions.list()
    } catch (error) {
      note('sessions.list', error)
      return
    }
    if (!Array.isArray(list)) {
      note('sessions.list', new Error('expected an array, got ' + typeof list))
      return
    }
    const floorMs = startedAt - BACKFILL_LOOKBACK_MS
    for (const session of list) {
      if (session === null || typeof session !== 'object') continue
      let log = null
      try {
        log = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : null
      } catch (error) {
        log = null
      }
      if (log === null || log.length === 0) continue
      let provider
      let model
      for (const ev of log) {
        if (ev === null || typeof ev !== 'object') continue
        const data = ev.data !== null && typeof ev.data === 'object' ? ev.data : null
        if (data === null) continue
        if (ev.type === 'request/header') {
          const header = data.header !== null && typeof data.header === 'object' ? data.header : null
          const cfg = header !== null && header.config !== null && typeof header.config === 'object' ? header.config : null
          if (cfg !== null) {
            if (typeof cfg.provider === 'string') provider = cfg.provider
            if (typeof cfg.model === 'string') model = cfg.model
          }
          continue
        }
        if (ev.type !== 'assistant/message') continue
        const normalized = normalizeUsage(data.usage)
        if (normalized === null) continue
        backfillScanned += 1
        const at = typeof ev.time === 'number' ? ev.time : startedAt
        if (oldestEvent === null || at < oldestEvent) oldestEvent = at
        if (at < floorMs || at > startedAt + 60000) continue
        const key = 'log:' + String(typeof session.id === 'string' ? session.id : 'unknown') + ':' + String(ev.seq)
        if (recordCall(String(provider), String(model), normalized, at, key, 'sessionLog')) backfillCount += 1
      }
    }
  }

  function prune() {
    const floor = startedAt - RETENTION_DAYS * DAY_MS
    let removed = 0
    for (const key of Array.from(buckets.keys())) {
      if (key * MIN_STEP_MS < floor) { buckets.delete(key); removed += 1 }
    }
    // Keep the duplicate-call index bounded to the same window as the data.
    for (const pair of Array.from(sigIndex.entries())) {
      const kept = pair[1].filter((t) => t >= floor)
      if (kept.length === 0) sigIndex.delete(pair[0])
      else if (kept.length !== pair[1].length) sigIndex.set(pair[0], kept)
    }
    return removed
  }

  // ── persistence ───────────────────────────────────────────────────────────

  function setupPaths() {
    try {
      const fromEnv = typeof process !== 'undefined' && process.env !== undefined
        && typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
        ? process.env.DSH_HOME
        : null
      const home = fromEnv !== null ? fromEnv : join(homedir(), '.dsh')
      const dir = join(home, 'cost-monitor')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      storageHome = dir
      ledgerPath = join(dir, 'ledger.json')
      configPath = join(dir, 'pricing.json')
      historyPath = join(dir, 'history-bill.json')
    } catch (error) {
      note('storage dir', error)
      storageHome = null
      ledgerPath = null
      configPath = null
    }
  }

  function readText(path) {
    if (path === null) return null
    try {
      const text = readFileSync(path, 'utf8')
      // Windows editors and PowerShell's UTF-8 redirection may prepend a
      // byte-order mark; JSON.parse rejects it, which would silently fall back
      // to the default price table or discard a valid ledger. Strip it on read.
      const clean = text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
      return clean.length > 0 ? clean : null
    } catch (error) {
      return null
    }
  }

  function writeText(path, text) {
    if (path === null) return false
    try {
      const staging = path + '.tmp'
      // Files hold usage history and prices, never prompts or credentials. The
      // mode is best-effort: Windows ignores most POSIX bits and relies on the
      // per-user profile directory instead.
      writeFileSync(staging, text, { encoding: 'utf8', mode: 0o600 })
      renameSync(staging, path)
      persistedBytes = Buffer.byteLength(text, 'utf8')
      return true
    } catch (error) {
      saveFailures += 1
      note('write ' + path, error)
      return false
    }
  }

  async function saveLedger() {
    if (!dirty || ledgerPath === null) return
    const rows = ledger.map((e) => [e.k, e.s, e.t, e.p, e.m, e.i, e.o, e.cr, e.cw, e.c])
    if (!writeText(ledgerPath, JSON.stringify({ version: 3, savedAt: Date.now(), rows }))) return
    dirty = false
    ledgerSaved += 1
  }

  async function saveHistory() {
    if (!historyDirty || historyPath === null) return
    // `importedHistory` is a Map whose values hold a nested Map, and
    // JSON.stringify renders BOTH as {} — so writing the Map directly persisted
    // an empty object. The loader then read `hours` as [] and silently imported
    // nothing, meaning every import was lost on the next restart while the panel
    // kept showing it from memory until then. Serialise to the same array shape
    // the loader parses below.
    const hours = Array.from(importedHistory.entries()).map(([k, e]) => ({
      k,
      c: e.cost,
      t: e.tokens,
      n: e.requests,
      m: Array.from(e.models.entries()).map(([name, v]) => [name, v.cost, v.tokens, v.requests])
    }))
    if (!writeText(historyPath, JSON.stringify({ version: 1, savedAt: Date.now(), hours }, null, 0))) return
    historyDirty = false
  }

  async function saveConfig() {
    if (configPath === null) return
    writeText(configPath, JSON.stringify(config, null, 2))
  }

  function scheduleSave() {
    if (saveTimer !== null && typeof saveTimer === 'function') saveTimer()
    saveTimer = ctx.timeout(() => { saveTimer = null; saveLedger() }, 4000)
  }

  async function restore() {
    setupPaths()
    const raw = readText(configPath)
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw)
        const rules = sanitizeRules(parsed !== null && typeof parsed === 'object' ? parsed.rules : null)
        if (rules.length > 0) {
          config = { note: typeof parsed.note === 'string' ? parsed.note : DEFAULT_CONFIG.note, rules }
        }
      } catch (error) {
        note('pricing parse', error)
      }
    }
    const rawLedger = readText(ledgerPath)
    if (rawLedger !== null) {
      try {
        const parsed = JSON.parse(rawLedger)
        // v2 rows were written while usage.input was clamped up to
        // cacheReadTokens, so every stored cost is inflated and cannot be
        // repaired per-row. v3 is written only from counts captured with the
        // correct reading. Refusing v2 forces a clean re-derivation from the
        // session logs instead of carrying the bad numbers forward.
        const version = parsed !== null && typeof parsed === 'object' ? parsed.version : undefined
        const rows = version === 3 && Array.isArray(parsed.rows) ? parsed.rows : []
        if (version !== undefined && version !== 3) ledgerDiscarded += 1
        for (const r of rows) {
          if (!Array.isArray(r) || r.length < 9) continue
          const key = typeof r[0] === 'string' ? r[0] : null
          if (key === null || seen.has(key)) continue
          const at = Number(r[2])
          if (!Number.isFinite(at)) continue
          const usage = normalizeUsage({ inputTokens: r[5], outputTokens: r[6], cacheReadTokens: r[7], cacheWriteTokens: r[8] })
          if (usage === null) continue
          const source = typeof r[1] === 'string' ? r[1] : 'live'
          if (recordCall(String(r[3]), String(r[4]), usage, at, key, source)) ledgerRestored += 1
        }
      } catch (error) {
        note('ledger parse', error)
      }
    }
    const rawHistory = readText(historyPath)
    if (rawHistory !== null) {
      try {
        const parsed = JSON.parse(rawHistory)
        const hours = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.hours) ? parsed.hours : []
        for (const h of hours) {
          if (h === null || typeof h !== 'object') continue
          if (typeof h.k !== 'string') continue
          if (!Array.isArray(h.m)) continue
          const models = new Map()
          for (const m of h.m) {
            if (!Array.isArray(m) || m.length < 4) continue
            models.set(String(m[0]), { cost: Number(m[1]) || 0, tokens: Number(m[2]) || 0, requests: Number(m[3]) || 0 })
          }
          importedHistory.set(h.k, {
            cost: Number(h.c) || 0,
            tokens: Number(h.t) || 0,
            requests: Number(h.n) || 0,
            models
          })
          historyImported += 1
        }
      } catch (error) {
        note('history parse', error)
      }
    }
    dirty = false
  }

  // ── aggregation ───────────────────────────────────────────────────────────

  function newAggregate() { return { cost: 0, tokens: 0, requests: 0, models: new Map() } }

  /** Local-time hour key, matching how imported history is bucketed. */
  function hourKeyOf(ms) {
    const d = new Date(ms)
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours())
  }

  function addToAgg(agg, minute) {
    if (minute.cost === 0 && minute.tokens === 0 && minute.requests === 0) return
    agg.cost += minute.cost
    agg.tokens += minute.tokens
    agg.requests += minute.requests
    for (const pair of minute.models) {
      let entry = agg.models.get(pair[0])
      if (entry === undefined) { entry = { cost: 0, tokens: 0, requests: 0 }; agg.models.set(pair[0], entry) }
      entry.cost += pair[1].cost
      entry.tokens += pair[1].tokens
      entry.requests += pair[1].requests
    }
  }

  /** Fold one imported bill hour into an aggregate. */
  function addHistoryToAgg(agg, entry) {
    if (entry === undefined) return
    agg.cost += entry.cost
    agg.tokens += entry.tokens
    agg.requests += entry.requests
    for (const pair of entry.models) {
      let target = agg.models.get(pair[0])
      if (target === undefined) { target = { cost: 0, tokens: 0, requests: 0 }; agg.models.set(pair[0], target) }
      target.cost += pair[1].cost
      target.tokens += pair[1].tokens
      target.requests += pair[1].requests
    }
  }

  /** Total live requests in one local hour, used to decide whether it is empty. */
  function liveRequestsInHour(hourStartMs) {
    let total = 0
    const last = Math.floor((hourStartMs + HOUR_MS - 1) / MIN_STEP_MS)
    for (let i = Math.floor(hourStartMs / MIN_STEP_MS); i <= last; i += 1) {
      const found = buckets.get(i)
      if (found !== undefined) total += found.requests
    }
    return total
  }

  /**
   * Fold imported bill hours into an aggregate, skipping any hour the live
   * ledger already covers. Returns the number of imported hours that were used.
   */
  function addHistoryRange(agg, startMs, endMs) {
    let used = 0
    let shadowed = 0
    const firstHour = Math.floor(startMs / HOUR_MS)
    const lastHour = Math.floor((endMs - 1) / HOUR_MS)
    for (let h = firstHour; h <= lastHour; h += 1) {
      const entry = importedHistory.get(hourKeyOf(h * HOUR_MS))
      if (entry === undefined) continue
      if (liveRequestsInHour(h * HOUR_MS) > 0) { shadowed += 1; continue }
      addHistoryToAgg(agg, entry)
      used += 1
    }
    return { used, shadowed }
  }

  /** Fold imported hours into a per-hour bar series, keyed by hour index. */
  function historyInto(hourBuckets, startMs, endMs) {
    const firstHour = Math.floor(startMs / HOUR_MS)
    const lastHour = Math.floor((endMs - 1) / HOUR_MS)
    for (let h = firstHour; h <= lastHour; h += 1) {
      const entry = importedHistory.get(hourKeyOf(h * HOUR_MS))
      if (entry === undefined) continue
      if (liveRequestsInHour(h * HOUR_MS) > 0) continue
      const found = hourBuckets.get(h)
      if (found === undefined) hourBuckets.set(h, { cost: entry.cost, tokens: entry.tokens, requests: entry.requests, models: new Map(entry.models) })
      else {
        found.cost += entry.cost
        found.tokens += entry.tokens
        found.requests += entry.requests
        for (const pair of entry.models) {
          let t = found.models.get(pair[0])
          if (t === undefined) { t = { cost: 0, tokens: 0, requests: 0 }; found.models.set(pair[0], t) }
          t.cost += pair[1].cost
          t.tokens += pair[1].tokens
          t.requests += pair[1].requests
        }
      }
    }
  }

  function sumRange(startMs, endMs) {
    const agg = newAggregate()
    const first = Math.floor(startMs / MIN_STEP_MS)
    const last = Math.floor((endMs - 1) / MIN_STEP_MS)
    for (let i = first; i <= last; i += 1) {
      const found = buckets.get(i)
      if (found !== undefined) addToAgg(agg, found)
    }
    agg.cost = Math.round(agg.cost * 1000000) / 1000000
    return agg
  }

  /**
   * `sumRange` plus imported bill history for hours the ledger is missing. This
   * is the single merge point every panel reads through, so the hour, day, week
   * and month views all agree with each other and with the vendor bill.
   */
  function sumRangeWithHistory(startMs, endMs) {
    const agg = sumRange(startMs, endMs)
    const merged = addHistoryRange(agg, startMs, endMs)
    agg.cost = Math.round(agg.cost * 1000000) / 1000000
    return { agg, merged }
  }

  /**
   * Models to display for one aggregate.
   *
   * Everything is always recorded — a model is never dropped from the data.
   * Display, however, hides models whose spend in this window is under
   * MODEL_TRIVIAL_YUAN, so a long tail of near-zero vision experiments cannot
   * bury the models that actually cost money. The hidden remainder is reported
   * as `smallModels` (count + total) so the面板 can say it was folded away
   * rather than silently losing money from the total.
   */
  function modelsOf(agg, limit) {
    const list = []
    let smallCount = 0
    let smallCost = 0
    let smallTokens = 0
    // Merge rows that are the same model under different wire names (see
    // DISPLAY_NAME) so one model's spend is not split across two entries.
    const merged = new Map()
    for (const pair of agg.models) {
      const label = displayLabel(pair[0])
      let target = merged.get(label)
      if (target === undefined) { target = { cost: 0, tokens: 0, requests: 0 }; merged.set(label, target) }
      target.cost += pair[1].cost
      target.tokens += pair[1].tokens
      target.requests += pair[1].requests
    }
    for (const pair of merged) {
      const entry = {
        key: pair[0],
        cost: Math.round(pair[1].cost * 1000000) / 1000000,
        tokens: pair[1].tokens,
        requests: pair[1].requests
      }
      // A model with no price configured has cost 0 but may still be work worth
      // seeing; only fold it away when it is genuinely negligible AND priced.
      if (entry.cost > 0 && entry.cost < MODEL_TRIVIAL_YUAN) {
        smallCount += 1
        smallCost += entry.cost
        smallTokens += entry.tokens
        continue
      }
      list.push(entry)
    }
    list.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
    const shown = list.slice(0, limit || 8)
    const dropped = list.length - shown.length
    return {
      models: shown,
      smallModels: { count: smallCount + Math.max(0, dropped), cost: Math.round(smallCost * 1000000) / 1000000, tokens: smallTokens }
    }
  }

  function unpricedList() {
    return Array.from(unpricedTokens.entries())
      .map((pair) => ({ key: displayLabel(pair[0]), tokens: pair[1].tokens, requests: pair[1].requests }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 6)
  }

  function baseResult(mode, rangeLabel, liveSession) {
    return {
      ok: true,
      mode,
      now: Date.now(),
      offsetMinutes: new Date().getTimezoneOffset(),
      rangeLabel,
      spanLabel: oldestEvent === null ? '' : ymdLocal(oldestEvent) + ' 起',
      config: { note: config.note, rules: config.rules },
      trivialYuan: MODEL_TRIVIAL_YUAN,
      unpricedTokens: unpricedList(),
      // Live throughput rides along with the normal snapshot so the dock can
      // show both from one poll; null when no stream has run yet.
      live: tpsSnapshot(liveSession, Date.now())
    }
  }

  function hourSnap(liveSession) {
    const endIndex = Math.floor(Date.now() / MIN_STEP_MS)
    const out = []
    const agg = newAggregate()
    let peak = 0
    for (let i = HOUR_WINDOW_MIN - 1; i >= 0; i -= 1) {
      const index = endIndex - i
      const found = buckets.get(index)
      const t = index * MIN_STEP_MS
      if (found === undefined) {
        out.push({ t, label: hhmm(t), cost: 0, tokens: 0, requests: 0, models: [] })
        continue
      }
      addToAgg(agg, found)
      if (found.cost > peak) peak = found.cost
      out.push({ t, label: hhmm(t), cost: Math.round(found.cost * 1000000) / 1000000, tokens: found.tokens, requests: found.requests, models: modelsOf(found, 4).models })
    }
    const res = baseResult('hour', '近 1 小时', liveSession)
    res.buckets = out
    res.cost = agg.cost
    res.tokens = agg.tokens
    res.requests = agg.requests
    const ranked = modelsOf(agg, 10)
    res.models = ranked.models
    res.smallModels = ranked.smallModels
    res.peak = peak
    return res
  }

  function daySnap(liveSession) {
    const start = localDayStart(Date.now())
    const out = []
    const agg = newAggregate()
    let peak = 0
    for (let h = 0; h < 24; h += 1) {
      const hs = start + h * HOUR_MS
      const part = sumRange(hs, hs + HOUR_MS)
      // Hours the live ledger never saw come from the imported bill instead.
      // sumRange returns the aggregate shape, whose `models` is a Map.
      if (part.requests === 0) {
        const used = addHistoryRange(part, hs, hs + HOUR_MS)
        if (used.used > 0) part.cost = Math.round(part.cost * 1000000) / 1000000
      }
      if (part.cost > peak) peak = part.cost
      agg.cost += part.cost
      agg.tokens += part.tokens
      agg.requests += part.requests
      for (const pair of part.models) {
        let entry = agg.models.get(pair[0])
        if (entry === undefined) { entry = { cost: 0, tokens: 0, requests: 0 }; agg.models.set(pair[0], entry) }
        entry.cost += pair[1].cost
        entry.tokens += pair[1].tokens
        entry.requests += pair[1].requests
      }
      out.push({ t: hs, label: pad2(h) + ':00', short: pad2(h), cost: part.cost, tokens: part.tokens, requests: part.requests, models: modelsOf(part, 4).models })
    }
    agg.cost = Math.round(agg.cost * 1000000) / 1000000
    const res = baseResult('day', ymdLocal(Date.now()), liveSession)
    res.buckets = out
    res.cost = agg.cost
    res.tokens = agg.tokens
    res.requests = agg.requests
    const ranked = modelsOf(agg, 10)
    res.models = ranked.models
    res.smallModels = ranked.smallModels
    res.peak = peak
    return res
  }

  function weekSnap(liveSession) {
    const start = localWeekStart(Date.now())
    const out = []
    const agg = newAggregate()
    let peak = 0
    for (let d = 0; d < 7; d += 1) {
      const ds = start + d * DAY_MS
      const part = sumRange(ds, ds + DAY_MS)
      // Days the live ledger never saw come from the imported bill.
      addHistoryRange(part, ds, ds + DAY_MS)
      if (part.cost > peak) peak = part.cost
      agg.cost += part.cost
      agg.tokens += part.tokens
      agg.requests += part.requests
      for (const pair of part.models) {
        let entry = agg.models.get(pair[0])
        if (entry === undefined) { entry = { cost: 0, tokens: 0, requests: 0 }; agg.models.set(pair[0], entry) }
        entry.cost += pair[1].cost
        entry.tokens += pair[1].tokens
        entry.requests += pair[1].requests
      }
      out.push({ t: ds, label: WEEK_LABELS[d], short: WEEK_LABELS[d], cost: part.cost, tokens: part.tokens, requests: part.requests, models: modelsOf(part, 4).models })
    }
    agg.cost = Math.round(agg.cost * 1000000) / 1000000
    const res = baseResult('week', ymdLocal(start) + ' ~ ' + ymdLocal(start + 6 * DAY_MS), liveSession)
    res.buckets = out
    res.cost = agg.cost
    res.tokens = agg.tokens
    res.requests = agg.requests
    const ranked = modelsOf(agg, 10)
    res.models = ranked.models
    res.smallModels = ranked.smallModels
    res.peak = peak
    return res
  }

  function monthSnap(liveSession) {
    const now = Date.now()
    const start = localMonthStart(now)
    const end = localMonthEnd(now)
    const todayStart = localDayStart(now)
    const firstDow = new Date(start).getDay()
    const lead = firstDow === 0 ? 6 : firstDow - 1
    const dayCount = Math.round((end - start) / DAY_MS)
    const cells = []
    for (let i = 0; i < lead; i += 1) cells.push({ day: 0, cost: 0, tokens: 0, requests: 0, today: false })
    let monthCost = 0
    let monthTokens = 0
    let monthRequests = 0
    let calendarPeak = 0
    const monthAgg = newAggregate()
    const perDay = []
    for (let d = 0; d < dayCount; d += 1) {
      const ds = start + d * DAY_MS
      const part = sumRange(ds, ds + DAY_MS)
      // Days the live ledger never saw come from the imported bill.
      addHistoryRange(part, ds, ds + DAY_MS)
      const cell = { day: d + 1, cost: part.cost, tokens: part.tokens, requests: part.requests, today: ds === todayStart }
      cells.push(cell)
      perDay.push(cell)
      monthCost += part.cost
      monthTokens += part.tokens
      monthRequests += part.requests
      for (const pair of part.models) {
        let entry = monthAgg.models.get(pair[0])
        if (entry === undefined) { entry = { cost: 0, tokens: 0, requests: 0 }; monthAgg.models.set(pair[0], entry) }
        entry.cost += pair[1].cost
        entry.tokens += pair[1].tokens
        entry.requests += pair[1].requests
      }
      if (part.cost > calendarPeak) calendarPeak = part.cost
    }
    while (cells.length % 7 !== 0) cells.push({ day: 0, cost: 0, tokens: 0, requests: 0, today: false })
    const res = baseResult('month', new Date(start).getFullYear() + ' 年 ' + (new Date(start).getMonth() + 1) + ' 月', liveSession)
    res.buckets = perDay.map((c) => ({ t: start + (c.day - 1) * DAY_MS, label: String(c.day), short: String(c.day), cost: c.cost, tokens: c.tokens, requests: c.requests, models: [] }))
    res.calendar = cells
    res.calendarPeak = calendarPeak
    res.cost = Math.round(monthCost * 1000000) / 1000000
    res.tokens = monthTokens
    res.requests = monthRequests
    const rankedMonth = modelsOf(monthAgg, 10)
    res.models = rankedMonth.models
    res.smallModels = rankedMonth.smallModels
    res.peak = calendarPeak
    return res
  }

  function snapOf(mode, liveSession) {
    if (mode === 'day') return daySnap(liveSession)
    if (mode === 'week') return weekSnap(liveSession)
    if (mode === 'month') return monthSnap(liveSession)
    return hourSnap(liveSession)
  }

  function status() {
    let minIndex = null
    let maxIndex = null
    for (const key of buckets.keys()) {
      if (minIndex === null || key < minIndex) minIndex = key
      if (maxIndex === null || key > maxIndex) maxIndex = key
    }
    // How the imported hours actually land on the current month: an imported
    // hour is shadowed when the live ledger already covers it.
    let kept = 0
    let shadowed = 0
    const monthStart = localMonthStart(Date.now())
    const monthEnd = localMonthEnd(Date.now())
    for (let h = Math.floor(monthStart / HOUR_MS); h <= Math.floor((monthEnd - 1) / HOUR_MS); h += 1) {
      if (!importedHistory.has(hourKeyOf(h * HOUR_MS))) continue
      if (liveRequestsInHour(h * HOUR_MS) > 0) shadowed += 1
      else kept += 1
    }
    historyHoursKept = kept
    historyHoursShadowed = shadowed
    return {
      ok: true,
      plugin: 'dsh-cost-speed',
      nowLocal: new Date().toString().slice(0, 24),
      callsRecorded,
      liveCalls: liveCount,
      backfillCount,
      backfillScanned,
      duplicateSkipped,
      bucketCount: buckets.size,
      ledgerSize: ledger.length,
      ledgerRestored,
      routesLive,
      ledgerSaved,
      ledgerDiscarded,
      historyImported,
      historyHoursKept,
      historyHoursShadowed,
      historyPath,
      saveFailures,
      persistedBytes,
      ledgerPath,
      configPath,
      storageHome,
      retentionMinLocal: minIndex === null ? null : new Date(minIndex * MIN_STEP_MS).toString().slice(0, 24),
      retentionMaxLocal: maxIndex === null ? null : new Date(maxIndex * MIN_STEP_MS).toString().slice(0, 24),
      oldestEventLocal: oldestEvent === null ? null : new Date(oldestEvent).toString().slice(0, 24),
      snapshotCalls,
      unpricedTokens: unpricedList(),
      errors
    }
  }

  // ── transport ─────────────────────────────────────────────────────────────

  function sendJson(res, body, status = 200) {
    const text = JSON.stringify(body)
    if (typeof res.setHeader === 'function') {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
    }
    if (status !== 200 && typeof res.statusCode === 'number') res.statusCode = status
    res.end(text)
  }

  function readBody(req, limit = 65536) {
    return new Promise((resolve, reject) => {
      let size = 0
      let tooLarge = false
      const chunks = []
      req.on('data', (chunk) => {
        if (tooLarge) return
        size += chunk.length
        if (size > limit) {
          tooLarge = true
          chunks.length = 0
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (tooLarge) {
          const error = new Error('request body too large')
          error.code = 'body-too-large'
          reject(error)
          return
        }
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', () => reject(new Error('request aborted')))
    })
  }

  // The Web carrier is not guaranteed to exist when this row activates: rows are
  // composed in dependency order and a patch-layer row sits last, so asking once
  // and giving up would leave the panel permanently without data. Adopt the same
  // reactive pattern @deepseek-ai/dsh-client-modules uses for its bundle route.
  const registerRoutes = (webCtx) => {
    const webServer = webCtx.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      note('webServer', '服务不可用，浏览器面板无法取数')
      return
    }
    webCtx.effect(() => {
    routesLive = true
    const releases = []
    const claim = (kind, path, handler) => {
      try {
        releases.push(webServer.register({ kind, path, handler }))
      } catch (error) {
        note('route ' + path, error)
      }
    }

    const boundHost = typeof webServer.host === 'string' ? webServer.host : ''
    const loopbackOnly = boundHost.length > 0 && isLoopbackHost(boundHost)
    const allow = (req, res) => {
      if (isTrustedRequest(req, loopbackOnly)) return true
      sendJson(res, { ok: false, error: 'forbidden' }, 403)
      return false
    }
    const allowRead = (req, res) => {
      if (!allow(req, res)) return false
      if (req.method !== 'GET') {
        sendJson(res, { ok: false, error: 'method not allowed' }, 405)
        return false
      }
      return true
    }
    const isJson = (req) => String(req.headers['content-type'] === undefined ? '' : req.headers['content-type'])
      .toLowerCase().startsWith('application/json')
    const allowWrite = (req, res) => {
      if (!allow(req, res)) return false
      if (req.method !== 'POST') {
        sendJson(res, { ok: false, error: 'method not allowed' }, 405)
        return false
      }
      if (!isJson(req)) {
        sendJson(res, { ok: false, error: 'content-type must be application/json' }, 415)
        return false
      }
      return true
    }

    claim('exact', SNAPSHOT_PATH, (req, res) => {
      if (!allowRead(req, res)) return
      snapshotCalls += 1
      let mode = 'hour'
      let liveSession
      try {
        const query = String(req.url || '').split('?')[1] || ''
        const found = /(?:^|&)mode=([a-z]+)/.exec(query)
        if (found !== null) mode = found[1]
        // The dock passes the session it is rendering so the live readout is
        // that conversation's, not merely the most recently active one.
        const sid = /(?:^|&)session=([^&]+)/.exec(query)
        if (sid !== null) {
          try { liveSession = decodeURIComponent(sid[1]) } catch (error) { liveSession = sid[1] }
        }
      } catch (error) {
        mode = 'hour'
      }
      tpsPrune(Date.now())
      try {
        sendJson(res, snapOf(mode, liveSession))
      } catch (error) {
        note('snapshot', error)
        sendJson(res, { ok: false, error: 'snapshot failed' }, 500)
      }
    })

    claim('exact', CONFIG_PATH, async (req, res) => {
      if (!allow(req, res)) return
      if (req.method === 'GET') {
        sendJson(res, { ok: true, config })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, { ok: false, error: 'method not allowed' }, 405)
        return
      }
      if (!isJson(req)) {
        sendJson(res, { ok: false, error: 'content-type must be application/json' }, 415)
        return
      }
      try {
        const body = await readBody(req, 65536)
        const parsed = body.length > 0 ? JSON.parse(body) : null
        if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.rules)) {
          const rules = sanitizeRules(parsed.rules)
          if (rules.length === 0) {
            sendJson(res, { ok: false, error: '规则为空：至少保留一条兜底规则（provider/model 均为 *）' }, 400)
            return
          }
          config = { note: typeof parsed.note === 'string' ? parsed.note.slice(0, 500) : config.note, rules }
          await saveConfig()
          sendJson(res, { ok: true, saved: true, rules: rules.length })
          return
        }
        sendJson(res, { ok: false, error: 'expected { rules: [...] }' }, 400)
      } catch (error) {
        note('config', error)
        if (error.code === 'body-too-large') sendJson(res, { ok: false, error: 'payload too large' }, 413)
        else sendJson(res, { ok: false, error: 'invalid payload' }, 400)
      }
    })

    claim('exact', SELFTEST_PATH, (req, res) => {
      if (!allowRead(req, res)) return
      sendJson(res, { ok: true, plugin: MARKER, live: true })
    })

    // Fast path for the live throughput band: the normal snapshot is polled at
    // 15-120 s, which is far too slow to show a moving rate. This returns the
    // live slice alone so the browser can hit it at 2 Hz without paying for a
    // full bucket aggregation each time.
    claim('exact', BASE_PATH + '/live', (req, res) => {
      if (!allowRead(req, res)) return
      let liveSession
      try {
        const query = String(req.url || '').split('?')[1] || ''
        const sid = /(?:^|&)session=([^&]+)/.exec(query)
        if (sid !== null) {
          try { liveSession = decodeURIComponent(sid[1]) } catch (error) { liveSession = sid[1] }
        }
      } catch (error) {
        liveSession = undefined
      }
      tpsPrune(Date.now())
      try {
        sendJson(res, { ok: true, now: Date.now(), live: tpsSnapshot(liveSession, Date.now()) })
      } catch (error) {
        note('live', error)
        sendJson(res, { ok: false, error: 'live snapshot failed' }, 500)
      }
    })

    // Accepts { hours: [ { k, c, t, n, m: [[model, cost, tokens, requests], ...] } ] }
    // produced offline from the vendor bill. Replaces the stored history wholesale.
    claim('exact', BASE_PATH + '/import', async (req, res) => {
      if (!allowWrite(req, res)) return
      try {
        const body = await readBody(req, 524288)
        const parsed = body.length > 0 ? JSON.parse(body) : null
        const hours = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.hours) ? parsed.hours : null
        if (hours === null) {
          sendJson(res, { ok: false, error: 'expected { hours: [...] }' }, 400)
          return
        }
        if (hours.length > 20000) {
          sendJson(res, { ok: false, error: 'too many hours' }, 413)
          return
        }
        importedHistory.clear()
        historyImported = 0
        for (const h of hours) {
          if (h === null || typeof h !== 'object' || typeof h.k !== 'string' || !Array.isArray(h.m)) continue
          const models = new Map()
          for (const m of h.m) {
            if (!Array.isArray(m) || m.length < 4) continue
            models.set(String(m[0]), { cost: Number(m[1]) || 0, tokens: Number(m[2]) || 0, requests: Number(m[3]) || 0 })
          }
          importedHistory.set(h.k, { cost: Number(h.c) || 0, tokens: Number(h.t) || 0, requests: Number(h.n) || 0, models })
          historyImported += 1
        }
        historyDirty = true
        await saveHistory()
        sendJson(res, { ok: true, hours: importedHistory.size })
      } catch (error) {
        note('import', error)
        if (error.code === 'body-too-large') sendJson(res, { ok: false, error: 'payload too large' }, 413)
        else sendJson(res, { ok: false, error: 'invalid payload' }, 400)
      }
    })

    claim('exact', BASE_PATH + '/diag', (req, res) => {
      if (!allowRead(req, res)) return
      sendJson(res, status())
    })

    return () => {
      routesLive = false
      for (const release of releases) {
        if (typeof release === 'function') release()
      }
    }
    }, 'dsh-cost-speed: http routes')
  }

  if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], registerRoutes)
  else registerRoutes(ctx)

  // ── lifecycle ─────────────────────────────────────────────────────────────

  ctx.effect(() => {
    let cancelled = false
    const boot = async () => {
      await restore()
      if (cancelled) return
      try {
        await backfillFromSessions()
      } catch (error) {
        note('backfill', error)
      }
      const removed = prune()
      dirty = true
      await saveLedger()
      console.log('[cost-speed] ready: ' + String(buckets.size) + ' minute buckets (pruned ' + String(removed)
        + '), restored ' + String(ledgerRestored) + ', backfilled ' + String(backfillCount)
        + ' (deduped ' + String(duplicateSkipped) + '), bill hours ' + String(historyImported))
    }
    boot()
    return () => { cancelled = true }
  })

  ctx.effect(() => {
    const stop = ctx.interval(() => { saveLedger(); saveHistory() }, 60000)
    return () => { stop() }
  })
}

export { apply, inject, isTrustedRequest, sanitizeRules, DEFAULT_CONFIG }
export default { apply, inject }
