import type { Page } from '@playwright/test'
import { execSync } from 'child_process'
import { readFileSync, rmSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Reactive mic — the upgrade from "one pre-recorded WAV at mic-open" to a
 * real back-and-forth conversation.
 *
 * installReactiveMic() runs BEFORE any page script and patches
 * navigator.mediaDevices.getUserMedia: audio requests get a MediaStream from
 * a WebAudio MediaStreamDestination that the TEST controls. The app can't
 * tell the difference — it sees a live mic track (silence until we speak).
 *
 * speakText() synthesizes an utterance on the fly (macOS `say`), decodes it
 * in-page, and plays it into that destination — mid-session, on demand,
 * reacting to whatever the agent just said. No launch flags involved, so
 * this works on any site and composes with the tab-capture "ears".
 */

export async function installReactiveMic(page: Page) {
  // OSBORN_TEST_MONITOR=1 → tester utterances also play on the real speakers
  // (headed runs only; lets a human hear both sides of the conversation).
  if (process.env.OSBORN_TEST_MONITOR === '1') {
    await page.addInitScript(() => { (window as any).__micMonitor = true })
  }
  await page.addInitScript(() => {
    const w = window as any
    w.__mic = { ready: false }
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      if (!constraints?.audio) return real(constraints)
      if (!w.__mic.ready) {
        const ctx = new AudioContext({ sampleRate: 48000 })
        const dest = ctx.createMediaStreamDestination()
        // Perpetual comfort noise at ~-68dBFS. A digitally-silent track trips
        // LiveKit's LocalAudioSilenceDetected → it MUTES the mic right after
        // publish, and everything we speak later plays into a muted track
        // (observed live 2026-07-27: TrackMuted 150ms post-publish, agent
        // heard nothing). Inaudible dither defeats the zero-detector without
        // triggering VAD/STT.
        const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
        const nd = noise.getChannelData(0)
        for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.0004
        const noiseSrc = ctx.createBufferSource()
        noiseSrc.buffer = noise
        noiseSrc.loop = true
        noiseSrc.connect(dest)
        noiseSrc.start()
        w.__mic.ctx = ctx
        w.__mic.dest = dest
        w.__mic.ready = true
      }
      const out = new MediaStream()
      for (const t of w.__mic.dest.stream.getAudioTracks()) out.addTrack(t)
      if (constraints.video) {
        try {
          const v = await real({ video: constraints.video })
          for (const t of v.getVideoTracks()) out.addTrack(t)
        } catch {
          // No real camera (headless, no fake-device flags) — synthesize one.
          // We avoid --use-fake-device-for-media-stream entirely because its
          // file-playback hijacks getDisplayMedia audio too, poisoning the
          // tab-capture "ears" with the fixture instead of real page output.
          const canvas = document.createElement('canvas')
          canvas.width = 640
          canvas.height = 480
          const c2d = canvas.getContext('2d')!
          setInterval(() => {
            c2d.fillStyle = '#1a2233'
            c2d.fillRect(0, 0, 640, 480)
            c2d.fillStyle = '#8af'
            c2d.font = '20px monospace'
            c2d.fillText('osborn e2e synthetic camera', 140, 240)
          }, 200)
          const cs = canvas.captureStream(5)
          for (const t of cs.getVideoTracks()) out.addTrack(t)
        }
      }
      return out
    }
  })
}

/** Resolves once the app has actually opened the mic (getUserMedia called). */
export async function waitForMicOpen(page: Page, timeoutMs = 60_000) {
  await page.waitForFunction(() => (window as any).__mic?.ready === true, undefined, { timeout: timeoutMs })
}

/** Play a WAV file into the fake mic. Resolves when the utterance finishes. */
export async function speakWav(page: Page, wavPath: string) {
  const b64 = readFileSync(wavPath).toString('base64')
  await page.evaluate(async (b64) => {
    const w = window as any
    if (!w.__mic?.ready) throw new Error('app has not opened the mic yet — call waitForMicOpen first')
    const ctx = w.__mic.ctx as AudioContext
    await ctx.resume()
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const buf = await ctx.decodeAudioData(bytes.buffer)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(w.__mic.dest)
    // Monitor mode: also play the utterance through the real speakers so a
    // human watching a headed run can hear the tester's side. The mic feed
    // itself never touches the speakers (like a real mic).
    if ((window as any).__micMonitor) src.connect(ctx.destination)
    await new Promise<void>((res) => {
      src.onended = () => res()
      src.start()
    })
  }, b64)
}

/**
 * Fully dynamic speech: synthesize `text` RIGHT NOW and speak it into the
 * session. This is what makes the conversation reactive — the next utterance
 * can be composed from the agent's previous reply.
 *
 * Synthesis chain (portable → local):
 *  1. OpenAI TTS API (natural voice, works anywhere incl. containers)
 *  2. macOS `say`
 *  3. espeak-ng (Linux)
 */
export async function speakText(page: Page, text: string, opts?: { keepWav?: string; onPlayStart?: () => void }): Promise<{ provider: string; synthMs: number; playMs: number }> {
  const base = join(tmpdir(), `osborn-utt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  const wav = `${base}.wav`
  try {
    const t = Date.now()
    const provider = await synthesize(text, base)
    const synthMs = Date.now() - t
    // keepWav: a copy of exactly what was spoken, so proof clips can carry the
    // tester's side of the conversation (the mic feed never reaches speakers).
    if (opts?.keepWav) { try { copyFileSync(wav, opts.keepWav) } catch { /* proof is best-effort */ } }
    opts?.onPlayStart?.()
    const p = Date.now()
    await speakWav(page, wav)
    return { provider, synthMs, playMs: Date.now() - p }
  } finally {
    rmSync(`${base}.aiff`, { force: true })
    rmSync(wav, { force: true })
  }
}

/** Synthesizes `text` to `${base}.wav`; returns which provider spoke. */
async function synthesize(text: string, base: string): Promise<string> {
  const { optionalEnvKey } = await import('./env')
  const { writeFileSync } = await import('fs')
  // Soniox TTS (tts-rt-v1) — preferred mouth: real-time WebSocket that streams
  // base64 pcm_s16le @ 24kHz, which we concatenate and wrap in a WAV header.
  // The SONIOX_API_KEY is already on the engine; no OpenAI/Deepgram needed.
  const soniox = optionalEnvKey('SONIOX_API_KEY')
  if (soniox) {
    try {
      writeFileSync(`${base}.wav`, await sonioxTTS(text, soniox))
      return 'soniox'
    } catch (e) {
      console.warn('[reactive-mic] Soniox TTS error — falling back:', e)
    }
  }
  // Deepgram Aura TTS — fallback mouth. The engine already carries
  // DEEPGRAM_API_KEY (same key the "ears" use), so a single REST call returns a
  // ready-to-play WAV with no OpenAI dependency. ~100ms TTFB, natural voice.
  // Decoded in-page by an AudioContext that resamples 24k → 48k automatically.
  // Falls through to OpenAI/local synth on any error.
  const deepgram = optionalEnvKey('DEEPGRAM_API_KEY')
  if (deepgram) {
    try {
      const res = await fetch('https://api.deepgram.com/v1/speak?model=aura-2-asteria-en&encoding=linear16&sample_rate=24000&container=wav', {
        method: 'POST',
        headers: { Authorization: `Token ${deepgram}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        writeFileSync(`${base}.wav`, Buffer.from(await res.arrayBuffer()))
        return 'deepgram'
      }
      console.warn(`[reactive-mic] Deepgram Aura TTS ${res.status} — falling back`)
    } catch (e) {
      console.warn(`[reactive-mic] Deepgram Aura TTS error — falling back:`, e)
    }
  }
  const openai = optionalEnvKey('OPENAI_API_KEY')
  if (openai) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openai}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: 'onyx', input: text, response_format: 'wav' }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null)
    if (res?.ok) {
      writeFileSync(`${base}.wav`, Buffer.from(await res.arrayBuffer()))
      return 'openai'
    }
    console.warn(`[reactive-mic] OpenAI TTS ${res?.status ?? 'error'} — falling back to local synth`)
  }
  try {
    execSync(
      `say -o "${base}.aiff" ${JSON.stringify(text)} && afconvert -f WAVE -d LEI16@44100 -c 1 "${base}.aiff" "${base}.wav"`,
      { stdio: 'pipe' },
    )
    return 'say'
  } catch { /* not macOS */ }
  execSync(`espeak-ng -w "${base}.wav" ${JSON.stringify(text)}`, { stdio: 'pipe' })
  return 'espeak'
}

/** Synthesize `text` via Soniox real-time TTS → a complete WAV Buffer (24kHz mono PCM16). */
async function sonioxTTS(text: string, apiKey: string): Promise<Buffer> {
  const { WebSocket } = await import('ws')
  return await new Promise<Buffer>((resolve, reject) => {
    const ws = new WebSocket('wss://tts-rt.soniox.com/tts-websocket')
    const chunks: Buffer[] = []
    const streamId = `e2e-${Date.now()}`
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* ignore */ }
      if (err) reject(err)
      else resolve(pcmToWav(Buffer.concat(chunks), 24000))
    }
    const timer = setTimeout(() => finish(new Error('Soniox TTS timeout')), 10000)  // then fall back
    ws.on('open', () => {
      ws.send(JSON.stringify({
        api_key: apiKey, model: 'tts-rt-v1-preview', language: 'en', voice: 'Maya',
        audio_format: 'pcm_s16le', sample_rate: 24000, speed: 1, stream_id: streamId,
      }))
      ws.send(JSON.stringify({ stream_id: streamId, text }))
      ws.send(JSON.stringify({ stream_id: streamId, text_end: true }))
    })
    ws.on('message', (raw: Buffer) => {
      let m: any
      try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.error_code !== undefined) return finish(new Error(`Soniox TTS ${m.error_code}: ${m.error_message}`))
      if (typeof m.audio === 'string' && m.audio) chunks.push(Buffer.from(m.audio, 'base64'))
      if (m.audio_end === true || m.terminated === true) finish(chunks.length ? undefined : new Error('Soniox TTS produced no audio'))
    })
    ws.on('error', (e: Error) => finish(e instanceof Error ? e : new Error(String(e))))
    ws.on('close', () => finish(chunks.length ? undefined : new Error('Soniox TTS closed with no audio')))
  })
}

/** Wrap raw little-endian 16-bit mono PCM in a minimal WAV container. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1, bitsPerSample = 16
  const blockAlign = (numChannels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Synthesizes one short phrase and throws it away, so the first real turn
 *  doesn't pay for a cold speech connection. Returns the provider and time. */
export async function warmUpSpeech(): Promise<{ provider: string; ms: number }> {
  const base = join(tmpdir(), `osborn-warm-${Date.now()}`)
  const t = Date.now()
  try { return { provider: await synthesize('Ready.', base), ms: Date.now() - t } }
  finally { rmSync(`${base}.aiff`, { force: true }); rmSync(`${base}.wav`, { force: true }) }
}
