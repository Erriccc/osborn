/** Fast-brain model fallback: pure decisions, no I/O. A hosted model that has been retired answers 404 on every call. */
export interface FastBrainCandidate { url: string; key: string; model: string; name: string }

/** A retired or unknown model: HTTP 404, or the provider saying the model does not exist. */
export function isModelNotFound(status: number, body: string): boolean {
  if (status === 404) return true
  return (status === 400 || status === 403) && /model[_ ]not[_ ]found|model .{0,80}(does not exist|not found)|unknown model/i.test(body)
}

/** The first candidate whose model has not been seen dead; undefined when every one has. */
export function pickCandidate(candidates: FastBrainCandidate[], dead: ReadonlySet<string>): FastBrainCandidate | undefined {
  return candidates.find((c) => !dead.has(`${c.url}|${c.model}`))
}

export const candidateId = (c: FastBrainCandidate): string => `${c.url}|${c.model}`
