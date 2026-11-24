// Tiny pub/sub for the local mic level and the "got it" tick, so the status strip updates
// without re-rendering VoiceRoom. The level comes from the analyser the barge-in duck already runs.
type Fn = (v: number) => void
const levelSubs = new Set<Fn>()
const gotItSubs = new Set<() => void>()
export const MIC_LEVEL_INTERVAL_MS = 66 // ~15 Hz
export const publishMicLevel = (v: number) => levelSubs.forEach((f) => f(v))
export const pulseGotIt = () => gotItSubs.forEach((f) => f())
export const onMicLevel = (f: Fn) => { levelSubs.add(f); return () => { levelSubs.delete(f) } }
export const onGotIt = (f: () => void) => { gotItSubs.add(f); return () => { gotItSubs.delete(f) } }
/** RMS 0..1 -> 0..1 bar height; speech sits around 0.02-0.3, so a sqrt curve keeps quiet talk visible. */
export const levelToHeight = (v: number): number => Math.min(1, Math.max(0, Math.sqrt(Math.max(0, v)) * 1.6))
