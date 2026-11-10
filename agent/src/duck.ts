// Native barge-in duck: lowers the agent's outgoing TTS volume while the user
// talks over it. @livekit/agents has no volume API on AudioOutput, so we wrap
// captureFrame on the outermost session.output.audio and scale Int16 samples.
// Frames already queued in the rtc AudioSource (~200ms) play at the old gain.

// Gain while ducked: 0.35 = 35% of original volume (65% quieter).
export const DUCK_LEVEL = 0.35

/** Returns a NEW array with gain ramped linearly from `from` to `to`. Identity (same ref) at 1→1. */
export function applyGain(src: Int16Array, from: number, to: number): Int16Array {
  if (from === 1 && to === 1) return src
  const n = src.length
  const dst = new Int16Array(n)
  const step = n > 1 ? (to - from) / (n - 1) : 0
  for (let i = 0; i < n; i++) {
    const g = n > 1 ? from + step * i : to
    let v = Math.round(src[i] * g)
    if (v > 32767) v = 32767
    else if (v < -32768) v = -32768
    dst[i] = v
  }
  return dst
}

export interface DuckController {
  setDuck(target: number, reason?: string): void
  readonly target: number
}

export function installDuck(session: any): DuckController | null {
  const out = session?.output?.audio
  if (!out) return null
  if (out.__duck) return out.__duck as DuckController

  const st = { gain: 1, target: 1 }
  const orig = out.captureFrame.bind(out)

  out.captureFrame = (frame: any) => {
    if (st.gain === 1 && st.target === 1) return orig(frame)
    let next: any
    try {
      const dst = applyGain(frame.data, st.gain, st.target)
      next = new (frame.constructor as any)(dst, frame.sampleRate, frame.channels, frame.samplesPerChannel, frame.userdata)
      st.gain = st.target
    } catch {
      return orig(frame)
    }
    return orig(next)
  }

  const ctrl: DuckController = {
    setDuck(target: number, reason?: string) {
      if (target === st.target) return
      st.target = target
      console.log(`🦆 [duck] → ${target}${reason ? ` (${reason})` : ''}`)
    },
    get target() { return st.target },
  }
  out.__duck = ctrl
  console.log(`🦆 [duck] installed on ${out.constructor?.name}`)
  return ctrl
}
