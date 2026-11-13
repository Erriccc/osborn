'use client'

// In-app Browser panel (issue #51): watch and drive the browser-screen-recorder
// engine without leaving Voice Native or opening the raw Fly URL. Talks only to
// the server proxy at /api/browser/* (tokens stay server-side).
//
// - Live MJPEG stream + explicit awake/asleep/waking state (so a stuck run is
//   legible instead of a bare "Connecting…").
// - Status: page URL/state, active tab, brain health, current journey/task,
//   stream freshness.
// - Controls over the existing control API: open a URL / new tab, say (+hear the
//   reply), stop the engine.
// - Per-run links: this run's tasks with clip / clip+audio / logs, plus a
//   shareable link to this in-app view.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react'

type EngineState = {
  configured: boolean
  state: string | null
  machineId: string | null
  // The HOSTNAME the proxy targets (e.g. osborn-voice-e2e-n.fly.dev — not a Fly
  // app name), so an engine failure can name the host it hit (#62/#49).
  host?: string | null
  // Set by the server when the Fly Machines API itself couldn't be reached, so
  // `state` is null because we failed to read it — surfaced as an explicit amber
  // "state unreadable" badge instead of a bare "unknown" (#81).
  unreachable?: boolean
  // Server-side only reports whether OSBORN_ENGINE_TOKEN is set — never the value.
  // false ⇒ every drive/output action will 401; the live stream still works.
  engineTokenConfigured?: boolean
  // This person's driver id on the engine (set server-side by the proxy).
  driver?: string
}
type Status = {
  roomReady?: boolean
  pageUrl?: string
  pageState?: string
  idlePaused?: boolean
  brain?: { ready?: boolean; dead?: boolean } | string
  tabsByOwner?: Array<{ i: number; owner: string | null }>
  takeovers?: Array<{ i: number; by: string; prevOwner: string | null; since: number }>
  // The engine reports the active tab as { i, url }; older shapes used a bare
  // number/string. Handle both so the readout never renders "[object Object]".
  activeTab?: number | string | { i?: number; url?: string }
  tabs?: Array<{ i: number; url: string }>
  lastFrameAgeMs?: number
  journey?: { name?: string; goal?: string } | string | null
  // #49/#81: when the auto-joined chat agent can't be reached the engine reports
  // why here (else null). The panel surfaces it instead of spinning on "unknown".
  agentUrl?: string | null
  agentUnreachable?: string | null
}
type Task = { n?: number; index?: number; title?: string; name?: string; goal?: string; journey?: string }

const api = (action: string, qs = '') => `/api/browser/${action}${qs}`

// Whatever was typed or pasted ("URL https://x.com", "x.com/path", "https://…"),
// the address to open: the first http(s) URL, else the first domain-like word.
function toAddress(input: string): string | null {
  const url = input.match(/https?:\/\/\S+/i)?.[0]
  if (url) return url
  const host = input.split(/\s+/).find((w) => /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]\S*)?$/i.test(w))
  if (!host) return null
  return /^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/i.test(host) ? `http://${host}` : `https://${host}`
}
const blankPage = (u?: string) => !u || u === 'about:blank' || u.startsWith('chrome://newtab')
const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40) || 'New tab'
const STARTERS = [
  { label: 'example.com', url: 'https://example.com' },
  { label: 'Mic + audio test (WebRTC samples)', url: 'https://webrtc.github.io/samples/src/content/getusermedia/audio/' },
]

async function jget<T>(action: string, qs = ''): Promise<T | null> {
  try {
    const r = await fetch(api(action, qs), { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

export function BrowserPanel() {
  const [engine, setEngine] = useState<EngineState | null>(null)
  const [watching, setWatching] = useState(false)
  const [streamBroken, setStreamBroken] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [url, setUrl] = useState('')
  const [newTab, setNewTab] = useState(false)
  const [sayText, setSayText] = useState('')
  const [heard, setHeard] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // Set when a drive/output action comes back 401 from the engine (token missing
  // or mismatched server-side) — drives the same banner as engineTokenConfigured.
  const [tokenError, setTokenError] = useState(false)
  // #138: the proxy answers 401 "Not authenticated" to a signed-out visitor.
  // That is NOT an engine problem — say "sign in" and stop polling, instead of a
  // state badge and an endless "Waking…" spinner.
  const [signedOut, setSignedOut] = useState(false)
  const [unresponsivePolls, setUnresponsivePolls] = useState(0)
  const [brokenSince, setBrokenSince] = useState<number | null>(null)
  const [micOpen, setMicOpen] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const typedRef = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: '', timer: null })
  const scrollRef = useRef<{ dy: number; timer: ReturnType<typeof setTimeout> | null }>({ dy: 0, timer: null })
  const inputChain = useRef<Promise<unknown>>(Promise.resolve())
  const streamKickRef = useRef(0)

  // No-wake awake/asleep probe (Fly Machines API via the proxy). If the probe
  // itself can't be reached (proxy/network down), say so explicitly rather than
  // leaving a stale/"unknown" badge (#81).
  const refreshEngineState = useCallback(async () => {
    let r: Response | null = null
    try { r = await fetch(api('engine-state'), { cache: 'no-store' }) } catch { /* network down → unreachable below */ }
    if (r?.status === 401 && /Not authenticated/.test(await r.clone().text().catch(() => ''))) { setSignedOut(true); return }
    const s = r?.ok ? ((await r.json().catch(() => null)) as EngineState | null) : null
    // When the PROXY fetch itself threw there is no reply to read the host from,
    // so keep the last host the server named rather than reporting none (#62/#49).
    setEngine(prev => s ?? { configured: true, state: null, machineId: null, host: prev?.host ?? null, unreachable: true })
  }, [])

  useEffect(() => {
    if (signedOut) return
    refreshEngineState()
    const id = setInterval(refreshEngineState, 15000)
    return () => clearInterval(id)
  }, [refreshEngineState, signedOut])

  // Status polling runs only while watching (it wakes/holds the engine).
  useEffect(() => {
    if (!watching || signedOut) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    const tick = async () => {
      // Don't use jget here: it collapses every non-OK into null, so a 401 on
      // /status (engine token missing/mismatched server-side) would leave the
      // Page/Tab/Brain/Stream fields on "connecting…"/"—" forever with no
      // explanation (#80). Inspect the status instead and flag the misconfig so
      // the banner + the explicit "unavailable" fields show.
      let r: Response | null = null
      try { r = await fetch(api('status'), { cache: 'no-store' }) } catch { return }
      if (!r.ok) {
        // Drop the last status: the badge reads a held-over status object as a live
        // engine, so one that idle-stopped mid-watch stayed green "live". A thrown
        // fetch above never reached our proxy — hold last-known there.
        setStatus(null)
        if (r.status === 401) {
          const t = await r.text().catch(() => '')
          if (/Not authenticated/.test(t)) { setSignedOut(true); setWatching(false) }
          else setTokenError(true)
        }
        return
      }
      const s = (await r.json().catch(() => null)) as Status | null
      setStatus(s); if (s) setTokenError(false)
      setUnresponsivePolls((n) => (s?.pageState === 'unresponsive' ? n + 1 : 0))
    }
    tick()
    pollRef.current = setInterval(tick, 3000)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [watching, signedOut])

  const refreshTasks = useCallback(async () => {
    const t = await jget<{ tasks?: Task[] } | Task[]>('tasks')
    const list = Array.isArray(t) ? t : t?.tasks
    if (Array.isArray(list)) setTasks(list)
  }, [])

  // Re-render every second while the stream is down, so the waiting time counts up.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!streamBroken) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [streamBroken])

  // Inside the engine's own (automated) browser the live view would show
  // itself, then itself again: an endless mirror that freezes the tab.
  const [inEngine, setInEngine] = useState(false)
  useEffect(() => { setInEngine(!!(window as any).__osbornEngine) }, [])

  // The task list keeps itself current while watching.
  useEffect(() => {
    if (!watching || signedOut) return
    refreshTasks()
    const id = setInterval(refreshTasks, 15000)
    return () => clearInterval(id)
  }, [watching, signedOut, refreshTasks])

  const post = useCallback(async (action: string, body: unknown, label: string) => {
    setBusy(label); setNote(null); setTokenError(false)
    try {
      const r = await fetch(api(action), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await r.text()
      let data: any = {}
      try { data = text ? JSON.parse(text) : {} } catch { /* engine 401 is plain text, not JSON */ }
      if (!r.ok) {
        // A 401 that isn't our own "Not authenticated" means the engine rejected
        // us for a missing/mismatched x-engine-token. Surface the SINGLE
        // actionable banner (tokenError) and suppress the redundant, cryptic raw
        // per-action error (#80) — the banner already explains the fix.
        if (r.status === 401 && data?.error !== 'Not authenticated') {
          setTokenError(true)
          return null
        }
        // Cold-start / unreachable come back structured + retriable (#102/#104):
        // the engine was asleep or mid-boot. Show the actionable message as-is
        // (it already tells the user to retry) rather than a bare "say failed: 502".
        if (data?.retriable || data?.code === 'engine_booting' || data?.code === 'engine_unreachable') {
          setNote(data?.error || `${label}: the browser engine is waking — retry in a moment.`)
          return null
        }
        setNote(`${label} failed: ${data?.error || text || r.status}`)
        return null
      }
      return data
    } catch {
      setNote(`${label} failed: engine unreachable`); return null
    } finally {
      setBusy(null)
    }
  }, [])

  const openUrl = async () => {
    const full = toAddress(url.trim())
    if (!full) { setNote('Type a web address, e.g. example.com'); return }
    setUrl(full)
    await post('tab', { op: 'open', url: full, reuse: !newTab }, 'open')
  }
  const say = async () => {
    const text = sayText.trim()
    if (!text) return
    const r = await post('say', { text }, 'say')
    if (r && typeof r.heard === 'string') setHeard(r.heard)
  }
  const openStarter = (u: string) => post('tab', { op: 'open', url: u, reuse: true }, 'open')
  const switchTab = (i: number) => post('tab', { op: 'switch', i }, 'switch tab')
  // Reload acts on the panel's own tab, so make the shown tab ours first.
  const reloadTab = async () => {
    if (activeI != null && !(await post('tab', { op: 'switch', i: activeI }, 'reload tab'))) return
    await post('recover', {}, 'reload tab')
  }
  // Control changes wait for queued input, so a hand-back can't overtake keystrokes sent just before it.
  const afterInput = <T,>(fn: () => Promise<T>) => { flushPending(); const run = inputChain.current.then(fn, fn); inputChain.current = run.catch(() => {}); return run }
  const takeControl = () => activeI != null && afterInput(() => post('tab', { op: 'takeover', i: activeI }, 'take control'))
  // A takeover is handed back to the agent; a tab you opened is released.
  const handBack = () => activeI != null && afterInput(() => post('tab', { op: shownTakeover ? 'handback' : 'release', i: activeI }, 'hand back'))
  // One request at a time, in order: a click then fast typing must not race.
  const sendNow = (body: Record<string, unknown>) => {
    inputChain.current = inputChain.current.then(() => fetch(api('input'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => { if (!r.ok) { const d = await r.json().catch(() => ({})); setNote(d?.error || `input failed: ${r.status}`) } })
      .catch(() => setNote('input failed: engine unreachable')))
  }
  const flushTyped = () => {
    const t = typedRef.current
    if (t.timer) { clearTimeout(t.timer); t.timer = null }
    if (t.text) { const text = t.text; t.text = ''; sendNow({ type: 'type', text }) }
  }
  const flushScroll = () => {
    const sc = scrollRef.current
    if (sc.timer) { clearTimeout(sc.timer); sc.timer = null }
    const dy = Math.round(sc.dy); sc.dy = 0
    if (Math.abs(dy) > 2) sendNow({ type: 'scroll', dy })
  }
  // Anything else first sends the scrolling and typing still held back, in order.
  const flushPending = () => { flushScroll(); flushTyped() }
  const sendInput = (body: Record<string, unknown>) => { flushPending(); sendNow(body) }
  const onPictureClick = (e: MouseEvent<HTMLDivElement>) => {
    const img = imgRef.current
    if (!inControl || !img?.naturalWidth) return
    e.currentTarget.focus()
    // object-contain letterboxes the frame: map the click into the picture itself.
    const box = img.getBoundingClientRect()
    const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight)
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale
    const x = (e.clientX - box.left - (box.width - w) / 2) / w
    const y = (e.clientY - box.top - (box.height - h) / 2) / h
    if (x < 0 || x > 1 || y < 0 || y > 1) return
    sendInput({ type: 'click', x, y })
  }
  const onPictureKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Tab and Escape stay with this page, so the keyboard can always leave the picture (#196).
    if (!inControl || e.metaKey || e.ctrlKey || e.key === 'Tab') return
    if (e.key === 'Escape') { e.currentTarget.blur(); return }
    e.preventDefault()
    const t = typedRef.current
    if (e.key.length === 1) {
      t.text += e.key
      if (t.timer) clearTimeout(t.timer)
      t.timer = setTimeout(flushTyped, 150)
    } else if (['Enter', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
      sendInput({ type: 'key', key: e.key })
    }
  }
  // Trackpads fire ~60 wheel events a second: add them up, send every 200ms.
  const onPictureWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!inControl) return
    const sc = scrollRef.current
    sc.dy += e.deltaY
    if (!sc.timer) sc.timer = setTimeout(flushScroll, 200)
  }
  const stopEngine = async () => {
    const drivers = (status?.tabsByOwner ?? []).map((o) => o.owner).filter((o, k, all): o is string => !!o && o !== me && all.indexOf(o) === k)
    if (!confirm(`Shut down the browser engine? It ends every run on it, for everyone${drivers.length ? ` (now driving: ${drivers.map(label).join(', ')})` : ''}, and the machine sleeps.`)) return
    if (await post('end', { shutdown: true }, 'shut down')) setWatching(false)  // confirmed: stop it for everyone
  }

  const taskN = (t: Task, i: number) => (typeof t.n === 'number' ? t.n : typeof t.index === 'number' ? t.index : i)
  const asleep = engine?.state && engine.state !== 'started'
  // #81: the engine tells us when the auto-joined chat agent is unreachable.
  // Only a configured agent can be unreachable; none configured is plain browsing.
  const agentUnreachable = watching && status?.agentUrl ? status?.agentUnreachable ?? null : null
  // The server is missing the engine token if it says so up front, or if a drive
  // action just came back 401. Either way, every control/output action will fail.
  const tokenMisconfigured = engine?.engineTokenConfigured === false || tokenError
  const brainReady = typeof status?.brain === 'object' ? status?.brain?.ready && !status?.brain?.dead
    : typeof status?.brain === 'string' ? status.brain === 'ready' : undefined
  const activeI = typeof status?.activeTab === 'object' ? status.activeTab?.i : undefined
  // Two polls in a row: one 'unresponsive' is often just a page mid-navigation.
  const frozen = watching && unresponsivePolls >= 2
  const shownOwner = status?.tabsByOwner?.find((o) => o.i === activeI)?.owner ?? null
  const me = engine?.driver
  const shownTakeover = status?.takeovers?.find((t) => t.i === activeI) ?? null
  // In control: you took the tab over, or it is simply yours (you opened it).
  const inControl = !!me && (shownTakeover ? shownTakeover.by === me : shownOwner === me)
  const label = (d: string | null | undefined) => (d && d === me ? 'you' : d?.replace(/^person:/, '') ?? '')
  const blank = watching && !!status && blankPage(status.pageUrl)

  // Closing the page while in control hands the tab back instead of leaving the
  // agent paused (the engine also hands back after 10 idle minutes).
  useEffect(() => {
    if (!inControl || !shownTakeover || activeI == null) return
    const i = activeI
    const bye = () => navigator.sendBeacon(api('tab'), new Blob([JSON.stringify({ op: 'handback', i })], { type: 'application/json' }))
    window.addEventListener('pagehide', bye)
    return () => window.removeEventListener('pagehide', bye)
  }, [inControl, shownTakeover, activeI])
  const copyShare = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setNote('Link copied') } catch { setNote('Copy failed') }
  }

  if (signedOut) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-950 px-6 py-12 text-center text-neutral-200">
        <span className="text-2xl">🎥</span>
        <h2 className="text-base font-semibold text-neutral-100">Sign in to watch and drive the browser engine</h2>
        <p className="max-w-md text-sm text-neutral-400">
          The live browser view and its controls are available to signed-in accounts.
        </p>
        <a href="/login?next=/browser" className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400">
          Sign in
        </a>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 text-neutral-200">
      {/* Header / engine state */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">🎥</span>
          <h2 className="text-base font-semibold text-neutral-100">Browser</h2>
          <StateBadge engine={engine} watching={watching} status={status} tokenMisconfigured={tokenMisconfigured} agentUnreachable={agentUnreachable} />
        </div>
        <div className="flex items-center gap-2">
          {watching && (
            <button
              onClick={() => setWatching(false)}
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
            >
              Stop watching
            </button>
          )}
          <button onClick={copyShare} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800">
            Copy viewer link
          </button>
          {watching && (
            <button onClick={stopEngine} disabled={!!busy} title="Ends every run on the engine, for everyone, and puts it to sleep" className="rounded-lg border border-red-900/60 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/40 disabled:opacity-50">
              Shut down engine
            </button>
          )}
        </div>
      </div>

      {!watching && note && <p className="text-xs text-neutral-400">{note}</p>}

      {/* Engine-token misconfiguration banner — makes the server-side token
          problem legible instead of a cryptic per-action 401. */}
      {tokenMisconfigured && (
        <div className="rounded-lg border border-amber-600/60 bg-amber-950/40 px-3 py-2 text-xs leading-relaxed text-amber-200">
          <span className="font-semibold">The server isn’t configured with the engine token.</span>{' '}
          Drive and output actions (Open URL, Say, logs, audio, clips, Stop) are being
          rejected — ask an admin to set{' '}
          <code className="rounded bg-black/40 px-1 font-mono text-amber-100">OSBORN_ENGINE_TOKEN</code>{' '}
          on the Railway frontend to match the engine’s Fly secret. Watching the live
          stream still works without it.
        </div>
      )}

      {/* Agent-unreachable notice (#81) — the engine is up and drivable, but the
          auto-joined chat agent can't be reached, so the streamed /chat tab would
          sit on "Connecting…". Say so explicitly instead of a silent "unknown". */}
      {agentUnreachable && (
        <div className="rounded-lg border border-amber-600/60 bg-amber-950/40 px-3 py-2 text-xs leading-relaxed text-amber-200">
          <span className="font-semibold">Engine reachable, but the chat agent isn’t.</span>{' '}
          {agentUnreachable}. The browser engine stays drivable for plain browsing (Open
          a URL, Say on a mic-bearing page); auto-joining a Voice Native chat needs a
          reachable agent.
        </div>
      )}

      {/* Tabs, like a browser's tab bar: click to show that tab. */}
      {watching && (status?.tabs?.length ?? 0) > 0 && (
        <div className="flex gap-1 overflow-x-auto">
          {status!.tabs!.map((t) => {
            const owner = status?.tabsByOwner?.find((o) => o.i === t.i)?.owner
            const on = t.i === activeI
            return (
              <button key={t.i} onClick={() => switchTab(t.i)} disabled={!!busy || on || (!!owner && owner !== me)} title={owner ? `${t.url} (driven by ${label(owner)})` : t.url}
                className={`flex min-w-0 max-w-[14rem] items-center gap-1 rounded-t-lg border px-2 py-1 text-xs ${on ? 'border-amber-500/70 bg-neutral-800 text-neutral-100' : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:bg-neutral-800'}`}>
                <span className="truncate">{shortUrl(t.url)}</span>
                {owner && <span className="shrink-0 rounded bg-neutral-700 px-1 text-[10px] text-neutral-300">{label(owner)}</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* Address bar, where a browser has it. */}
      {watching && (
        <div className="flex items-center gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') openUrl() }}
            placeholder={status?.pageUrl && !blank ? status.pageUrl : 'Address, e.g. example.com'}
            className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 placeholder-neutral-500 outline-none focus:border-amber-500"
          />
          <label className="flex shrink-0 items-center gap-1 text-xs text-neutral-400"><input type="checkbox" checked={newTab} onChange={(e) => setNewTab(e.target.checked)} /> new tab</label>
          <button onClick={openUrl} disabled={!!busy} className="shrink-0 rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-50">Go</button>
        </div>
      )}

      {/* Control: who drives the shown tab, and taking over / handing back. */}
      {watching && activeI != null && status && (
        inControl ? (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-700/60 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200">
            <span><span className="font-semibold">You have control.</span> Click, type and scroll in the picture; Escape leaves it.{shownTakeover?.prevOwner ? ` ${label(shownTakeover.prevOwner)} is paused until you hand back.` : ''}</span>
            <button onClick={handBack} disabled={!!busy} className="rounded-lg bg-emerald-500 px-3 py-1 font-medium text-black hover:bg-emerald-400 disabled:opacity-50">{shownTakeover ? 'I’m done, hand back' : 'Let agents use this tab'}</button>
          </div>
        ) : shownTakeover ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400">{label(shownTakeover.by)} has control of this tab.</div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400">
            <span>{shownOwner ? `${label(shownOwner)} ${shownOwner === me ? 'are' : 'is'} driving this tab. Taking control pauses it until you hand back.` : 'Nobody is driving this tab.'}</span>
            <button onClick={takeControl} disabled={!!busy} className="rounded-lg border border-neutral-600 px-3 py-1 text-neutral-200 hover:bg-neutral-800 disabled:opacity-50">Take control</button>
          </div>
        )
      )}

      {/* Live view */}
      <div
        tabIndex={inControl ? 0 : -1}
        role={inControl ? 'application' : undefined}
        aria-label={inControl ? 'Remote browser, you have control: clicks and typing go to the page. Press Escape to leave, Tab to move on.' : undefined}
        onClick={onPictureClick}
        onKeyDown={onPictureKey}
        onWheel={onPictureWheel}
        className={`relative aspect-video w-full overflow-hidden rounded-xl border bg-black outline-none ${inControl ? 'cursor-crosshair border-emerald-600' : 'border-neutral-800'}`}>
        {watching ? (
          <>
            {inEngine ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-neutral-400">
                This page is open inside the browser engine itself, so the live view is hidden here: it would show itself endlessly. Watch from your own browser.
              </div>
            ) : (
            <img
              ref={imgRef}
              draggable={false}
              key={streamKickRef.current}
              src={api('stream', `?t=${streamKickRef.current}`)}
              alt="Live browser stream"
              className="h-full w-full object-contain"
              onError={() => { setStreamBroken(true); setBrokenSince((t) => t ?? Date.now()) }}
              onLoad={() => { setStreamBroken(false); setBrokenSince(null) }}
            />
            )}
            {streamBroken && !frozen && !blank && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-center text-sm text-neutral-300">
                {/* `unreachable` only means the Fly state couldn't be READ, so it is
                    no reason to blank this out — that left a bare Retry button (#62/#49). */}
                <div>
                  {status ? 'Reconnecting to the stream…'
                    : brokenSince && Date.now() - brokenSince > 90000 ? 'Still not up after 90 seconds.'
                    : `Waking the browser engine…${brokenSince ? ` ${Math.round((Date.now() - brokenSince) / 1000)}s` : ''} (about 40s)`}
                </div>
                <button
                  onClick={() => { setStreamBroken(false); setBrokenSince(null); streamKickRef.current++; setWatching(false); setTimeout(() => setWatching(true), 50) }}
                  className="rounded-lg border border-neutral-600 px-3 py-1.5 hover:bg-neutral-800"
                >
                  Retry
                </button>
              </div>
            )}
            {!inEngine && frozen && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center text-sm text-neutral-300">
                <div>This tab stopped responding, so there is nothing to show.</div>
                {shownOwner && shownOwner !== me ? (
                  <div className="text-xs text-neutral-400">It is driven by {label(shownOwner)}, which has to reload it. Take control above to reload it yourself.</div>
                ) : (
                  <button onClick={reloadTab} disabled={!!busy} className="rounded-lg bg-amber-500 px-3 py-1.5 font-medium text-black hover:bg-amber-400 disabled:opacity-50">Reload tab</button>
                )}
              </div>
            )}
            {!inEngine && !frozen && blank && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-neutral-950 px-6 text-center text-sm text-neutral-300">
                <div>Nothing is open in this tab. Type an address above, or start with:</div>
                <div className="flex flex-wrap justify-center gap-2">
                  {STARTERS.map((s) => (
                    <button key={s.url} onClick={() => openStarter(s.url)} disabled={!!busy} className="rounded-lg border border-neutral-700 px-3 py-1.5 hover:bg-neutral-800 disabled:opacity-50">{s.label}</button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-neutral-400">
            <button onClick={() => { setStreamBroken(false); setBrokenSince(null); setStatus(null); streamKickRef.current++; setWatching(true) }} className="rounded-lg bg-amber-500 px-5 py-2.5 text-base font-medium text-black hover:bg-amber-400">
              {asleep ? 'Wake & watch' : 'Watch'}
            </button>
            <div>{asleep ? 'The engine is asleep; waking it takes about 40 seconds.' : 'Shows the live browser, and lets you drive it.'}</div>
          </div>
        )}
      </div>

      {/* Status line */}
      {watching && tokenMisconfigured && (
        // The /status poll 401s without the engine token, so the fields can
        // never update — say so explicitly instead of leaving them on an
        // eternal "connecting…"/"—" (#80).
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-amber-400/90">
          Status, Page, Tab, Brain and Stream are unavailable — engine token not configured.
        </div>
      )}
      {watching && !tokenMisconfigured && (!status || (status.pageState && status.pageState !== 'complete') || brainReady === false || (status.lastFrameAgeMs ?? 0) > 5000 || status.journey) && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400 sm:grid-cols-4">
          {!status && <Field label="Engine" value="connecting…" />}
          {status?.pageState && status.pageState !== 'complete' && <Field label="Page" value={status.pageState === 'interactive' ? 'loading' : status.pageState} tone={status.pageState === 'unresponsive' ? 'warn' : undefined} />}
          {brainReady === false && <Field label="Agent clicks" value="unavailable (brain down)" tone="warn" />}
          {(status?.lastFrameAgeMs ?? 0) > 5000 && <Field label="Last frame" value={`${Math.round(status!.lastFrameAgeMs! / 1000)}s ago`} tone="warn" />}
          {status?.journey && <div className="col-span-2 sm:col-span-4"><span className="text-neutral-500">Journey </span><span className="text-neutral-300">{typeof status.journey === 'string' ? status.journey : status.journey?.name || status.journey?.goal || '—'}</span></div>}
        </div>
      )}

      {/* Mic input + action feedback */}
      {watching && (heard || busy || note || !blank) && <div className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900 p-3">
        {!blank && !micOpen && (
          <button onClick={() => setMicOpen(true)} className="self-start text-xs text-neutral-400 hover:text-neutral-200">Mic input: play speech into this page’s microphone (for voice apps) ▸</button>
        )}
        {!blank && micOpen && <div className="flex flex-wrap items-center gap-2">
          <input
            title="Synthesized speech played into the page's microphone, for testing voice apps. It does not steer the agent."
            value={sayText}
            onChange={(e) => setSayText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') say() }}
            placeholder="What to say into the page’s microphone…"
            className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500"
          />
          <button onClick={say} disabled={!!busy} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-50">Speak</button>
        </div>}
        {heard && <p className="rounded bg-neutral-950 px-3 py-1.5 text-xs text-neutral-300"><span className="text-neutral-500">heard: </span>{heard}</p>}
        {busy && <p className="text-xs text-amber-400">{busy}…</p>}
        {note && <p className="text-xs text-neutral-400">{note}</p>}
      </div>}

      {/* Per-run links */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
        <h3 className="mb-2 text-sm font-medium text-neutral-200">This run’s tasks</h3>
        {tasks.length === 0 ? (
          <p className="text-xs text-neutral-500">Nothing recorded yet. Each action an agent takes shows up here with its clip and screenshot.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {tasks.map((t, i) => {
              const n = taskN(t, i)
              return (
                <li key={i} className="flex flex-wrap items-center gap-2 border-b border-neutral-800/60 py-1 text-xs last:border-0">
                  <span className="font-mono text-neutral-500">#{n}</span>
                  <span className="flex-1 truncate text-neutral-300">{t.title || t.name || t.goal || t.journey || 'task'}</span>
                  <a className="text-amber-400 hover:underline" href={api('clip', `?n=${n}`)} target="_blank" rel="noreferrer">clip</a>
                  <a className="text-amber-400 hover:underline" href={api('clip', `?n=${n}&audio=1`)} target="_blank" rel="noreferrer">+audio</a>
                  <a className="text-amber-400 hover:underline" href={api('artifact', `?n=${n}`)} target="_blank" rel="noreferrer">shot</a>
                </li>
              )
            })}
          </ul>
        )}
        <div className="mt-2 flex gap-3 text-xs">
          <a className="text-neutral-400 hover:underline" href={api('logs')} target="_blank" rel="noreferrer">console + network logs</a>
          {tasks.length > 0 && <a className="text-neutral-400 hover:underline" href={api('audio')} target="_blank" rel="noreferrer">run audio</a>}
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="truncate">
      <span className="text-neutral-500">{label} </span>
      <span className={tone === 'warn' ? 'text-amber-400' : 'text-neutral-300'}>{value}</span>
    </div>
  )
}

function StateBadge({ engine, watching, status, tokenMisconfigured, agentUnreachable }: { engine: EngineState | null; watching: boolean; status: Status | null; tokenMisconfigured?: boolean; agentUnreachable?: string | null }) {
  let label = 'unknown'
  let cls = 'bg-neutral-700 text-neutral-200'
  // A live /status response is direct proof the engine is up, even when the
  // no-wake Fly read couldn't tell us awake/asleep (wrong app name / token
  // scope) — so a healthy engine reads green, not unreadable (#115).
  const up = engine?.state === 'started' || (watching && !!status)
  // Agent-unreachable wins while watching: the engine is up (we have status) but
  // the chat agent it should join isn't answering (#81).
  if (watching && agentUnreachable) {
    label = 'agent unreachable'; cls = 'bg-amber-600/80 text-black'
  } else if (watching && tokenMisconfigured) {
    // Without the engine token the status poll 401s, so `status` never arrives —
    // don't sit on a misleading "connecting", whatever the Fly state says (#80).
    label = 'no token'; cls = 'bg-amber-600/80 text-black'
  } else if (up) {
    label = watching ? (status ? 'live' : 'connecting') : 'awake'; cls = 'bg-emerald-600/80 text-white'
  } else if (engine && engine.state) {
    // State is readable but not 'started' → the machine is asleep/stopping.
    label = 'asleep'; cls = 'bg-neutral-700 text-neutral-300'
  } else if (engine && engine.unreachable) {
    // Our own proxy can also fail to answer; either way it is a read failure (#81/#115).
    label = 'state unreadable'; cls = 'bg-amber-600/80 text-black'
  } else if (engine && !engine.configured) {
    label = 'state n/a'; cls = 'bg-neutral-700 text-neutral-400'
  } else if (!engine) {
    // Still probing on first paint — honest "unknown" until the first result.
    label = 'unknown'; cls = 'bg-neutral-700 text-neutral-200'
  }
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{label}</span>
}
