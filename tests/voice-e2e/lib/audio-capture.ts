import type { BrowserContext, Page } from '@playwright/test'

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
 * WebAudio tap, installed BEFORE page scripts: whatever a page plays straight
 * through an AudioContext (no <audio>/<video> element — tone generators,
 * games, voice SDKs that render through WebAudio) is mirrored into a
 * per-context MediaStream listed on window.__osbornWebAudio, which the ears
 * below record alongside the elements. Contexts flagged __osbornNoTap (the
 * synthetic mic, the ears' own) are skipped.
 */
export async function installPageAudioTap(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    const w = window as any
    // Top frame only: the ears run in the top frame and read its list.
    if (w.__osbornWebAudio || typeof AudioNode === 'undefined' || window !== window.top) return
    const streams: MediaStream[] = []
    w.__osbornWebAudio = streams
    const taps = new WeakMap<BaseAudioContext, MediaStreamAudioDestinationNode>()
    const tapFor = (ctx: any): MediaStreamAudioDestinationNode | null => {
      if (ctx.__osbornNoTap || typeof ctx.createMediaStreamDestination !== 'function') return null
      let t = taps.get(ctx)
      if (!t) {
        const made: MediaStreamAudioDestinationNode = ctx.createMediaStreamDestination()
        t = made; taps.set(ctx, made); streams.push(made.stream)
        // A closed context plays nothing again: drop its stream so pages that
        // make a context per sound do not grow the list forever.
        ctx.addEventListener?.('statechange', () => { if (ctx.state === 'closed') { const i = streams.indexOf(made.stream); if (i >= 0) streams.splice(i, 1) } })
      }
      return t!
    }
    // An element routed into WebAudio is heard through the tap above; the
    // element ears skip it so it is not recorded twice.
    const fromElement = (BaseAudioContext.prototype as any).createMediaElementSource
    if (fromElement) (BaseAudioContext.prototype as any).createMediaElementSource = function (this: BaseAudioContext, el: any) {
      const r = fromElement.call(this, el)
      try { if (!(this as any).__osbornNoTap) el.__osbornViaWebAudio = true } catch { /* never break the page */ }
      return r
    }
    const connect = AudioNode.prototype.connect as any
    const disconnect = AudioNode.prototype.disconnect as any
    AudioNode.prototype.connect = function (this: AudioNode, dest: any, ...rest: any[]) {
      const r = connect.call(this, dest, ...rest)
      if (dest instanceof AudioDestinationNode) { try { const t = tapFor(this.context); if (t) connect.call(this, t) } catch { /* never break the page */ } }
      return r
    } as any
    AudioNode.prototype.disconnect = function (this: AudioNode, ...args: any[]) {
      const r = disconnect.apply(this, args)
      if (args[0] instanceof AudioDestinationNode) { try { const t = taps.get(this.context); if (t) disconnect.call(this, t) } catch { /* not connected */ } }
      return r
    } as any
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
    ;(ctx as any).__osbornNoTap = true  // its speaker passthrough is not new page audio
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
    // Tapped per audio TRACK, so a page that re-wraps the same live track in a
    // new MediaStream is not recorded (and played through) twice, while a call
    // that ends and restarts (new tracks) is tapped again. Regular src elements
    // are captured once (captureStream follows the element).
    // AUDIO CLOCK — the recording runs on this context's clock, which is not the
    // wall clock: on a CPU-throttled machine it ran at 0.37x (measured on the Fly
    // engine, 2026-11-16), so a wall-clock window lands in the wrong part of the
    // file. Each sample maps a wall-clock instant to a recording position.
    const clock: Array<[number, number]> = []
    let anchorCtxMs: number | null = null
    const sampleClock = () => { if (anchorCtxMs != null) clock.push([Date.now(), ctx.currentTime * 1000 - anchorCtxMs]) }
    // rate(): how fast this tab's audio ran over the last 30s (1 = real time).
    // Sampled from arming, not from the first tapped source: a page that never
    // plays audio (only the synthetic mic) still shows how fast its audio ran,
    // which is what slows the tester's own speech when the CPU is starved.
    const pace: Array<[number, number]> = []
    const samplePace = () => {
      // A suspended context is not a slow one: drop the samples so no interval spans the pause.
      if (ctx.state !== 'running') { pace.length = 0; return }
      pace.push([Date.now(), ctx.currentTime * 1000])
      if (pace.length > 120) pace.splice(0, pace.length - 120)
    }
    const rate = () => {
      if (pace.length < 2) return null
      const e = pace[pace.length - 1], b = pace.find((x) => x[0] >= e[0] - 30000) ?? pace[0]
      return e[0] > b[0] ? Math.round(((e[1] - b[1]) / (e[0] - b[0])) * 100) / 100 : null
    }
    ;(window as any).__osbornClock = { clock, sample: sampleClock, rate }
    const tappedTracks = new WeakSet<MediaStreamTrack>()
    const byEl = new WeakMap<HTMLMediaElement, { nodes: AudioNode[]; tracks: MediaStreamTrack[]; captured?: boolean }>()
    const fresh = (ms: MediaStream) => ms.getAudioTracks().filter((t) => t.readyState === 'live' && !tappedTracks.has(t))
    // TIMELINE ANCHOR — the recording's audio timeline effectively starts
    // when the FIRST source connects (verified 2026-07-31: words landed
    // 38.3s "early" in the file vs wall clock, exactly the login→room-join
    // gap before any <audio> existed). The clock samples below start here.
    const tapStream = (ms: MediaStream): MediaStreamAudioSourceNode => {
      const src = ctx.createMediaStreamSource(ms)
      src.connect(dest)
      src.connect(analyser)
      if (!(window as any).__osbornAudioAnchor) { (window as any).__osbornAudioAnchor = Date.now(); anchorCtxMs = ctx.currentTime * 1000; sampleClock() }
      return src
    }
    const untap = (el: HTMLMediaElement) => {
      const e = byEl.get(el)
      if (!e) return
      for (const n of e.nodes) try { n.disconnect() } catch { /* already gone */ }
      for (const t of e.tracks) tappedTracks.delete(t)
      byEl.delete(el)
    }
    const tap = (el: HTMLMediaElement) => {
      // A muted element plays nothing (e.g. a page's own mic/camera preview, a
      // muted participant): recording it would put sound in the file the page
      // never played. Checked on every scan, so muting later stops the tap.
      if (el.muted || (el as any).__osbornViaWebAudio) return untap(el)
      try {
        const obj = el.srcObject instanceof MediaStream ? el.srcObject : null
        if (!obj) {
          if (byEl.get(el)?.captured) return
          const ms: MediaStream | null = (el as any).captureStream?.() ?? null
          if (!ms || ms.getAudioTracks().length === 0) return
          byEl.set(el, { nodes: [tapStream(ms)], tracks: [], captured: true })
          return
        }
        const tracks = fresh(obj)
        if (!tracks.length) return
        const src = tapStream(new MediaStream(tracks))
        // SPEAKER PASSTHROUGH (fix 2026-08-07): pulling a remote WebRTC track
        // (LiveKit srcObject — the agent's TTS) into WebAudio via
        // createMediaStreamSource STARVES the <audio> element's own output —
        // Chrome routes the track exclusively into the graph, so the agent goes
        // SILENT on the speakers even though el.muted=false/volume=1. Reconnect
        // to the speakers so headed/local runs stay audible (no-op on headless
        // cloud — no output device). Only srcObject taps: captureStream taps
        // still drive the element, so routing them here would double the audio.
        src.connect(ctx.destination)
        for (const t of tracks) tappedTracks.add(t)
        const e = byEl.get(el) ?? { nodes: [], tracks: [] }
        e.nodes.push(src); e.tracks.push(...tracks); byEl.set(el, e)
      } catch {
        /* element not ready yet — rescan will retry */
      }
    }
    const scan = () => {
      document.querySelectorAll('audio, video').forEach((el) => tap(el as HTMLMediaElement))
      // WebAudio output mirrored by installPageAudioTap.
      for (const ms of ((window as any).__osbornWebAudio ?? []) as MediaStream[]) {
        const tracks = fresh(ms)
        if (!tracks.length) continue
        try { tapStream(new MediaStream(tracks)); for (const t of tracks) tappedTracks.add(t) } catch { /* retried on the next scan */ }
      }
    }
    scan()
    let ticks = 0
    const interval = setInterval(() => { scan(); if (++ticks % 2 === 0) { sampleClock(); samplePace() } }, 500) // late srcObject + clock
    const observer = new MutationObserver(scan)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    rec.start(250)
    void ctx.resume().then(samplePace)
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
/** [wall-clock ms, recording ms] samples: where the recording was at each instant. */
export type AudioClock = Array<[number, number]>

/** Recording position (ms) at a wall-clock instant, interpolated between clock samples.
 *  Past the last sample it keeps the last rate; before the first one, the gap is wall time
 *  (nothing was recording yet). */
export function recordingMsAt(clock: AudioClock, wallMs: number): number {
  if (!clock.length) return 0
  if (wallMs <= clock[0][0]) return clock[0][1] - (clock[0][0] - wallMs)
  let i = clock.findIndex(([w]) => w >= wallMs)
  if (i === -1) i = clock.length - 1
  const [w1, f1] = clock[Math.max(0, i)]
  const [w0, f0] = clock[Math.max(0, i - 1)]
  const rate = w1 > w0 ? (f1 - f0) / (w1 - w0) : 1
  return f1 + (wallMs - w1) * rate
}

/** Longest page-audio recording the engine decodes for a turn; past it the clip goes without page audio. */
export const AUDIO_DECODE_CAP_MS = 30 * 60 * 1000

/**
 * How long a /say turn may spend copying and decoding the page's recording,
 * given the ms left before the turn deadline. null: too little left to decode
 * at all. Hearing always keeps 10s after the decode (#199).
 */
export function decodeBudgetMs(leftMs: number): number | null {
  if (leftMs < 15000) return null
  return Math.min(35000, leftMs - 10000)
}

/** The recording's age in whole minutes, and whether it is past the decode cap (#185). */
export function recordingAge(startedAt: number | null | undefined, now: number): { minutes: number; overCap: boolean } | null {
  if (!startedAt) return null
  const ms = Math.max(0, now - startedAt)
  return { minutes: Math.floor(ms / 60000), overCap: ms > AUDIO_DECODE_CAP_MS }
}

/** What Node already holds of one tab's recording: its first `chunks` chunks, concatenated. */
export type PeekCache = { startedAt: number; chunks: number; bytes: Buffer }

/**
 * Adds the chunks a peek copied (from chunk `from` on) to what was held. A
 * different recording (re-armed ears, reloaded page) or a gap starts over;
 * null means the peek must be repeated from chunk 0.
 */
export function mergePeek(held: PeekCache | undefined, got: { startedAt: number; from: number; total: number; bytes: Buffer }): PeekCache | null {
  if (got.from === 0) return { startedAt: got.startedAt, chunks: got.total, bytes: got.bytes }
  if (!held || held.startedAt !== got.startedAt || held.chunks !== got.from) return null
  return { startedAt: got.startedAt, chunks: got.total, bytes: Buffer.concat([held.bytes, got.bytes]) }
}

// The recording only grows, so each peek copies just the chunks added since the
// last one out of the page (#165): copying the whole recording on every turn
// grew with the capture's age.
const peekHeld = new WeakMap<Page, PeekCache>()

/** What to keep after a peek: past the decode cap nothing is held, and every peek copies it all again. */
export function heldAfterPeek(merged: PeekCache, sinceStartMs: number): PeekCache | undefined {
  return sinceStartMs > AUDIO_DECODE_CAP_MS ? undefined : merged
}

export async function peekCapture(page: Page): Promise<{ bytes: Buffer; sinceStartMs: number; captureStartedAt: number; clock: AudioClock }> {
  const copy = (held: PeekCache | undefined) => page.evaluate(async ({ from, startedAt }) => {
    const cap = (window as any).__osbornCapture
    if (!cap) throw new Error('startCapture was never called')
    cap.rec.requestData?.() // flush the in-flight chunk
    await new Promise((r) => setTimeout(r, 120))
    const clk = (window as any).__osbornClock
    clk?.sample()
    // Another recording than the one Node holds: copy it all.
    const start = cap.startedAt === startedAt && from <= cap.chunks.length ? from : 0
    const total = cap.chunks.length
    const blob = new Blob(cap.chunks.slice(start, total), { type: 'audio/webm' })
    const buf = await blob.arrayBuffer()
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    // fileZeroAt: wall-clock time of the recording's zero (the first tapped source),
    // the clock's only sample when nothing has been tapped yet.
    const anchor = (window as any).__osbornAudioAnchor ?? cap.startedAt
    const fileZeroAt = Math.max(anchor, cap.startedAt)
    return { base64: btoa(bin), from: start, total, sinceStartMs: Date.now() - cap.startedAt, captureStartedAt: cap.startedAt,
      clock: (clk?.clock?.length ? clk.clock : [[fileZeroAt, 0]]) as Array<[number, number]> }
  }, { from: held?.chunks ?? 0, startedAt: held?.startedAt ?? 0 })
  let got = await copy(peekHeld.get(page))
  let merged = mergePeek(peekHeld.get(page), { startedAt: got.captureStartedAt, from: got.from, total: got.total, bytes: Buffer.from(got.base64, 'base64') })
  if (!merged) {  // two peeks raced on one tab: copy it all
    got = await copy(undefined)
    merged = mergePeek(undefined, { startedAt: got.captureStartedAt, from: 0, total: got.total, bytes: Buffer.from(got.base64, 'base64') })!
  }
  const keep = heldAfterPeek(merged, got.sinceStartMs)
  if (keep) peekHeld.set(page, keep); else peekHeld.delete(page)
  return { bytes: merged.bytes, sinceStartMs: got.sinceStartMs, captureStartedAt: got.captureStartedAt, clock: got.clock }
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
