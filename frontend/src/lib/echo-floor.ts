// The barge-in duck's echo floor (VoiceRoom): the leftover echo of the agent's voice in your mic.
// Invariant: the floor stays within (0, ONSET_MAX / 3], so the onset (floor * 3, clamped to
// [ONSET_MIN, ONSET_MAX]) keeps its meaning however long a sound sits just under the onset.
export const ONSET_MIN = 0.012, ONSET_MAX = 0.04
export const FLOOR_MAX = ONSET_MAX / 3
const FLOOR_DOWN_MS = 300, FLOOR_UP_MS = 4000 // quick to fall, slow to rise

export const duckOnset = (floor: number) => Math.min(ONSET_MAX, Math.max(ONSET_MIN, floor * 3))

/** One frame of learning from a mic level heard below the onset, dt ms after the last frame. */
export const learnEchoFloor = (floor: number, vol: number, dt: number) => {
  const tau = vol < floor ? FLOOR_DOWN_MS : FLOOR_UP_MS
  return Math.min(FLOOR_MAX, floor + (vol - floor) * (1 - Math.exp(-dt / tau)))
}

/** After a duck nobody kept talking through: lift the onset toward the level that tripped it. */
export const liftEchoFloor = (floor: number, tripped: number) => Math.min(FLOOR_MAX, Math.max(floor, (tripped * 1.2) / 3))

/** The barge-in timing line, or null unless a duck actually engaged (no timing for a natural stop).
 * The agent "stopped" at its last audible frame only if that came after the duck's onset. */
export const bargeInTiming = (duckedAt: number, duckOnsetAt: number, agentHeardAt: number): string | null => {
  if (!duckedAt) return null
  const stop = agentHeardAt >= duckOnsetAt ? `agent stopped ${Math.round(agentHeardAt - duckOnsetAt)}ms after your voice` : 'agent was already quiet'
  return `barge-in timing: duck ${Math.round(duckedAt - duckOnsetAt)}ms, ${stop}`
}

export const ANALYSER_RETRY_MS = 1000
/** A new agent track starts at full volume: the current duck level must be re-applied to it. */
export const trackSwapped = (track: unknown, seen: unknown) => track !== seen
/** Build (or retry building) the agent analyser: for a track not yet analysed, at most once per ANALYSER_RETRY_MS. */
export const shouldBuildAnalyser = (track: unknown, analysed: unknown, now: number, triedAt: number) =>
  track !== analysed && now - triedAt > ANALYSER_RETRY_MS

export type AgentTrackState = { seen: unknown; analysed: unknown; failedFor: unknown; triedAt: number }
/** One frame of agent-track handling: re-apply the duck volume on a swap, (re)build the analyser, log a failure once per track. */
export const planAgentTrack = (track: unknown, st: AgentTrackState, now: number) => ({
  reapplyVolume: trackSwapped(track, st.seen) && !!track,
  build: shouldBuildAnalyser(track, st.analysed, now, st.triedAt),
})
/** After a build attempt: mark the track analysed only on success; on failure report whether to log (once per track). */
export const afterAnalyserBuild = (st: AgentTrackState, track: unknown, ok: boolean, now: number) => {
  const logFailure = !ok && st.failedFor !== track
  return { next: { ...st, triedAt: now, analysed: ok ? track : null, failedFor: logFailure ? track : st.failedFor }, logFailure }
}
