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
