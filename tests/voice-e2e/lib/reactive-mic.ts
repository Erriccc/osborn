import type { Page } from '@playwright/test'
import { execSync } from 'child_process'
import { readFileSync, rmSync } from 'fs'
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
export async function speakText(page: Page, text: string) {
  const base = join(tmpdir(), `osborn-utt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  const wav = `${base}.wav`
  try {
    await synthesize(text, base)
    await speakWav(page, wav)
  } finally {
    rmSync(`${base}.aiff`, { force: true })
    rmSync(wav, { force: true })
  }
}

async function synthesize(text: string, base: string): Promise<void> {
  const { optionalEnvKey } = await import('./env')
  const { writeFileSync } = await import('fs')
  const openai = optionalEnvKey('OPENAI_API_KEY')
  if (openai) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openai}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: 'onyx', input: text, response_format: 'wav' }),
    })
    if (res.ok) {
      writeFileSync(`${base}.wav`, Buffer.from(await res.arrayBuffer()))
      return
    }
    console.warn(`[reactive-mic] OpenAI TTS ${res.status} — falling back to local synth`)
  }
  try {
    execSync(
      `say -o "${base}.aiff" ${JSON.stringify(text)} && afconvert -f WAVE -d LEI16@44100 -c 1 "${base}.aiff" "${base}.wav"`,
      { stdio: 'pipe' },
    )
    return
  } catch { /* not macOS */ }
  execSync(`espeak-ng -w "${base}.wav" ${JSON.stringify(text)}`, { stdio: 'pipe' })
}
