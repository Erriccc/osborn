import type { Page } from '@playwright/test'

/**
 * The "ears": capture the tab's own audio output from inside the page.
 *
 * Mechanism (verified in research, Playwright issue #4870 workaround):
 *  - getDisplayMedia({ preferCurrentTab, audio }) captures THIS tab incl. audio
 *  - Chromium flag --auto-accept-this-tab-capture suppresses the picker prompt
 *    (add it in playwright.config launchOptions alongside the fake-mic flags)
 *  - MediaRecorder encodes to WebM/Opus in memory; we hand back base64
 *
 * Why not Playwright's recordVideo: it is video-only — audio was closed
 * WontFix by the Playwright maintainers in 2022. This is the sanctioned
 * escape hatch, and it needs no vendor, no extension, no virtual devices.
 *
 * Analysis of the captured audio (silence gaps, cutoff detection, transcribe
 * via Deepgram) happens in Node after saveCapture().
 */

export async function startCapture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // @ts-expect-error — Chromium-only hints, fine under our launch flags
      preferCurrentTab: true,
      video: true, // required by the API; we discard the track after start
      audio: { suppressLocalAudioPlayback: false },
    })
    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) throw new Error('no audio track in tab capture — check --auto-accept-this-tab-capture flag and that the page is audible')
    const audioOnly = new MediaStream(audioTracks)
    const rec = new MediaRecorder(audioOnly, { mimeType: 'audio/webm;codecs=opus' })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    rec.start(250)
    // stash on window for stopCapture
    ;(window as any).__osbornCapture = { rec, chunks, stream, startedAt: Date.now() }
  })
}

/**
 * Element-tap ears: record everything <audio>/<video> elements play, by
 * routing their streams into a WebAudio destination + MediaRecorder.
 *
 * Why this instead of getDisplayMedia: tab capture's audio is hijacked by
 * --use-fake-device-for-media-stream (with OR without a file — verified
 * 2026-07-27: capture contained the fixture, then silence), and without fake
 * devices macOS demands Screen-Recording permission. Tapping the elements
 * needs no flags, no permissions, works headless, and captures exactly what
 * the app plays (LiveKit renders remote TTS into <audio> els via
 * RoomAudioRenderer). Generic: srcObject MediaStreams (WebRTC) and regular
 * src URLs (captureStream) both work.
 */
export async function startElementCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ctx = new AudioContext()
    const dest = ctx.createMediaStreamDestination()
    // Speech-event analyser: RMS energy over the same mix feeding the
    // recorder. Emits { type: 'speech-start'|'speech-stop', t } into
    // window.__osbornEars — millisecond-accurate "agent is audibly speaking"
    // signal for barge-in/interruption assertions.
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    const events: Array<{ type: string; t: number }> = []
    ;(window as any).__osbornEars = events
    const buf = new Float32Array(analyser.fftSize)
    let speaking = false
    let lastLoudAt = 0
    setInterval(() => {
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const rms = Math.sqrt(sum / buf.length)
      const now = Date.now()
      if (rms > 0.01) {
        lastLoudAt = now
        if (!speaking) { speaking = true; events.push({ type: 'speech-start', t: now }) }
      } else if (speaking && now - lastLoudAt > 1600) {
        // 1.6s hangover: inter-sentence TTS pauses and thinking-pauses must
        // not read as end-of-turn (900ms made the tester interrupt mid-thought)
        speaking = false
        events.push({ type: 'speech-stop', t: lastLoudAt })
      }
    }, 50)
    const tapped = new WeakSet<HTMLMediaElement>()
    const tap = (el: HTMLMediaElement) => {
      if (tapped.has(el)) return
      try {
        const ms: MediaStream | null =
          el.srcObject instanceof MediaStream
            ? el.srcObject
            : (el as any).captureStream?.() ?? null
        if (!ms || ms.getAudioTracks().length === 0) return
        const src = ctx.createMediaStreamSource(ms)
        src.connect(dest)
        src.connect(analyser)
        tapped.add(el)
      } catch {
        /* element not ready yet — rescan will retry */
      }
    }
    const scan = () => document.querySelectorAll('audio, video').forEach((el) => tap(el as HTMLMediaElement))
    scan()
    const interval = setInterval(scan, 500) // catch late srcObject assignment
    const observer = new MutationObserver(scan)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    rec.start(250)
    void ctx.resume()
    ;(window as any).__osbornCapture = { rec, chunks, startedAt: Date.now(), cleanup: () => { clearInterval(interval); observer.disconnect() } }
  })
}

/**
 * Peek at the recording WITHOUT stopping it — concatenates all chunks so far
 * into a valid WebM (first chunk carries the container header). This is what
 * makes "always listening" possible: transcribe mid-conversation, filter by
 * word timestamps, and comprehension comes from AUDIO — no reliance on the
 * app having a text transcript in its UI.
 */
export async function peekCapture(page: Page): Promise<{ base64: string; sinceStartMs: number }> {
  return await page.evaluate(async () => {
    const cap = (window as any).__osbornCapture
    if (!cap) throw new Error('startCapture was never called')
    cap.rec.requestData?.() // flush the in-flight chunk
    await new Promise((r) => setTimeout(r, 120))
    const blob = new Blob(cap.chunks, { type: 'audio/webm' })
    const buf = await blob.arrayBuffer()
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return { base64: btoa(bin), sinceStartMs: Date.now() - cap.startedAt }
  })
}

export async function stopCapture(page: Page): Promise<{ base64: string; durationMs: number }> {
  return await page.evaluate(async () => {
    const cap = (window as any).__osbornCapture
    if (!cap) throw new Error('startCapture was never called')
    const done = new Promise<void>((res) => { cap.rec.onstop = () => res() })
    cap.rec.stop()
    await done
    cap.cleanup?.()
    cap.stream?.getTracks().forEach((t: MediaStreamTrack) => t.stop())
    const blob = new Blob(cap.chunks, { type: 'audio/webm' })
    const buf = await blob.arrayBuffer()
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return { base64: btoa(bin), durationMs: Date.now() - cap.startedAt }
  })
}

export async function saveCapture(page: Page, outPath: string): Promise<{ path: string; bytes: number; durationMs: number }> {
  const { base64, durationMs } = await stopCapture(page)
  const { writeFileSync } = await import('fs')
  const buf = Buffer.from(base64, 'base64')
  writeFileSync(outPath, buf)
  return { path: outPath, bytes: buf.length, durationMs }
}
