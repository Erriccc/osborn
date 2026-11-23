/**
 * Screenshot-based retry for an /act the DOM brain could not match (#478).
 * Pure decisions only; the engine owns the Stagehand call, the lock and the fence.
 */

/** Env kill switch: set to 1 and no /act makes a vision attempt. */
export const VISION_KILL_ENV = 'OSBORN_NO_VISION_RETRY'

export type VisionGate = { enabled: boolean; why?: 'env' | 'request' }

/** Default ON. Off for the whole engine by the env var, or for one call by `vision:false` in the body. */
export function visionGate(body: { vision?: unknown } | null | undefined, env: Record<string, string | undefined> = process.env): VisionGate {
  if (env[VISION_KILL_ENV] === '1') return { enabled: false, why: 'env' }
  if (body?.vision === false) return { enabled: false, why: 'request' }
  return { enabled: true }
}

/** One attempt, only when the brain found nothing to match: never after an engine action or an error. */
export function shouldRetryWithVision(r: { noop?: boolean; engine?: boolean } | null | undefined, gate: VisionGate): boolean {
  return gate.enabled && !!r?.noop && !r.engine
}

/** Two steps: look (screenshot), then one interaction. One step is one model call, so a single step would act blind. */
export const VISION_MAX_STEPS = 2

export function visionInstruction(instruction: string): string {
  return `First take a screenshot, then from what you see make a single interaction (a click, a typed value or a key press) to do this: ${instruction}\n`
    + 'Stop after that one interaction. If the target is not visible on screen, do nothing.'
}

/** Agent tools that look or wait but change nothing. */
const PASSIVE = new Set(['done', 'think', 'screenshot', 'wait', 'ariaTree', 'extract', 'close'])

type VisionAction = { type?: string; reasoning?: string; description?: string; describe?: string; success?: boolean; error?: unknown }
type AgentLike = { message?: string; actions?: VisionAction[] }

/**
 * Whether the agent changed anything, and a short account of it. An interaction that failed does not count,
 * and neither does one made before the first screenshot (it acted without looking).
 */
export function summarizeVision(res: AgentLike | null | undefined): { acted: boolean; did: string; blind?: boolean } {
  const actions = res?.actions ?? []
  const first = actions.findIndex((a) => a?.type && !PASSIVE.has(a.type) && a.success !== false && !a.error)
  if (first < 0) return { acted: false, did: '' }
  if (!actions.slice(0, first).some((a) => a?.type === 'screenshot')) return { acted: false, did: '', blind: true }
  const a = actions[first]
  return { acted: true, did: `vision (${a.type}): ${String(a.describe ?? a.description ?? a.reasoning ?? res?.message ?? '').slice(0, 120)}`.trim() }
}
