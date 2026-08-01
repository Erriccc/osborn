import type { Page, CDPSession } from '@playwright/test'
import { createServer, type Server } from 'http'
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
  // Epoch ms of the most recent screencast frame (null before the first one).
  // A growing age means the page has stopped painting — ground truth for /status.
  lastFrameAt: () => number | null
  // How many clients are watching /stream right now (idle-stop holds off
  // while someone is watching).
  viewerCount: () => number
  // Latest frame as base64 jpeg — inline keyframes in act/say responses so
  // the director can review-and-relay without downloading the clip first.
  latestFrame: () => string | null
  // Re-bind the screencast to a different tab (the engine's active page).
  retarget: (page: Page) => Promise<void>
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
  const attach = async (p: Page): Promise<CDPSession> => {
    const s = await p.context().newCDPSession(p)
    s.on('Page.screencastFrame', async (f: any) => {
      try { await s.send('Page.screencastFrameAck', { sessionId: f.sessionId }) } catch { /* page gone */ }
      pushFrame(Buffer.from(f.data, 'base64'))
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
    cdp = await attach(page)
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
    if (STREAM_TOKEN && pathName !== '/ready' && reqUrl.searchParams.get('key') !== STREAM_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('stream locked — append ?key=<OSBORN_STREAM_TOKEN>')
      return
    }
    if (req.url === '/ready') {
      // Wake-up poll for the viewer page: are frames flowing yet?
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ streaming: !!lastFrameTime, lastFrameAgeMs: lastFrameTime ? Date.now() - lastFrameTime : null }))
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
      @keyframes spin{to{transform:rotate(360deg)}}</style></head>
      <body><img src="/stream${STREAM_TOKEN ? `?key=${encodeURIComponent(reqUrl.searchParams.get('key') || '')}` : ''}" alt="live">
      <div id="wake"><div class="brand">BROWSER&nbsp;SCREEN&nbsp;RECORDER</div><div class="dot"></div><div id="msg">engine waking up…</div>
      <div class="sub">the full browser will appear here as it boots (~40s)</div></div>
      <script>
        const t0 = Date.now()
        const poll = setInterval(async () => {
          try {
            const r = await fetch('/ready', { cache: 'no-store' }).then(r => r.json())
            if (r.streaming) { document.getElementById('wake').classList.add('gone'); clearInterval(poll); return }
          } catch {}
          document.getElementById('msg').textContent = 'engine waking up… ' + Math.round((Date.now() - t0) / 1000) + 's'
        }, 2000)
      </script></body></html>`)
  })
  await new Promise<void>((r) => server.listen(port, host, r))
  const publicUrl = process.env.FLY_APP_NAME
    ? `https://${process.env.FLY_APP_NAME}.fly.dev/`
    : `http://${host}:${port}/`
  console.log(`[live-stream] watch live at ${publicUrl}`)

  const clip = async (outPath: string, seconds = 20): Promise<string | null> => {
    const since = Date.now() - seconds * 1000
    const frames = ring.filter((f) => f.t >= since)
    if (frames.length < 2) { console.log(`[live-stream] clip skipped — ${frames.length} frame(s)`); return null }
    const dir = mkdtempSync(join(tmpdir(), 'osbclip-'))
    try {
      frames.forEach((f, i) => writeFileSync(join(dir, `f${String(i).padStart(5, '0')}.jpg`), f.buf))
      const ok = await new Promise<boolean>((resolve) => {
        // Encode at the capture rate → display-mode clips play in REAL TIME.
        const ff = spawn('ffmpeg', ['-y', '-framerate', String(CAPTURE_FPS), '-pattern_type', 'glob', '-i', join(dir, 'f*.jpg'),
          '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath], { stdio: 'ignore' })
        ff.on('error', () => resolve(false)); ff.on('close', (c) => resolve(c === 0))
      })
      if (!ok) { console.log('[live-stream] clip failed — ffmpeg unavailable'); return null }
      console.log(`[live-stream] clip saved: ${outPath} (${frames.length} frames)`)
      return outPath
    } finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
  }

  return {
    url: publicUrl,
    clip,
    lastFrameAt: () => lastFrameTime,
    viewerCount: () => clients.size,
    latestFrame: () => (latest ? latest.toString('base64') : null),
    retarget: async (p: Page) => {
      // Display mode captures the whole window — tab focus IS the retarget.
      if (DISPLAY) return
      try { await cdp?.send('Page.stopScreencast') } catch { /* already gone */ }
      try { await cdp?.detach() } catch { /* already gone */ }
      cdp = await attach(p)
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
