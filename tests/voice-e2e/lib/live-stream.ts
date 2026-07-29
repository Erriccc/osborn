import type { Page } from '@playwright/test'
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
 */

export type LiveStream = {
  url: string
  stop: () => Promise<void>
  // Dump the last ~N seconds of screencast frames to an mp4 clip. Returns the
  // path, or null if too few frames / ffmpeg unavailable.
  clip: (outPath: string, seconds?: number) => Promise<string | null>
}

export async function startLiveStream(page: Page, opts?: { port?: number; host?: string }): Promise<LiveStream> {
  const port = opts?.port ?? Number(process.env.LIVE_STREAM_PORT ?? 8080)
  const host = opts?.host ?? (process.env.OSBORN_TEST_CONTAINER ? '0.0.0.0' : '127.0.0.1')
  const clients = new Set<import('http').ServerResponse>()
  let latest: Buffer | null = null

  // Rolling frame buffer (last ~120s) for per-task clips.
  const BUFFER_MS = 120_000, MAX_FRAMES = 2400
  const ring: { t: number; buf: Buffer }[] = []

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, everyNthFrame: 1, maxWidth: 1280, maxHeight: 720 })
  cdp.on('Page.screencastFrame', async (f: any) => {
    latest = Buffer.from(f.data, 'base64')
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }) } catch { /* page gone */ }
    const now = Date.now()
    ring.push({ t: now, buf: latest })
    const cutoff = now - BUFFER_MS
    while (ring.length && (ring[0].t < cutoff || ring.length > MAX_FRAMES)) ring.shift()
    for (const res of clients) {
      try {
        res.write(`--osbframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${latest.length}\r\n\r\n`)
        res.write(latest); res.write('\r\n')
      } catch { clients.delete(res) }
    }
  })

  const server: Server = createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=osbframe',
        'Cache-Control': 'no-store', Connection: 'close',
      })
      clients.add(res)
      if (latest) { res.write(`--osbframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${latest.length}\r\n\r\n`); res.write(latest); res.write('\r\n') }
      req.on('close', () => clients.delete(res))
      return
    }
    // Viewer page.
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!doctype html><html><head><title>Voice-E2E live</title>
      <style>body{margin:0;background:#0b0b0b;display:flex;align-items:center;justify-content:center;height:100vh}
      img{max-width:100vw;max-height:100vh;box-shadow:0 0 40px #000}</style></head>
      <body><img src="/stream" alt="live"></body></html>`)
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
        const ff = spawn('ffmpeg', ['-y', '-framerate', '12', '-pattern_type', 'glob', '-i', join(dir, 'f*.jpg'),
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
    stop: async () => {
      try { await cdp.send('Page.stopScreencast') } catch { /* ignore */ }
      for (const res of clients) { try { res.end() } catch { /* ignore */ } }
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}
