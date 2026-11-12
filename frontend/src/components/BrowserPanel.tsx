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
import { useCallback, useEffect, useRef, useState } from 'react'

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
}
type Status = {
  roomReady?: boolean
  pageUrl?: string
  pageState?: string
  idlePaused?: boolean
  brain?: { ready?: boolean; dead?: boolean } | string
  // The engine reports the active tab as { i, url }; older shapes used a bare
  // number/string. Handle both so the readout never renders "[object Object]".
  activeTab?: number | string | { i?: number; url?: string }
  tabs?: unknown[]
  lastFrameAgeMs?: number
  journey?: { name?: string; goal?: string } | string | null
  // #49/#81: when the auto-joined chat agent can't be reached the engine reports
  // why here (else null). The panel surfaces it instead of spinning on "unknown".
  agentUrl?: string | null
  agentUnreachable?: string | null
}
type Task = { n?: number; index?: number; title?: string; name?: string; goal?: string; journey?: string }

const api = (action: string, qs = '') => `/api/browser/${action}${qs}`

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
  // That is NOT an unreachable engine — say "sign in" and stop polling, instead
  // of a red "engine unreachable" badge and an endless "Waking…" spinner.
  const [signedOut, setSignedOut] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
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
        // engine, so one that idle-stopped mid-watch stayed green "live" (it answers
        // 502 here). A thrown fetch above never reached our proxy — hold last-known.
        setStatus(null)
        if (r.status === 401) {
          const t = await r.text().catch(() => '')
          if (/Not authenticated/.test(t)) { setSignedOut(true); setWatching(false) }
          else setTokenError(true)
        }
        return
      }
      const s = (await r.json().catch(() => null)) as Status | null
      setStatus(s); if (s) setTokenError(false) // an unparseable 200 is not a live engine either
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
    const u = url.trim()
    if (!u) return
    const full = /^https?:\/\//i.test(u) ? u : `https://${u}`
    await post('tab', { op: 'open', url: full, reuse: !newTab }, 'open')
  }
  const say = async () => {
    const text = sayText.trim()
    if (!text) return
    const r = await post('say', { text }, 'say')
    if (r && typeof r.heard === 'string') setHeard(r.heard)
  }
  const stopEngine = async () => {
    if (!confirm('Stop the browser engine? Any in-flight run ends and the machine sleeps.')) return
    await post('end', {}, 'stop')
    setWatching(false)
  }

  const taskN = (t: Task, i: number) => (typeof t.n === 'number' ? t.n : typeof t.index === 'number' ? t.index : i)
  const asleep = engine?.state && engine.state !== 'started'
  // The engine reports activeTab as { i, url } now — render the index, never a
  // stringified object ("Tab [object Object]", #102).
  const activeTabLabel = (() => {
    const a = status?.activeTab
    if (a == null) return '—'
    if (typeof a === 'object') return a.i != null ? String(a.i) : '—'
    return String(a)
  })()
  // #81: the engine tells us when the auto-joined chat agent is unreachable.
  const agentUnreachable = watching ? status?.agentUnreachable ?? null : null
  // The server is missing the engine token if it says so up front, or if a drive
  // action just came back 401. Either way, every control/output action will fail.
  const tokenMisconfigured = engine?.engineTokenConfigured === false || tokenError
  const brainReady = typeof status?.brain === 'object' ? status?.brain?.ready && !status?.brain?.dead : undefined

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
        <a href="/login" className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400">
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
          {!watching ? (
            <button
              onClick={() => { setStreamBroken(false); streamKickRef.current++; setWatching(true) }}
              className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-black hover:bg-amber-400"
            >
              {asleep ? 'Wake & watch' : 'Watch'}
            </button>
          ) : (
            <button
              onClick={() => setWatching(false)}
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
            >
              Stop watching
            </button>
          )}
          <button onClick={copyShare} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800">
            Copy link
          </button>
        </div>
      </div>

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

      {/* Live view */}
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-neutral-800 bg-black">
        {watching ? (
          <>
            {/* key kicks a reload when we retry a broken/waking stream */}
            <img
              key={streamKickRef.current}
              src={api('stream', `?t=${streamKickRef.current}`)}
              alt="Live browser stream"
              className="h-full w-full object-contain"
              onError={() => setStreamBroken(true)}
              onLoad={() => setStreamBroken(false)}
            />
            {streamBroken && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-center text-sm text-neutral-300">
                {/* `unreachable` only means the Fly state couldn't be READ, so it is
                    no reason to blank this out — that left a bare Retry button (#62/#49). */}
                <div>Waking the browser engine… (first pixels take ~40s)</div>
                <button
                  onClick={() => { setStreamBroken(false); streamKickRef.current++; setWatching(false); setTimeout(() => setWatching(true), 50) }}
                  className="rounded-lg border border-neutral-600 px-3 py-1.5 hover:bg-neutral-800"
                >
                  Retry
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-neutral-500">
            {asleep ? 'Engine is asleep. Press “Wake & watch” to boot it and stream the live view (~40s).' : 'Press “Watch” to stream the live browser view here.'}
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
      {watching && !tokenMisconfigured && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400 sm:grid-cols-4">
          <Field label="Page" value={status?.pageState || (status ? '—' : 'connecting…')} />
          <Field label="Tab" value={activeTabLabel} />
          <Field label="Brain" value={brainReady == null ? '—' : brainReady ? 'ready' : 'not ready'} tone={brainReady === false ? 'warn' : undefined} />
          <Field label="Stream" value={status?.lastFrameAgeMs != null ? `${Math.round(status.lastFrameAgeMs / 1000)}s ago` : '—'} tone={(status?.lastFrameAgeMs ?? 0) > 10000 ? 'warn' : undefined} />
          {status?.pageUrl && <div className="col-span-2 truncate sm:col-span-4"><span className="text-neutral-500">URL </span><span className="text-neutral-300">{status.pageUrl}</span></div>}
          {status?.journey && <div className="col-span-2 sm:col-span-4"><span className="text-neutral-500">Journey </span><span className="text-neutral-300">{typeof status.journey === 'string' ? status.journey : status.journey?.name || status.journey?.goal || '—'}</span></div>}
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') openUrl() }}
            placeholder="Open a URL (e.g. example.com)"
            className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500"
          />
          <label className="flex items-center gap-1 text-xs text-neutral-400"><input type="checkbox" checked={newTab} onChange={(e) => setNewTab(e.target.checked)} /> new tab</label>
          <button onClick={openUrl} disabled={!!busy} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-50">Open</button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={sayText}
            onChange={(e) => setSayText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') say() }}
            placeholder="Say into the page mic…"
            className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500"
          />
          <button onClick={say} disabled={!!busy} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-50">Say</button>
          <button onClick={stopEngine} disabled={!!busy} className="rounded-lg border border-red-900/60 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/40 disabled:opacity-50">Stop engine</button>
        </div>
        {heard && <p className="rounded bg-neutral-950 px-3 py-1.5 text-xs text-neutral-300"><span className="text-neutral-500">heard: </span>{heard}</p>}
        {busy && <p className="text-xs text-amber-400">{busy}…</p>}
        {note && <p className="text-xs text-neutral-400">{note}</p>}
      </div>

      {/* Per-run links */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium text-neutral-200">This run’s tasks</h3>
          <button onClick={refreshTasks} className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800">Refresh</button>
        </div>
        {tasks.length === 0 ? (
          <p className="text-xs text-neutral-500">No tasks yet — recorded tasks appear here with clip + log links once a run produces them.</p>
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
          <a className="text-neutral-400 hover:underline" href={api('audio')} target="_blank" rel="noreferrer">run audio</a>
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
  } else if (up) {
    // Without the engine token the status poll 401s, so `status` never
    // arrives — don't sit on a misleading "connecting" (#80).
    if (watching && tokenMisconfigured) { label = 'no token'; cls = 'bg-amber-600/80 text-black' }
    else { label = watching ? (status ? 'live' : 'connecting') : 'awake'; cls = 'bg-emerald-600/80 text-white' }
  } else if (engine && engine.state) {
    // State is readable but not 'started' → the machine is asleep/stopping.
    label = 'asleep'; cls = 'bg-neutral-700 text-neutral-300'
  } else if (engine && engine.unreachable) {
    // We couldn't READ awake/asleep (Fly Machines API / our own proxy) — that says
    // nothing about engine health, so it's an amber "can't tell", not a red
    // engine-is-down claim. Explicit rather than a bare "unknown" (#81/#115).
    label = 'state unreadable'; cls = 'bg-amber-600/80 text-black'
  } else if (engine && !engine.configured) {
    label = 'state n/a'; cls = 'bg-neutral-700 text-neutral-400'
  } else if (!engine) {
    // Still probing on first paint — honest "unknown" until the first result.
    label = 'unknown'; cls = 'bg-neutral-700 text-neutral-200'
  }
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{label}</span>
}
