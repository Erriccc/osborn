import type { Page, CDPSession } from '@playwright/test'
import { createServer, request as httpRequest, type Server } from 'http'
import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Live browser stream — watch the test happen in real time from any browser.
 *
 * Uses Chrome DevTools Protocol Page.startScreencast to pull JPEG frames from
 * the running (headless) browser and serves them as MJPEG
 * (multipart/x-mixed-replace) over a tiny HTTP server. On the Fly tester
 * machine, expose the port (fly.toml) and open
 *   https://<machine>.fly.dev/           → the viewer page (auto-refreshing img)
 * to watch clicks, navigation, and the action-visualizer ripples live.
 *
 * Vendor-free: the Fly machine is already in the cloud and provides the URL.
 * No Browserbase/Browserless needed. Locally it binds 127.0.0.1 for a preview.
 *
 * It also keeps a rolling buffer of recent frames so `clip()` can dump a short
 * per-task mp4 on demand — every /act and /say gets its own reviewable video,
 * NOT just a screenshot, so we can confirm the engine actually did the work.
 *
 * MULTI-TAB: the screencast is a per-page CDP session, so it does NOT follow
 * tab focus by itself. `retarget(page)` re-binds the screencast to a new tab —
 * the engine calls it on every /tab open|switch|close so the stream (and the
 * per-task clips cut from it) always show the ACTIVE tab. Without this, clips
 * of actions on tab 2 would show frozen frames of tab 0 — lying proof.
 */

export type LiveStream = {
  url: string
  stop: () => Promise<void>
  // Dump the last ~N seconds of screencast frames to an mp4 clip. Returns the
  // path, or null if too few frames / ffmpeg unavailable.
  clip: (outPath: string, seconds?: number) => Promise<string | null>
  // Cut the frames captured between two wall-clock instants. The clip plays in
  // REAL TIME (each frame is held for as long as it was actually on screen),
  // and the returned startMs/endMs are the wall-clock span it covers — what an
  // audio track must be aligned against.
  clipRange: (outPath: string, fromMs: number, toMs?: number, page?: Page) => Promise<{ path: string; startMs: number; endMs: number } | null>
  // Record a tab on its own; clipRange(..., page) cuts from that recording.
  trackPage: (page: Page) => void
  // Epoch ms of the most recent screencast frame (null before the first one).
  // A growing age means the page has stopped painting — ground truth for /status.
  lastFrameAt: () => number | null
  // How many clients are watching /stream right now (idle-stop holds off
  // while someone is watching).
  viewerCount: () => number
  // Latest frame as base64 jpeg — inline keyframes in act/say responses so
  // the director can review-and-relay without downloading the clip first.
  latestFrame: (page?: Page) => string | null
  // Re-bind the screencast to a different tab (the engine's active page).
  retarget: (page: Page) => Promise<void>
  // A passive-view notice (e.g. "agent unreachable: <host>") shown as a banner
  // over the stream and returned from /ready, so a watcher sees WHY the chat is
  // dead instead of a silent spinner (#49). Pass null to clear it.
  setNotice: (text: string | null) => void
}

// `page` may be null in display mode (x11grab needs no page) — that lets the
// engine start the viewer server BEFORE the browser launches, so a visitor
// who woke a sleeping machine sees a "waking up" page within seconds and then
// watches Chrome itself boot on the virtual display.
export async function startLiveStream(page: Page | null, opts?: { port?: number; host?: string }): Promise<LiveStream> {
  const port = opts?.port ?? Number(process.env.LIVE_STREAM_PORT ?? 8080)
  const host = opts?.host ?? (process.env.OSBORN_TEST_CONTAINER ? '0.0.0.0' : '127.0.0.1')
  const clients = new Set<import('http').ServerResponse>()
  let latest: Buffer | null = null
  let lastFrameTime: number | null = null
  // Passive-view notice (#49): set by the engine when the auto-joined chat
  // can't reach its agent; surfaced via /ready and a banner on the viewer page.
  let notice: string | null = null

  // Rolling frame buffer (last ~120s) for per-task clips.
  const BUFFER_MS = 120_000, MAX_FRAMES = 2400
  const ring: { t: number; buf: Buffer }[] = []

  // DISPLAY MODE (full-window capture): when OSBORN_DISPLAY is set (container
  // running Xvfb + headful Chrome), capture the WHOLE virtual display via
  // ffmpeg x11grab instead of per-page CDP frames. The stream/clips then show
  // the real browser — actual tab strip, tab switches, URL bar navigation —
  // at a CONSTANT fps, which also makes clips play in true real time (the CDP
  // path is paint-driven: bursts + heartbeat → timelapse/slow-mo artifacts).
  const DISPLAY = process.env.OSBORN_DISPLAY || null
  const CAPTURE_FPS = DISPLAY ? 5 : 12
  const SCREENCAST = { format: 'jpeg' as const, quality: 55, everyNthFrame: 1, maxWidth: 1280, maxHeight: 720 }
  let cdp: CDPSession | null = null
  let target: Page | null = null  // the tab the screencast is attached to
  const pushFrame = (buf: Buffer) => {
    latest = buf
    const now = Date.now()
    lastFrameTime = now
    ring.push({ t: now, buf })
    const cutoff = now - BUFFER_MS
    while (ring.length && (ring[0].t < cutoff || ring.length > MAX_FRAMES)) ring.shift()
    for (const res of clients) {
      try {
        res.write(`--osbframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`)
        res.write(buf); res.write('\r\n')
      } catch { clients.delete(res) }
    }
  }
  const attach = async (p: Page, push: (b: Buffer) => void = pushFrame): Promise<CDPSession> => {
    const s = await p.context().newCDPSession(p)
    s.on('Page.screencastFrame', async (f: any) => {
      try { await s.send('Page.screencastFrameAck', { sessionId: f.sessionId }) } catch { /* page gone */ }
      push(Buffer.from(f.data, 'base64'))
    })
    await s.send('Page.startScreencast', SCREENCAST)
    return s
  }

  // x11grab source: constant-rate MJPEG of the whole display from ffmpeg's
  // stdout, split on JPEG SOI/EOI markers and pushed into the same ring.
  let grabber: import('child_process').ChildProcess | null = null
  const startDisplayGrab = () => {
    grabber = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-framerate', String(CAPTURE_FPS),
      '-video_size', process.env.OSBORN_DISPLAY_SIZE || '1280x800', '-i', DISPLAY!,
      '-f', 'mjpeg', '-q:v', '6', 'pipe:1'])
    let acc: Buffer = Buffer.alloc(0)
    grabber.stdout!.on('data', (d: Buffer) => {
      acc = Buffer.concat([acc, d])
      for (;;) {
        const soi = acc.indexOf('\xff\xd8', 0, 'binary')
        if (soi < 0) { acc = Buffer.alloc(0); break }
        const eoi = acc.indexOf('\xff\xd9', soi + 2, 'binary')
        if (eoi < 0) { acc = acc.subarray(soi); break }
        pushFrame(Buffer.from(acc.subarray(soi, eoi + 2)))
        acc = acc.subarray(eoi + 2)
      }
    })
    grabber.on('exit', (c) => console.log(`[live-stream] x11grab exited (${c})`))
    console.log(`[live-stream] display capture: x11grab ${DISPLAY} @ ${CAPTURE_FPS}fps (full browser window)`)
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null
  if (DISPLAY) {
    startDisplayGrab()
  } else {
    if (!page) throw new Error('CDP capture mode requires a page (display mode does not)')
    cdp = await attach(page); target = page
    // HEARTBEAT — CDP screencast only emits on PAINT, so a static page starves
    // the ring (observed: a 1.25s "clip" for a whole multi-tab choreography).
    // When no frame has arrived for HEARTBEAT_MS, capture a screenshot and push
    // it as a synthetic frame, so clips are continuous wall-clock records.
    const HEARTBEAT_MS = 500
    let beating = false
    heartbeat = setInterval(async () => {
      if (!cdp || beating) return
      if (lastFrameTime && Date.now() - lastFrameTime < HEARTBEAT_MS) return
      beating = true
      try {
        const r: any = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })
        pushFrame(Buffer.from(r.data, 'base64'))
      } catch { /* page mid-navigation or session detached */ }
      beating = false
    }, HEARTBEAT_MS)
  }

  // STREAM TOKEN — when OSBORN_STREAM_TOKEN is set, the viewer + stream
  // require ?key=<token>. Default open (solo use); SET IT when self-hosting:
  // a public stream URL both shows your browser AND wakes the machine (cost).
  const STREAM_TOKEN = process.env.OSBORN_STREAM_TOKEN || null
  const server: Server = createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://x')
    const pathName = reqUrl.pathname
    // CONTROL API ON THE STREAM PORT — /control/<action> forwards to the
    // engine's control server (default :8781). Many agent sandboxes and
    // corporate proxies only allow outbound 443, so a control API that lives
    // solely on :8781 is unreachable for exactly the browser agents this tool
    // is for. Same auth as the direct port (x-engine-token, checked by the
    // engine); refused outright when no engine token is configured so an open
    // control API is never published on the public stream port. Responses are
    // piped, so SSE (/control/events) and media (/control/clip) work as-is.
    if (pathName === '/control' || pathName.startsWith('/control/')) {
      const sendJson = (code: number, body: Record<string, unknown>) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (!process.env.OSBORN_ENGINE_TOKEN) return sendJson(403, { error: 'control API over the stream port is disabled — set OSBORN_ENGINE_TOKEN on the engine to enable it' })
      const fwdHeaders: Record<string, string> = {}
      for (const h of ['x-engine-token', 'x-driver-id', 'content-type', 'content-length', 'accept']) {
        const v = req.headers[h]; if (typeof v === 'string') fwdHeaders[h] = v
      }
      const pubHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      if (pubHost) fwdHeaders['x-control-base'] = `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${pubHost}/control`
      const upstream = httpRequest({
        host: '127.0.0.1', port: Number(process.env.SESSION_ENGINE_PORT ?? 8781),
        method: req.method, path: (pathName.slice('/control'.length) || '/') + reqUrl.search, headers: fwdHeaders,
      }, (up) => {
        // Hop-by-hop headers describe the upstream connection, not this one.
        const h = { ...up.headers }; for (const k of ['connection', 'keep-alive', 'transfer-encoding']) delete h[k]
        res.writeHead(up.statusCode || 502, h); up.pipe(res)
      })
      upstream.on('error', () => { if (!res.headersSent) sendJson(503, { error: 'engine control API is not up yet — the engine is still booting; retry in a few seconds', code: 'engine_booting' }); else res.end() })
      res.on('close', () => upstream.destroy())
      req.pipe(upstream)
      return
    }
    if (STREAM_TOKEN && pathName !== '/ready' && reqUrl.searchParams.get('key') !== STREAM_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('stream locked — append ?key=<OSBORN_STREAM_TOKEN>')
      return
    }
    if (req.url === '/ready') {
      // Wake-up poll for the viewer page: are frames flowing yet?
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ streaming: !!lastFrameTime, lastFrameAgeMs: lastFrameTime ? Date.now() - lastFrameTime : null, notice }))
      return
    }
    if (pathName === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=osbframe',
        'Cache-Control': 'no-store', Connection: 'close',
      })
      clients.add(res)
      if (latest) { res.write(`--osbframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${latest.length}\r\n\r\n`); res.write(latest); res.write('\r\n') }
      req.on('close', () => clients.delete(res))
      return
    }
    // Viewer page — shows a "waking up" banner until frames flow (a visitor
    // whose request auto-started a sleeping machine sees progress, not a hang).
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!doctype html><html><head><title>Browser Screen Recorder — live</title>
      <style>body{margin:0;background:#0b0b0b;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace}
      img{max-width:100vw;max-height:100vh;box-shadow:0 0 40px #000}
      #wake{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 40%, #17130a, #0b0b0b);color:#ffd479;gap:22px;transition:opacity .6s}
      #wake.gone{opacity:0;pointer-events:none}
      .brand{font-size:15px;letter-spacing:4px;color:#8a7b55}
      .dot{width:44px;height:44px;border-radius:50%;border:5px solid #ffb300;border-top-color:transparent;animation:spin 1s linear infinite;box-shadow:0 0 30px rgba(255,179,0,.35)}
      #msg{font-size:26px;font-weight:700;text-shadow:0 0 20px rgba(255,179,0,.4)}
      .sub{color:#8a7b55;font-size:14px}
      #notice{position:fixed;top:0;left:0;right:0;z-index:10;display:none;background:#3a1414;color:#ffb4b4;font:600 13px monospace;padding:10px 16px;text-align:center;border-bottom:1px solid #a33;box-shadow:0 2px 16px rgba(0,0,0,.5)}
      @keyframes spin{to{transform:rotate(360deg)}}</style></head>
      <body><img src="/stream${STREAM_TOKEN ? `?key=${encodeURIComponent(reqUrl.searchParams.get('key') || '')}` : ''}" alt="live">
      <div id="notice"></div>
      <div id="wake"><div class="brand">BROWSER&nbsp;SCREEN&nbsp;RECORDER</div><div class="dot"></div><div id="msg">engine waking up…</div>
      <div class="sub">the full browser will appear here as it boots (~40s)</div></div>
      <script>
        const t0 = Date.now()
        const wake = document.getElementById('wake'), noticeEl = document.getElementById('notice'), msgEl = document.getElementById('msg')
        // Poll forever (cheap, and /ready does NOT keep the machine awake): hide
        // the wake overlay once frames flow, and show/update the agent-unreachable
        // banner (#49) whenever the engine sets it — it can arrive after streaming.
        setInterval(async () => {
          try {
            const r = await fetch('/ready', { cache: 'no-store' }).then(r => r.json())
            if (r.streaming) wake.classList.add('gone')
            if (r.notice) { noticeEl.textContent = r.notice; noticeEl.style.display = 'block' }
            else noticeEl.style.display = 'none'
          } catch {}
          if (!wake.classList.contains('gone')) msgEl.textContent = 'engine waking up… ' + Math.round((Date.now() - t0) / 1000) + 's'
        }, 2000)
      </script></body></html>`)
  })
  await new Promise<void>((r) => server.listen(port, host, r))
  const publicUrl = process.env.FLY_APP_NAME
    ? `https://${process.env.FLY_APP_NAME}.fly.dev/`
    : `http://${host}:${port}/`
  console.log(`[live-stream] watch live at ${publicUrl}`)

  // TRUE-TIME CLIPS. Frames used to be encoded at a fixed rate, so any dropped
  // or late frame shortened the clip: a 30s window came out as 23s and nothing
  // in it lined up with the clock (or with an audio track). Each frame now
  // carries its real on-screen duration, taken from its capture timestamp, and
  // the encoder resamples to a constant rate — 1s of clip is 1s of wall clock.
  // Per-tab recordings, started on a tab's first action (background tabs keep
  // rendering), so a clip shows only the acting tab and the engine can
  // release its lock early. 60s each, shared heartbeat guard.
  const TAB_MS = 60_000, TAB_FRAMES = 600
  const tabRecs = new Map<Page, { ring: Array<{ t: number; buf: Buffer }>; last: number }>()
  const trackPage = (p: Page) => {
    if (tabRecs.has(p) || p.isClosed()) return
    const rec = { ring: [] as Array<{ t: number; buf: Buffer }>, last: 0 }
    tabRecs.set(p, rec)
    const push = (buf: Buffer) => {
      rec.last = Date.now(); rec.ring.push({ t: rec.last, buf })
      while (rec.ring.length && (rec.ring[0].t < rec.last - TAB_MS || rec.ring.length > TAB_FRAMES)) rec.ring.shift()
    }
    attach(p, push).then((s) => {
      let beating = false
      const hb = setInterval(async () => {
        if (beating || Date.now() - rec.last < 500) return
        beating = true
        try { push(Buffer.from((await s.send('Page.captureScreenshot', { format: 'jpeg', quality: 50 }) as any).data, 'base64')) } catch { /* navigating */ }
        beating = false
      }, 500)
      p.once('close', () => { clearInterval(hb); tabRecs.delete(p) })
    }).catch((e) => { tabRecs.delete(p); console.log(`[live-stream] tab recorder failed: ${(e as Error).message.slice(0, 80)}`) })
  }

  const clipRange = async (outPath: string, fromMs: number, toMs = Date.now(), page?: Page): Promise<{ path: string; startMs: number; endMs: number } | null> => {
    const inRange = (r: Array<{ t: number; buf: Buffer }>) => r.filter((f) => f.t >= fromMs && f.t <= toMs)
    const own = page ? inRange(tabRecs.get(page)?.ring ?? []) : []
    // A recorder that only just started has too few frames: use the main ring.
    const frames = own.length >= 2 ? own : inRange(ring)
    if (frames.length < 2) { console.log(`[live-stream] clip skipped — ${frames.length} frame(s)`); return null }
    const dir = mkdtempSync(join(tmpdir(), 'osbclip-'))
    try {
      // Thin bursts instead of padding them: frames closer than one output
      // frame (100ms at 10fps) to the previous kept frame are dropped. A
      // minimum-duration floor here stretched a burst of 2400 frames 5ms apart
      // (12s of wall clock) into a 48s clip.
      const MIN_GAP_MS = 100
      const kept: typeof frames = []
      for (const f of frames) if (!kept.length || f.t - kept[kept.length - 1].t >= MIN_GAP_MS) kept.push(f)
      const lines: string[] = ['ffconcat version 1.0']
      kept.forEach((f, i) => {
        const name = `f${String(i).padStart(5, '0')}.jpg`
        writeFileSync(join(dir, name), f.buf)
        const next = i + 1 < kept.length ? kept[i + 1].t : toMs
        lines.push(`file '${name}'`, `duration ${(Math.max(1, next - f.t) / 1000).toFixed(3)}`)
      })
      // The concat demuxer ignores the last duration unless the file repeats.
      lines.push(`file 'f${String(kept.length - 1).padStart(5, '0')}.jpg'`)
      writeFileSync(join(dir, 'list.txt'), lines.join('\n') + '\n')
      const ok = await new Promise<boolean>((resolve) => {
        const ff = spawn('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
          '-vf', 'fps=10,pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath], { stdio: 'ignore' })
        ff.on('error', () => resolve(false)); ff.on('close', (c) => resolve(c === 0))
      })
      if (!ok) { console.log('[live-stream] clip failed — ffmpeg unavailable'); return null }
      console.log(`[live-stream] clip saved: ${outPath} (${frames.length} frames, ${((toMs - frames[0].t) / 1000).toFixed(1)}s)`)
      return { path: outPath, startMs: frames[0].t, endMs: toMs }
    } finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
  }
  const clip = async (outPath: string, seconds = 20): Promise<string | null> =>
    (await clipRange(outPath, Date.now() - seconds * 1000))?.path ?? null

  return {
    url: publicUrl,
    clip,
    clipRange,
    trackPage,
    lastFrameAt: () => lastFrameTime,
    viewerCount: () => clients.size,
    latestFrame: (p?: Page) => { const r = p ? tabRecs.get(p)?.ring : undefined; const b = r?.length ? r[r.length - 1].buf : latest; return b ? b.toString('base64') : null },
    setNotice: (text: string | null) => { notice = text },
    retarget: async (p: Page) => {
      // Display mode captures the whole window — tab focus IS the retarget.
      if (DISPLAY || p === target) return  // already on that tab: re-attaching would flicker it
      try { await cdp?.send('Page.stopScreencast') } catch { /* already gone */ }
      try { await cdp?.detach() } catch { /* already gone */ }
      cdp = await attach(p); target = p
      console.log('[live-stream] retargeted screencast to active tab')
    },
    stop: async () => {
      if (heartbeat) clearInterval(heartbeat)
      try { grabber?.kill('SIGKILL') } catch { /* ignore */ }
      try { await cdp?.send('Page.stopScreencast') } catch { /* ignore */ }
      for (const res of clients) { try { res.end() } catch { /* ignore */ } }
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}
