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
export function recordingAge(startedAt: number | null | undefined, now: number, capMs = AUDIO_DECODE_CAP_MS): { minutes: number; overCap: boolean } | null {
  if (!startedAt) return null
  const ms = Math.max(0, now - startedAt)
  return { minutes: Math.floor(ms / 60000), overCap: ms > capMs }
}
