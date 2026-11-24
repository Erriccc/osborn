// Per-turn timing marks, logged as one `[turn-timing] {json}` line (ms deltas, no text).
export const REPLAY_NEAR_MS = 2000

export type TurnMarks = {
  speechAt?: number // last user_input_transcribed (interim or final)
  finalAt?: number // last final transcript
  chatAt?: number // chat() entry
  pushAt?: number // handed to the model (after any deferred wait)
  deferredMs?: number // wait for an in-flight interrupt before the push
  hookMs?: number // UserPromptSubmit hook duration (recall + nudge)
  replayAt?: number // last REPLAY start
}

const d = (a?: number, b?: number): number | null => (a == null || b == null ? null : Math.max(0, b - a))

export function formatTurnTiming(m: TurnMarks, turn: number): string {
  const replayNear = m.replayAt != null && m.chatAt != null && m.chatAt - m.replayAt >= 0 && m.chatAt - m.replayAt <= REPLAY_NEAR_MS
  return `[turn-timing] ${JSON.stringify({
    turn,
    speechToFinal: d(m.speechAt, m.finalAt),
    finalToChat: d(m.finalAt, m.chatAt),
    speechToChat: d(m.speechAt, m.chatAt),
    chatToPush: d(m.chatAt, m.pushAt),
    deferredWait: m.deferredMs ?? 0,
    hook: m.hookMs ?? null,
    speechToPush: d(m.speechAt, m.pushAt),
    replayBeforeChat: replayNear,
  })}`
}

let marks: TurnMarks = {}
let turn = 0
export const markSpeech = (now = Date.now()) => { marks.speechAt = now }
export const markFinal = (now = Date.now()) => { marks.finalAt = now }
export const markReplay = (now = Date.now()) => { marks.replayAt = now }
export const markChat = (now = Date.now()) => { marks.chatAt = now; marks.pushAt = undefined; marks.deferredMs = undefined; marks.hookMs = undefined }
export const markPush = (deferredMs = 0, now = Date.now()) => { marks.pushAt = now; marks.deferredMs = deferredMs }
/** Hook is the last stage: log the line and start the next turn's marks (speech/replay carry over only if newer than the chat). */
export function markHookDone(ms: number): void {
  if (marks.chatAt == null) return
  marks.hookMs = ms
  console.log(formatTurnTiming(marks, ++turn))
  marks = { speechAt: marks.speechAt && marks.speechAt > marks.chatAt ? marks.speechAt : undefined, replayAt: marks.replayAt && marks.replayAt > marks.chatAt ? marks.replayAt : undefined }
}
