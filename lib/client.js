/**
 * Cost monitor, browser half.
 *
 * Sits in the composer dock directly under the token / cache-hit strip and
 * shows the live RMB estimate. Hovering opens the four-panel card:
 * hour (minute line chart), day (24 hourly bars with the value on top),
 * week (Mon-Sun bars), month (calendar heat grid with the amount per day).
 *
 * Data comes from the host half over HTTP. The client probes the direct route
 * first and falls back to the /api alias if the webserver sits behind auth.
 *
 * If the dock row is not laid out the way this deployment renders it, the pill
 * can be dragged: an Alt/Shift-drag or any drag lasting past the threshold
 * switches it to a floating position that is remembered in localStorage.
 */

window.__ModuleLoader__.load({
  id: 'dsh-cost-speed',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const el = React.createElement

    const CSS = [
      '.dcm-row{box-sizing:border-box;width:max-content;max-width:var(--dsh-chat-content-width,748px);display:flex;justify-content:flex-end;padding:0 calc(var(--dsh-composer-side-clearance,16px) + 16px);margin-left:auto;margin-right:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px}',
      '.dcm-anchor{position:relative;min-width:0;display:inline-flex}',
      '.dcm-anchor.dcm-floating{position:fixed;right:auto;bottom:auto;z-index:65}',
      '.dcm-pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;white-space:nowrap;background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:default;user-select:none}',
      '.dcm-pill.dcm-open{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dcm-pill.dcm-draggable{cursor:grab}',
      '.dcm-pill.dcm-dragging{cursor:grabbing;background:var(--dsw-alias-interactive-bg-hover)}',
      '.dcm-glyph{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center}',
      // The dock container is `justify-content:center` with a 12px gap, so any
      // change in this pill's width shifts the whole row (icon, stats, cost,
      // context meter all move). The live segment therefore reserves its space
      // permanently and only ever fills it in: the row is measured once and
      // never reflows when a stream starts or stops.
      '.dcm-liveslot{display:inline-flex;align-items:center;gap:5px;flex:none;min-width:var(--dcm-live-w,86px);justify-content:flex-start}',
      '.dcm-liveslot::before{content:"";flex:none;width:1px;height:11px;margin-right:4px;background:var(--dsw-alias-separator-primary);opacity:0;transition:opacity .12s ease}',
      '.dcm-liveslot.dcm-live-on::before{opacity:1}',
      '.dcm-live{display:inline-flex;align-items:center;gap:5px;opacity:0;transition:opacity .12s ease}',
      '.dcm-live.dcm-live-on{opacity:1}',
      '.dcm-live b{font-weight:600;color:var(--dsw-alias-state-business-primary,#6b5ce7);font-variant-numeric:tabular-nums}',
      '.dcm-live-idle{color:var(--dsw-alias-label-caption,#9aa1ac)}',
      // Tabular figures keep the digits from changing width as the number
      // ticks; the fixed slot above handles the rest.
      '.dcm-live b,.dcm-live span{font-variant-numeric:tabular-nums}',
      '.dcm-lvrows{display:flex;flex-wrap:wrap;gap:2px 14px;margin:4px 0 2px;font-variant-numeric:tabular-nums}',
      '.dcm-lv{display:flex;gap:5px;align-items:baseline}',
      '.dcm-lv i{font-style:normal;color:var(--dsw-alias-label-tertiary)}',
      '.dcm-lv b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dcm-lv-est b{color:var(--dsw-alias-label-secondary)}',
      '.dcm-lvsep{width:100%;height:0;border-top:.5px solid var(--dsw-alias-border-l1);margin:4px 0 0}',
      '.dcm-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}',
      '.dcm-amount{font-weight:600;color:var(--dsw-alias-state-business-primary,#6b5ce7)}',
      '.dcm-pop{position:absolute;right:0;bottom:100%;padding-bottom:10px;z-index:70}',
      '.dcm-pop.dcm-flipped{bottom:auto;top:100%;padding-bottom:0;padding-top:10px}',
      '.dcm-card{box-sizing:border-box;width:430px;max-width:calc(100vw - 28px);padding:10px 12px 12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base,#fff);box-shadow:0 12px 32px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
      '.dcm-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dcm-title{font-weight:600;font-size:12.5px}',
      '.dcm-sub{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dcm-headline{margin:5px 0 2px;font-size:22px;font-weight:700;color:var(--dsw-alias-state-business-primary,#6b5ce7);letter-spacing:-.4px}',
      '.dcm-headline span{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary);letter-spacing:0}',
      '.dcm-tabs{display:flex;gap:3px;margin:7px 0 2px;background:var(--dsw-alias-interactive-bg-hover);border-radius:7px;padding:2px}',
      '.dcm-tab{flex:1;text-align:center;padding:3px 0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11.5px;border-radius:5px;cursor:pointer;font-family:inherit}',
      '.dcm-tab-on{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-state-business-primary,#6b5ce7);font-weight:600}',
      '.dcm-chart{position:relative;height:110px;margin:8px 0 2px;cursor:crosshair}',
      '.dcm-svg{display:block;width:100%;height:110px;overflow:visible}',
      '.dcm-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1}',
      '.dcm-axis{fill:var(--dsw-alias-label-caption,#9aa1ac);font-size:9px}',
      '.dcm-brow{display:flex;align-items:stretch;height:132px}',
      '.dcm-yax{flex:none;width:38px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;align-items:flex-end;padding:13px 6px 0 0;font-size:9px;line-height:9px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dcm-bars{position:relative;flex:1 1 auto;min-width:0;display:flex;align-items:stretch;height:100%;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dcm-col{flex:1 1 0;min-width:0;height:100%;display:flex;flex-direction:column;align-items:center;position:relative}',
      '.dcm-vlabel{flex:none;height:13px;line-height:13px;font-size:8.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;font-variant-numeric:tabular-nums}',
      '.dcm-vwrap{flex:1 1 auto;width:100%;min-height:0;display:flex;align-items:flex-end;justify-content:center}',
      '.dcm-vbar{width:62%;border-radius:2px 2px 0 0;background:var(--dsw-alias-state-business-primary,#6b5ce7);opacity:.88}',
      '.dcm-xrow{display:flex;margin-top:3px}',
      '.dcm-xrow.dcm-xrow-pad{padding-left:38px}',
      '.dcm-xlab{flex:1 1 0;min-width:0;text-align:center;font-size:9px;color:var(--dsw-alias-label-caption,#9aa1ac);overflow:hidden;white-space:nowrap}',
      '.dcm-calhdr{display:flex;margin-top:8px}',
      '.dcm-calhdr div{flex:1;text-align:center;font-size:10px;color:var(--dsw-alias-label-caption,#9aa1ac);padding-bottom:2px}',
      '.dcm-cal{display:flex;flex-wrap:wrap}',
      '.dcm-cell{width:14.2857%;box-sizing:border-box;padding:1px}',
      '.dcm-cellin{height:42px;border-radius:5px;padding:2px 3px;display:flex;flex-direction:column;justify-content:space-between;font-size:9px;line-height:1.1;overflow:hidden}',
      '.dcm-cellin.dcm-today{outline:1px solid var(--dsw-alias-state-business-primary,#6b5ce7)}',
      '.dcm-dnum{font-variant-numeric:tabular-nums;opacity:.85}',
      '.dcm-dcost{font-size:8.5px;font-variant-numeric:tabular-nums;text-align:right}',
      '.dcm-scale{display:flex;align-items:center;gap:5px;margin-top:6px;font-size:9.5px;color:var(--dsw-alias-label-tertiary)}',
      '.dcm-scale i{display:block;width:13px;height:9px;border-radius:2px}',
      '.dcm-tip{position:absolute;top:-6px;transform:translateX(-50%);pointer-events:none;white-space:nowrap;background:var(--dsw-alias-label-primary,#1f2328);color:var(--dsw-alias-bg-base,#fff);border-radius:6px;padding:4px 7px;font-size:11px;line-height:1.35;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:40}',
      '.dcm-tipm{display:flex;justify-content:space-between;gap:12px}',
      '.dcm-legend{display:flex;flex-wrap:wrap;gap:5px 10px;margin:5px 0 0;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.dcm-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}',
      '.dcm-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dcm-btn{border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;font-family:inherit}',
      '.dcm-btn:hover{border-color:var(--dsw-alias-state-business-primary,#6b5ce7);color:var(--dsw-alias-state-business-primary,#6b5ce7)}',
      '.dcm-area{width:100%;box-sizing:border-box;height:150px;margin-top:6px;padding:6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover);color:inherit;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:vertical}',
      '.dcm-msg{margin-top:5px;font-size:11px}',
      '.dcm-err{color:var(--dsw-alias-state-error-primary,#d14343)}',
      '.dcm-ok{color:var(--dsw-alias-state-success-primary,#2f9e44)}',
      '.dcm-mrow{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:1.5px 0}',
      '.dcm-mname{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dcm-bar2{position:relative;height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;flex:1;min-width:22px}',
      '.dcm-bar2 i{position:absolute;left:0;top:0;bottom:0;border-radius:2px}',
      '.dcm-details{margin-top:6px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px}'
    ].join('\n')

    const STYLE_TAG = 'dsh-cost-speed/client.css'
    const PALETTE = ['#6b5ce7', '#2f9e44', '#e8890c', '#d14343', '#1c7ed6', '#ae3ec9', '#0ca678', '#f08c00', '#495057', '#e64980']
    const HEAT = ['#f1f0fb', '#d9d5f5', '#b9b1ec', '#988ce2', '#7a6bda', '#5f4ed0', '#4636b4']
    const MODES = ['hour', 'day', 'week', 'month']
    const SNAPSHOT_BASES = ['/dsh-cost-speed/snapshot', '/api/dsh-cost-speed/snapshot']
    const CONFIG_BASES = ['/dsh-cost-speed/config', '/api/dsh-cost-speed/config']
    const LIVE_BASES = ['/dsh-cost-speed/live', '/api/dsh-cost-speed/live']
    const POS_KEY = 'dsh-cost-speed:pos'
    const DRAG_THRESHOLD = 4

    function installCss() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-cost-speed'
      tag.dataset.pluginCss = STYLE_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { if (tag.parentNode !== null) tag.parentNode.removeChild(tag) }
    }

    function loadPos() {
      try {
        const raw = window.localStorage.getItem(POS_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (parsed !== null && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
          return { left: parsed.left, top: parsed.top }
        }
      } catch (error) {
        return null
      }
      return null
    }

    function savePos(pos) {
      try {
        if (pos === null) window.localStorage.removeItem(POS_KEY)
        else window.localStorage.setItem(POS_KEY, JSON.stringify(pos))
      } catch (error) {
        // storage is best-effort
      }
    }

    function money(n) {
      const v = Number.isFinite(n) ? n : 0
      if (v >= 1000) return v.toFixed(0)
      if (v >= 100) return v.toFixed(1)
      if (v >= 1) return v.toFixed(2)
      if (v > 0) return v.toFixed(3)
      return '0'
    }

    function num(n) {
      const v = Number.isFinite(n) ? Math.round(n) : 0
      return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function shortName(key) {
      const parts = String(key).split('/')
      return parts.length > 1 ? parts[parts.length - 1] : String(key)
    }

    /** TPS: one decimal below 100, whole numbers above, so the pill stays put. */
    function fmtTps(v) {
      if (!Number.isFinite(v) || v < 0) return ''
      return v < 100 ? String(Math.round(v * 10) / 10) : String(Math.round(v))
    }

    /** Compact duration: 45.2s / 2m42s. */
    function fmtDur(ms) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      const s = ms / 1000
      if (s < 60) return (Math.round(s * 10) / 10) + 's'
      const whole = Math.round(s)
      return Math.floor(whole / 60) + 'm' + (whole % 60) + 's'
    }

    function heatColor(value, peak) {
      const ratio = peak > 0 ? value / peak : 0
      const i = Math.min(HEAT.length - 1, Math.max(1, Math.round(ratio * (HEAT.length - 1))))
      return HEAT[i]
    }

    function heatText(value, peak) {
      return (peak > 0 ? value / peak : 0) > 0.45 ? '#fff' : 'var(--dsw-alias-label-primary,#1f2328)'
    }

    const inject = ['slots']

    function apply(ctx) {
      try {
        ctx.effect(() => installCss())
      } catch (error) {
        console.warn('[cost-speed] stylesheet install failed', error)
      }

      const slots = ctx.get('slots')
      if (slots === undefined) {
        console.warn('[cost-speed] slots service unavailable; dock row not registered')
        return
      }

      // `remember` caches the BASE route that answered, never a full URL: the
      // snapshot query string changes with the selected panel, so caching the
      // URL would pin every panel to whichever mode was probed first.
      const snapState = { base: null }
      const cfgState = { base: null }

      async function requestJson(bases, suffix, init, remember) {
        const order = remember.base !== null ? [remember.base] : []
        for (const base of bases) {
          if (order.indexOf(base) < 0) order.push(base)
        }
        for (const base of order) {
          try {
            const res = await fetch(base + suffix, init)
            if (!res.ok) continue
            const data = await res.json()
            remember.base = base
            return data
          } catch (error) {
            continue
          }
        }
        return null
      }

      function fetchSnapshot(forMode) {
        return requestJson(SNAPSHOT_BASES, '?mode=' + encodeURIComponent(forMode), { headers: { accept: 'application/json' } }, snapState)
          .then((data) => (data !== null && data.ok === true ? data : null))
      }

      // Live throughput is polled far faster than cost, so it uses its own
      // route and its own base cache: sharing snapState would let a slow cost
      // response pin the fast path to a base that a mode change invalidated.
      const liveState = { base: null }

      function fetchLive(sessionId) {
        const suffix = sessionId === undefined || sessionId === null
          ? ''
          : '?session=' + encodeURIComponent(String(sessionId))
        return requestJson(LIVE_BASES, suffix, { headers: { accept: 'application/json' } }, liveState)
          .then((data) => (data !== null && data.ok === true ? data.live : null))
      }

      function saveConfig(payload) {
        return requestJson(CONFIG_BASES, '', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        }, cfgState)
      }

      function CostDock(props) {
        // The dock owner hands every row a session-scoped `sessionId`, which is
        // how the live readout targets the conversation being viewed rather
        // than whichever stream moved last.
        const sessionId = props !== null && typeof props === 'object' ? props.sessionId : undefined
        // Open on the day view; the choice is not persisted across mounts.
        const [mode, setMode] = React.useState('day')
        const [data, setData] = React.useState(null)
        const [live, setLive] = React.useState(null)
        const [open, setOpen] = React.useState(false)
        const [editing, setEditing] = React.useState(false)
        const [draft, setDraft] = React.useState('')
        const [msg, setMsg] = React.useState(null)
        const [hover, setHover] = React.useState(null)
        const [expanded, setExpanded] = React.useState(false)
        const [pos, setPos] = React.useState(() => loadPos())
        const [dragging, setDragging] = React.useState(false)
        const modeRef = React.useRef('day')
        const sessionRef = React.useRef(sessionId)
        const dragRef = React.useRef(null)
        const closeRef = React.useRef(null)
        modeRef.current = mode
        sessionRef.current = sessionId

        React.useEffect(() => () => {
          if (closeRef.current !== null) window.clearTimeout(closeRef.current)
        }, [])

        React.useEffect(() => {
          let alive = true
          const pull = () => {
            fetchSnapshot(modeRef.current).then((res) => {
              if (alive && res !== null) setData(res)
            })
          }
          pull()
          // Browser timers, not ctx.interval: this half runs in the page, where
          // the Cordis timer service is not mounted.
          const period = mode === 'hour' || mode === 'day' ? 15000 : 120000
          const handle = window.setInterval(pull, period)
          return () => { alive = false; window.clearInterval(handle) }
        }, [mode])

        // Live throughput ticks far faster than cost: 500 ms while a stream is
        // running (so the number visibly moves), 2 s when idle, where it only
        // needs to notice that the next generation has started.
        React.useEffect(() => {
          let alive = true
          let handle = null
          let cancelled = false
          const tick = () => {
            fetchLive(sessionRef.current).then((res) => {
              if (!alive) return
              if (res !== null) setLive(res)
              if (cancelled) return
              const fast = res !== null && res.generating === true
              handle = window.setTimeout(tick, fast ? 500 : 2000)
            })
          }
          tick()
          return () => {
            alive = false
            cancelled = true
            if (handle !== null) window.clearTimeout(handle)
          }
        }, [])

        function onPointerDown(event) {
          if (event.button !== 0) return
          const box = event.currentTarget.getBoundingClientRect()
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originLeft: box.left,
            originTop: box.top,
            moved: false
          }
          event.currentTarget.setPointerCapture(event.pointerId)
        }

        function onPointerMove(event) {
          const drag = dragRef.current
          if (drag === null || drag.pointerId !== event.pointerId) return
          const dx = event.clientX - drag.startX
          const dy = event.clientY - drag.startY
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
          drag.moved = true
          if (!dragging) setDragging(true)
          const maxLeft = Math.max(0, window.innerWidth - 120)
          const maxTop = Math.max(0, window.innerHeight - 30)
          setPos({
            left: Math.min(maxLeft, Math.max(0, drag.originLeft + dx)),
            top: Math.min(maxTop, Math.max(0, drag.originTop + dy))
          })
        }

        function onPointerUp(event) {
          const drag = dragRef.current
          if (drag === null || drag.pointerId !== event.pointerId) return
          dragRef.current = null
          setDragging(false)
          try {
            event.currentTarget.releasePointerCapture(event.pointerId)
          } catch (error) {
            // capture may already be gone
          }
          if (drag.moved) {
            setPos((current) => { savePos(current); return current })
            setOpen(false)
          }
        }

        // A tab switch triggers a new fetch, but the previous payload is still
        // in state. Rendering it would draw the wrong chart for a frame, since
        // each mode returns its own bucket count — so only trust a payload whose
        // own `mode` matches the selected tab.
        const src = data !== null && data.mode === mode ? data : null
        const buckets = src !== null && Array.isArray(src.buckets) ? src.buckets : []
        const peak = src !== null && Number.isFinite(src.peak) ? src.peak : 0
        const total = src !== null && Number.isFinite(src.cost) ? src.cost : 0
        const tokens = src !== null && Number.isFinite(src.tokens) ? src.tokens : 0
        const requests = src !== null && Number.isFinite(src.requests) ? src.requests : 0

        const byModel = new Map()
        if (src !== null && Array.isArray(src.models)) {
          for (const m of src.models) byModel.set(m.key, m)
        }
        const ranking = Array.from(byModel.entries()).sort((a, b) => b[1].cost - a[1].cost).slice(0, 4)
        const colorOf = new Map()
        ranking.forEach((entry, i) => colorOf.set(entry[0], PALETTE[i % PALETTE.length]))

        // Live throughput, from the fast /live route. Every figure the density
        // estimator feeds is marked with `~` until the official usage chunk for
        // that step has arrived, at which point `live.exact` is true and the
        // same numbers are exact — the readout itself carries the difference.
        const lv = live !== null && typeof live === 'object' ? live : null
        const lvExact = lv !== null && lv.exact === true
        const lvGenerating = lv !== null && lv.generating === true
        const lvRate = lv !== null && Number.isFinite(lv.tokensPerSecond) ? lv.tokensPerSecond : null
        const lvAvg = lv !== null && Number.isFinite(lv.averageTokensPerSecond) ? lv.averageTokensPerSecond : null
        // Settled rate: measured over the decode span of the finished step, so
        // it stays put while the model is idle. 未结算时才退回进行中的平均值。
        const lvSettledRate = lv !== null && Number.isFinite(lv.settledRate) ? lv.settledRate : null
        const lvCtxRate = lv !== null && Number.isFinite(lv.contextTokensPerSecond) ? lv.contextTokensPerSecond : null
        const lvCtxTokens = lv !== null && Number.isFinite(lv.contextTokens)
          ? lv.contextTokens
          : (lv !== null && Number.isFinite(lv.inputTokens)
            ? lv.inputTokens + (lv.cacheReadTokens || 0) + (lv.cacheWriteTokens || 0)
            : null)
        const lvGenMs = lv !== null && Number.isFinite(lv.generationMs) ? lv.generationMs : null
        const lvSinceSettle = lv !== null && Number.isFinite(lv.sinceSettleMs) ? lv.sinceSettleMs : null
        const lvOut = lv !== null && Number.isFinite(lv.outputTokens) ? lv.outputTokens : null
        const lvTtft = lv !== null && Number.isFinite(lv.firstTokenDelayMs) ? lv.firstTokenDelayMs : null
        const lvStall = lv !== null && Number.isFinite(lv.stallMs) ? lv.stallMs : 0
        const lvElapsed = lv !== null && Number.isFinite(lv.elapsedMs) ? lv.elapsedMs : null
        const tilde = lvExact ? '' : '~'
        // 生成中显示滑窗实时速度；已结算显示冻结的解码速度（不再随空闲时间衰减），
        // 两者都没算出来时才退回进行中的平均值。
        const lvRateLive = lvGenerating ? lvRate : (lvSettledRate !== null ? lvSettledRate : lvAvg)
        const lvOn = lvRateLive !== null && Number.isFinite(lvRateLive) && lvRateLive > 0

        const tabBar = el('div', { className: 'dcm-tabs' },
          MODES.map((id) => el('button', {
            key: id,
            className: 'dcm-tab' + (mode === id ? ' dcm-tab-on' : ''),
            onClick: () => { setMode(id); setHover(null) }
          }, id === 'hour' ? '小时' : id === 'day' ? '日' : id === 'week' ? '周' : '月')))

        function tipBox() {
          if (hover === null || buckets[hover.idx] === undefined) return null
          const b = buckets[hover.idx]
          const rows = Array.isArray(b.models) ? b.models.slice(0, 4).map((m, i) =>
            el('div', { className: 'dcm-tipm', key: String(i) },
              el('span', null, shortName(m.key)),
              el('span', null, '¥' + money(m.cost)))) : null
          return el('div', {
            className: 'dcm-tip',
            style: { left: String(Math.min(Math.max(hover.left, 90), 340)) + 'px' }
          },
            el('div', { style: { fontWeight: 600 } }, (b.label || '') + '　¥' + money(b.cost)),
            el('div', null, num(b.tokens) + ' tokens · ' + String(b.requests) + ' 次'),
            rows)
        }

        function svgChart() {
          const W = 396
          const H = 110
          const padL = 32
          const plotW = W - padL - 4
          const plotH = H - 13 - 6
          const max = peak > 0 ? peak : 1
          const n = buckets.length
          const xAt = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2)
          const yAt = (v) => 6 + plotH - (v / max) * plotH
          const pts = buckets.map((b, i) => xAt(i).toFixed(1) + ',' + yAt(b.cost).toFixed(1))
          const baseY = (6 + plotH).toFixed(1)
          const area = pts.length > 0
            ? padL.toFixed(1) + ',' + baseY + ' ' + pts.join(' ') + ' ' + (padL + plotW).toFixed(1) + ',' + baseY
            : ''
          const children = []
          const fracs = [0, 0.5, 1]
          for (let i = 0; i < fracs.length; i += 1) {
            const y = (6 + plotH - fracs[i] * plotH).toFixed(1)
            children.push(el('line', { key: 'g' + String(i), className: 'dcm-grid', x1: String(padL), x2: String(padL + plotW), y1: y, y2: y }))
            children.push(el('text', { key: 'y' + String(i), className: 'dcm-axis', x: String(padL - 4), y: (Number(y) + 3).toFixed(1), textAnchor: 'end' }, '¥' + money(max * fracs[i])))
          }
          children.push(el('polygon', { key: 'area', points: area, fill: 'var(--dsw-alias-state-business-primary,#6b5ce7)', opacity: 0.13 }))
          children.push(el('polyline', { key: 'line', points: pts.join(' '), fill: 'none', stroke: 'var(--dsw-alias-state-business-primary,#6b5ce7)', strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round' }))
          if (n > 0) {
            children.push(el('text', { key: 'x0', className: 'dcm-axis', x: String(padL), y: String(H - 2), textAnchor: 'start' }, buckets[0].label || ''))
            children.push(el('text', { key: 'xn', className: 'dcm-axis', x: String(padL + plotW), y: String(H - 2), textAnchor: 'end' }, buckets[n - 1].label || ''))
          }
          if (hover !== null && buckets[hover.idx] !== undefined) {
            const b = buckets[hover.idx]
            const cx = xAt(hover.idx).toFixed(1)
            children.push(el('line', { key: 'cross', className: 'dcm-grid', stroke: 'var(--dsw-alias-state-business-primary,#6b5ce7)', strokeDasharray: '3 3', x1: cx, x2: cx, y1: '6', y2: String(6 + plotH) }))
            children.push(el('circle', { key: 'dot', cx: cx, cy: yAt(b.cost).toFixed(1), r: 2.6, fill: 'var(--dsw-alias-state-business-primary,#6b5ce7)' }))
          }
          return el('div', {
            className: 'dcm-chart',
            onMouseMove: (event) => {
              const box = event.currentTarget.getBoundingClientRect()
              if (box.width <= 0 || n === 0) return
              const ratio = (event.clientX - box.left) / box.width
              setHover({ idx: Math.min(n - 1, Math.max(0, Math.round(ratio * (n - 1)))), left: event.clientX - box.left })
            },
            onMouseLeave: () => setHover(null)
          },
            el('svg', { className: 'dcm-svg', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' }, children),
            tipBox())
        }

        function barChart() {
          // 24 hourly bars are ~17px wide and a "¥46.58" label is ~30px, so the
          // top labels collide into an unreadable smear. When the bars are that
          // dense, drop the per-bar labels and read height off a y axis
          // instead; hover still reports the exact value. 7 weekday bars have
          // room, so they keep their labels.
          const dense = buckets.length > 8
          const stride = buckets.length > 20 ? 2 : 1
          const cols = buckets.map((b, i) => {
            const h = peak > 0 ? Math.max(b.cost > 0 ? 2 : 0, (b.cost / peak) * 100) : 0
            const isHover = hover !== null && hover.idx === i
            // The value label occupies its own fixed 13px row; the bar grows
            // inside the remaining space, so a 100% bar can never push its own
            // label out of the chart.
            return el('div', { className: 'dcm-col', key: String(i) },
              el('div', { className: 'dcm-vlabel' }, !dense && b.cost > 0 ? '¥' + money(b.cost) : ''),
              el('div', { className: 'dcm-vwrap' },
                el('div', { className: 'dcm-vbar', style: { height: String(h) + '%', opacity: isHover ? 1 : 0.88 } })))
          })
          const xLabels = el('div', { className: 'dcm-xrow' + (dense ? ' dcm-xrow-pad' : '') },
            buckets.map((b, i) => el('div', { className: 'dcm-xlab', key: String(i) },
              i % stride === 0 ? (b.short || b.label || '') : '')))
          const bars = el('div', {
            className: 'dcm-bars',
            onMouseMove: (event) => {
              const box = event.currentTarget.getBoundingClientRect()
              if (box.width <= 0 || buckets.length === 0) return
              const ratio = (event.clientX - box.left) / box.width
              setHover({ idx: Math.min(buckets.length - 1, Math.max(0, Math.floor(ratio * buckets.length))), left: event.clientX - box.left })
            },
            onMouseLeave: () => setHover(null)
          }, cols, tipBox())
          const yAxis = !dense ? null : el('div', { className: 'dcm-yax' },
            el('div', null, '¥' + money(peak)),
            el('div', null, '¥' + money(peak / 2)),
            el('div', null, '¥0'))
          return el('div', { className: 'dcm-chart', style: { height: 'auto' } },
            el('div', { className: 'dcm-brow' }, yAxis, bars), xLabels)
        }

        function calendar() {
          const cells = src !== null && Array.isArray(src.calendar) ? src.calendar : []
          const maxDay = src !== null && Number.isFinite(src.calendarPeak) ? src.calendarPeak : 0
          const head = el('div', { className: 'dcm-calhdr' },
            ['一', '二', '三', '四', '五', '六', '日'].map((d, i) => el('div', { key: String(i) }, d)))
          const cellNodes = cells.map((c, i) => {
            const filled = c.day > 0 && c.cost > 0
            return el('div', { className: 'dcm-cell', key: String(i) },
              el('div', {
                className: 'dcm-cellin' + (c.today === true ? ' dcm-today' : ''),
                style: {
                  background: filled ? heatColor(c.cost, maxDay) : 'transparent',
                  color: filled ? heatText(c.cost, maxDay) : 'var(--dsw-alias-label-caption,#9aa1ac)'
                }
              },
                el('div', { className: 'dcm-dnum' }, c.day > 0 ? String(c.day) : ''),
                filled ? el('div', { className: 'dcm-dcost' }, money(c.cost)) : null))
          })
          const scale = el('div', { className: 'dcm-scale' },
            el('span', null, '低'),
            HEAT.slice(1).map((c, i) => el('i', { key: String(i), style: { background: c } })),
            el('span', null, '高'),
            el('span', { style: { marginLeft: '6px' } }, '本月 ¥' + money(total)))
          return el('div', { style: { marginTop: '4px' } },
            head,
            el('div', { className: 'dcm-cal' }, cellNodes),
            scale)
        }

        function modelDetails() {
          if (!expanded) return null
          const all = Array.from(byModel.entries()).sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens)
          const rows = all.map((entry, i) => el('div', { className: 'dcm-mrow', key: String(i) },
            el('span', { className: 'dcm-mname', title: entry[0] }, shortName(entry[0])),
            el('div', { className: 'dcm-bar2' },
              el('i', { style: { width: String(total > 0 ? (entry[1].cost / total) * 100 : 0) + '%', background: colorOf.get(entry[0]) || PALETTE[PALETTE.length - 1] } })),
            el('span', null, '¥' + money(entry[1].cost)),
            el('span', { className: 'dcm-sub' }, num(entry[1].tokens))))
          const warn = src !== null && Array.isArray(src.unpricedTokens) && src.unpricedTokens.length > 0
            ? el('div', { className: 'dcm-msg dcm-err' },
              '未计价（只算 token）：' + src.unpricedTokens.map((u) => shortName(u.key) + ' ' + num(u.tokens)).join('；'))
            : null
          return el('div', { className: 'dcm-details' }, rows, warn)
        }

        const editingPanel = !editing ? null : el('div', null,
          el('div', { className: 'dcm-sub', style: { marginTop: '6px' } }, '定价策略 JSON（元 / 百万 tokens；hours 为 24 小时倍率，可做峰谷价；0 = 未计价）'),
          el('textarea', {
            className: 'dcm-area',
            spellCheck: false,
            value: draft,
            onChange: (event) => { setDraft(event.target.value); setMsg(null) }
          }),
          el('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
            el('button', {
              className: 'dcm-btn',
              onClick: () => {
                let parsed = null
                try {
                  parsed = JSON.parse(draft)
                } catch (error) {
                  setMsg({ kind: 'err', text: 'JSON 解析失败：' + String(error && error.message ? error.message : error) })
                  return
                }
                saveConfig(parsed).then((res) => {
                  if (res !== null && res.ok === true) setMsg({ kind: 'ok', text: '已应用 ' + String(res.rules) + ' 条规则' })
                  else setMsg({ kind: 'err', text: '被拒绝：' + String(res !== null && res.error ? res.error : '未知错误') })
                }).catch((error) => setMsg({ kind: 'err', text: '应用失败：' + String(error) }))
              }
            }, '应用'),
            el('button', { className: 'dcm-btn', onClick: () => { setEditing(false); setMsg(null) } }, '收起')),
          msg === null ? null : el('div', { className: 'dcm-msg ' + (msg.kind === 'ok' ? 'dcm-ok' : 'dcm-err') }, msg.text))

        const rangeLabel = src !== null && typeof src.rangeLabel === 'string' ? src.rangeLabel : ''
        const spanLabel = src !== null && typeof src.spanLabel === 'string' ? src.spanLabel : ''
        const modeLabel = mode === 'hour' ? '小时' : mode === 'day' ? '日' : mode === 'week' ? '周' : '月'

        /**
         * Live throughput block for the card.
         *
         * Shows nothing at all before the first stream, so a fresh install does
         * not display a row of dashes. Once a stream has run, the settlement
         * (rate, output, TTFT) persists as the baseline until the next one
         * starts — the same behaviour the standalone plugin had, and the reason
         * the numbers stay readable when the model is idle.
         */
        function livePanel() {
          if (lv === null) return null
          const rows = []
          if (lvGenerating && lvRate !== null) {
            rows.push(el('div', { className: 'dcm-lv', key: 'rate' },
              el('i', null, '实时速度'), el('b', null, tilde + fmtTps(lvRate) + ' tok/s')))
          }
          // 结算后给出解码速度（按实际生成时长算，输出 token / 解码秒数），
          // 与"整步平均"分开显示，免得把首字延迟和工具调用等待混进速度里。
          if (!lvGenerating && lvSettledRate !== null) {
            rows.push(el('div', { className: 'dcm-lv', key: 'settled' },
              el('i', null, lvExact ? '解码速度' : '解码速度(估)'),
              el('b', null, tilde + fmtTps(lvSettledRate) + ' tok/s' +
                (lvGenMs !== null ? '　·　' + fmtDur(lvGenMs) : ''))))
          }
          if (lvAvg !== null && lvAvg > 0 && (lvGenerating || lvSettledRate === null)) {
            rows.push(el('div', { className: 'dcm-lv', key: 'avg' },
              el('i', null, lvGenerating ? '平均速度' : '整步平均'),
              el('b', null, tilde + fmtTps(lvAvg) + ' tok/s')))
          }
          // 整步吞吐：输出 + 输入 + 缓存（含缓存命中）÷ 解码时长。缓存命中的
          // 百万级上下文不进"生成速度"，却确实占用一次调用的上下文。
          if (!lvGenerating && lvCtxRate !== null && lvCtxTokens !== null) {
            rows.push(el('div', { className: 'dcm-lv', key: 'ctx' },
              el('i', null, '含缓存吞吐'),
              el('b', null, fmtTps(lvCtxRate) + ' tok/s　·　' + num(lvCtxTokens) + ' token')))
          }
          if (lvOut !== null && lvOut > 0) {
            rows.push(el('div', { className: 'dcm-lv', key: 'out' },
              el('i', null, lvGenerating ? '实时输出' : '输出'),
              el('b', null, tilde + num(lvOut) + ' token')))
          }
          // TTFB: while the first token has not landed it is the running wait,
          // which is the number that tells you the model is drowning.
          if (lvTtft !== null) {
            rows.push(el('div', { className: 'dcm-lv', key: 'ttft' },
              el('i', null, '首字延迟'), el('b', null, fmtDur(lvTtft))))
          }
          if (lvGenerating && lvStall >= 300) {
            rows.push(el('div', { className: 'dcm-lv', key: 'stall' },
              el('i', null, '已停顿'), el('b', null, fmtDur(lvStall))))
          }
          if (rows.length === 0) return null
          return el('div', null,
            el('div', { className: 'dcm-lvrows' }, rows),
            lvGenerating && !lvExact
              ? el('div', { className: 'dcm-sub', style: { marginTop: '2px' } }, '~ 为估算值，官方 usage 到达后自动校正为精确值')
              : null,
            !lvGenerating && lvSinceSettle !== null && lvSinceSettle > 3000
              ? el('div', { className: 'dcm-sub', style: { marginTop: '2px' } }, '上次生成 ' + fmtDur(lvSinceSettle) + ' 前结束，以下为已冻结的结算值')
              : null,
            el('div', { className: 'dcm-lvsep' }))
        }

        const legend = ranking.length === 0 ? null : el('div', { className: 'dcm-legend' },
          ranking.map((entry, i) => el('span', { key: String(i) },
            el('i', { style: { background: PALETTE[i % PALETTE.length] } }),
            shortName(entry[0]) + ' ¥' + money(entry[1].cost))))

        const body = mode === 'hour' ? svgChart() : (mode === 'month' ? calendar() : barChart())

        const card = !open ? null : el('div', { className: 'dcm-pop' + (pos !== null ? ' dcm-flipped' : '') },
          el('div', { className: 'dcm-card' },
          el('div', { className: 'dcm-head' },
            el('div', { className: 'dcm-title' }, 'DSH 费用监视'),
            el('div', { className: 'dcm-sub' }, spanLabel)),
          el('div', { className: 'dcm-headline' }, '¥' + money(total), el('span', null, '　' + rangeLabel)),
          el('div', { className: 'dcm-sub' }, num(tokens) + ' tokens · ' + String(requests) + ' 次调用'),
          livePanel(),
          tabBar,
          body,
          legend,
          modelDetails(),
          editingPanel,
          el('div', { className: 'dcm-foot' },
            el('span', null, rangeLabel),
            el('button', { className: 'dcm-btn', onClick: () => setExpanded(!expanded) }, expanded ? '逐模型 ▴' : '逐模型 ▾'),
            pos === null
              ? el('button', { className: 'dcm-btn', onClick: () => { const p = { left: Math.max(0, window.innerWidth - 200), top: Math.max(0, window.innerHeight - 120) }; setPos(p); savePos(p) } }, '浮动')
              : el('button', { className: 'dcm-btn', onClick: () => { setPos(null); savePos(null) } }, '归位'),
            el('button', {
              className: 'dcm-btn',
              onClick: () => {
                const cfg = data !== null && data.config !== undefined ? data.config : { note: '', rules: [] }
                setDraft(JSON.stringify({ note: cfg.note || '', rules: cfg.rules || [] }, null, 2))
                setEditing(true)
                setMsg(null)
              }
            }, editing ? '编辑中' : '编辑定价'))))

        const anchorStyle = pos === null ? undefined : { left: String(pos.left) + 'px', top: String(pos.top) + 'px' }

        return el('div', { className: 'dcm-row' },
          el('div', {
            className: 'dcm-anchor' + (pos !== null ? ' dcm-floating' : ''),
            style: anchorStyle,
            onMouseEnter: () => {
              if (closeRef.current !== null) { window.clearTimeout(closeRef.current); closeRef.current = null }
              if (!dragging) setOpen(true)
            },
            onMouseLeave: () => {
              if (editing || dragging) return
              // Closing on the raw leave event would fire while the pointer
              // crosses the gap between the pill and the card, so the card is
              // unreachable. Delay, and cancel the delay on re-entry.
              if (closeRef.current !== null) window.clearTimeout(closeRef.current)
              closeRef.current = window.setTimeout(() => {
                closeRef.current = null
                setOpen(false)
                setHover(null)
              }, 240)
            }
          },
            el('div', {
              className: 'dcm-pill' + (open ? ' dcm-open' : '') + (dragging ? ' dcm-dragging' : ' dcm-draggable'),
              title: '悬停查看小时 / 日 / 周 / 月费用明细；按住可拖动位置',
              onPointerDown,
              onPointerMove,
              onPointerUp,
              onPointerCancel: onPointerUp
            },
              el('span', { className: 'dcm-glyph' },
                el('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
                  el('path', {
                    d: 'M8 1.5a6.5 6.5 0 1 0 6.5 6.5H8V1.5Z',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 1.3
                  }))),
              el('span', { className: 'dcm-amount' }, '¥' + money(total)),
              el('span', { className: 'dcm-sep', 'aria-hidden': true }, '·'),
              el('span', null, num(tokens) + ' tokens'),
              el('span', { className: 'dcm-sep', 'aria-hidden': true }, '·'),
              el('span', null, '按' + modeLabel),
              // Reserved live slot. It is always in the DOM at a fixed width, so
              // the centred dock row never reflows; only its contents fade in
              // and out. Idle renders a placeholder instead of nothing.
              el('span', { className: 'dcm-liveslot' + (lvOn ? ' dcm-live-on' : '') },
                el('span', { className: 'dcm-live' + (lvOn ? ' dcm-live-on' : '') },
                  lvOn
                    ? el('b', null, tilde + fmtTps(lvRateLive) + ' tok/s')
                    : el('span', { className: 'dcm-live-idle' }, '— tok/s')))),
            card))
      }

      try {
        slots.inject('conversation.composer.dock', () => slots.register({
          name: 'conversation.composer.dock',
          id: 'cost-speed',
          order: 1
        }, CostDock))
      } catch (error) {
        console.error('[cost-speed] dock registration failed', error)
      }
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
