/**
 * Screenshot-based retry for an /act the DOM brain could not match (#478).
 * Pure decisions only; the engine owns the Stagehand call, the lock and the fence.
 */

/** Env kill switch: set to 1/true/on/yes and no /act makes a vision attempt. */
export const VISION_KILL_ENV = 'OSBORN_NO_VISION_RETRY'

const TRUTHY = /^(1|true|on|yes)$/i

export type VisionGate = { enabled: boolean; why?: 'env' | 'request' }

/** Default ON. Off for the whole engine by the env var, or for one call by `vision:false` in the body. */
export function visionGate(body: { vision?: unknown } | null | undefined, env: Record<string, string | undefined> = process.env): VisionGate {
  if (TRUTHY.test((env[VISION_KILL_ENV] ?? '').trim())) return { enabled: false, why: 'env' }
  if (body?.vision === false) return { enabled: false, why: 'request' }
  return { enabled: true }
}

/** One attempt, only when the brain found nothing to match: never after an engine action, a stub or an error. */
export function shouldRetryWithVision(r: { noop?: boolean; engine?: boolean } | null | undefined, gate: VisionGate, brainStub = false): boolean {
  return gate.enabled && !brainStub && !!r?.noop && !r.engine
}

export function visionInstruction(instruction: string): string {
  return `Do exactly this one step, using what you see on the screenshot: ${instruction}\n`
    + 'Make a single interaction (a click, a typed value or a key press) and stop. If the target is not visible on screen, do nothing.'
}

/** Agent tools that look or wait but change nothing. */
const PASSIVE = new Set(['done', 'think', 'screenshot', 'wait', 'ariaTree', 'extract', 'close'])

type AgentLike = { success?: boolean; message?: string; actions?: Array<{ type?: string; reasoning?: string; description?: string }> }

/** Whether the agent changed anything, and a short account of it. */
export function summarizeVision(res: AgentLike | null | undefined): { acted: boolean; did: string } {
  const acting = (res?.actions ?? []).filter((a) => a?.type && !PASSIVE.has(a.type))
  if (!acting.length) return { acted: false, did: '' }
  const a = acting[0]
  return { acted: true, did: `vision (${a.type}): ${String(a.description ?? a.reasoning ?? res?.message ?? '').slice(0, 120)}`.trim() }
}
