// Per-turn timing marks, logged as one `[turn-timing] {json}` line (ms deltas, no text).
export const REPLAY_NEAR_MS = 2000

export type TurnMarks = {
  onsetAt?: number // user_state_changed → speaking (agent-side VAD/STT onset; the browser duck fires earlier, see echo-floor.ts)
  stopAt?: number // user_state_changed → listening (the waveform stop the user sees)
  speechAt?: number // last interim transcript (the user was still talking)
  finalAt?: number // last final transcript
  chatAt?: number // chat() entry
  pushAt?: number // handed to the model (after any deferred wait)
  deferredMs?: number // wait for an in-flight interrupt before the push
  hookMs?: number // UserPromptSubmit hook duration (recall + nudge)
  replayAt?: number // last REPLAY start
  recallMs?: number // recall injection part of the hook
  nudgeMs?: number // machine-load nudge part of the hook
  recallTimedOut?: boolean // recall hit the hook's 6000 ms backstop
}

const d = (a?: number, b?: number): number | null => (a == null || b == null ? null : Math.max(0, b - a))

export function formatTurnTiming(m: TurnMarks, turn: number): string {
  const replayNear = m.replayAt != null && m.chatAt != null && m.chatAt - m.replayAt >= 0 && m.chatAt - m.replayAt <= REPLAY_NEAR_MS
  return `[turn-timing] ${JSON.stringify({
    turn,
    ...(m.stopAt != null ? { onsetToStop: d(m.onsetAt, m.stopAt), stopToFinal: d(m.stopAt, m.finalAt), stopToChat: d(m.stopAt, m.chatAt) } : {}),
    speechToFinal: d(m.speechAt, m.finalAt),
    finalToChat: d(m.finalAt, m.chatAt),
    speechToChat: d(m.speechAt, m.chatAt),
    chatToPush: d(m.chatAt, m.pushAt),
    deferredWait: m.deferredMs ?? 0,
    hook: m.hookMs ?? null,
    speechToPush: d(m.speechAt, m.pushAt),
    replayBeforeChat: replayNear,
    ...(m.recallMs != null ? { recall: m.recallMs } : {}),
    ...(m.nudgeMs != null ? { nudge: m.nudgeMs } : {}),
    ...(m.recallTimedOut ? { recallTimedOut: true } : {}),
  })}`
}

let marks: TurnMarks = {}
let turn = 0
/** A final must not move speechAt, or speechToFinal is always 0 and speechToChat equals finalToChat. */
export const markTranscript = (isFinal: boolean, now = Date.now()) => { if (isFinal) marks.finalAt = now; else marks.speechAt = now }
/** The agent's user-state edge: onset is the latest speaking edge after a stop (a flap restarts it), stop the latest listening edge. */
export const markUserState = (speaking: boolean, now = Date.now()) => {
  if (speaking) { if (marks.stopAt != null || marks.onsetAt == null) { marks.onsetAt = now; marks.stopAt = undefined } } else marks.stopAt = now
}
export const markReplay = (now = Date.now()) => { marks.replayAt = now }
export const markChat = (now = Date.now()) => { marks.chatAt = now; marks.pushAt = undefined; marks.deferredMs = undefined; marks.hookMs = undefined }
export const markPush = (deferredMs = 0, now = Date.now()) => { marks.pushAt = now; marks.deferredMs = deferredMs }
/** Hook is the last stage: log the line and start the next turn's marks (speech/replay/onset/stop carry over only if newer than the chat). The optional breakdown is left out of the line when not given. */
export function markHookDone(ms: number, extra?: Pick<TurnMarks, 'recallMs' | 'nudgeMs' | 'recallTimedOut'>): void {
  if (marks.chatAt == null) return
  marks.hookMs = ms
  Object.assign(marks, extra)
  console.log(formatTurnTiming(marks, ++turn))
  out = { turn, stopAt: marks.stopAt, finalAt: marks.finalAt, chatAt: marks.chatAt }
  const later = (t?: number) => (t && t > marks.chatAt ? t : undefined)
  marks = { speechAt: later(marks.speechAt), replayAt: later(marks.replayAt), onsetAt: later(marks.onsetAt), stopAt: later(marks.stopAt) }
}

/** Output hops of the turn just logged: first reply block handed to TTS, then its first audio frame. One line each, once per turn. */
type OutMarks = { turn: number; stopAt?: number; finalAt?: number; chatAt?: number; sayAt?: number }
let out: OutMarks | null = null
export const markSay = (now = Date.now()) => {
  if (!out || out.sayAt != null) return
  out.sayAt = now
  console.log(`[turn-timing-out] ${JSON.stringify({ turn: out.turn, stage: 'say', chatToSay: d(out.chatAt, now), stopToSay: d(out.stopAt, now) })}`)
}
export const markAudio = (now = Date.now()) => {
  if (!out || out.sayAt == null) return
  console.log(`[turn-timing-out] ${JSON.stringify({ turn: out.turn, stage: 'audio', sayToAudio: d(out.sayAt, now), stopToAudio: d(out.stopAt, now), finalToAudio: d(out.finalAt, now) })}`)
  out = null
}
