/**
 * Screenshot-based retry for an /act the DOM brain could not match (#478).
 * Pure decisions only; the engine owns the Stagehand call, the lock and the fence.
 */

/** Env kill switch: set to 1 and no /act makes a vision attempt. */
export const VISION_KILL_ENV = 'OSBORN_NO_VISION_RETRY'

export type VisionGate = { enabled: boolean; why?: 'env' | 'request' | 'instruction' }

/** "If X ... otherwise do nothing" must stay a no-op, and a guess from pixels must not delete, pay or send. */
const CONDITIONAL = /\b(if|otherwise|unless)\b/i
const DESTRUCTIVE = /\b(delete|remove|pay|purchase|buy|send|submit|confirm|sign out|log out)\b/i

/**
 * Default ON. Off for the whole engine by the env var, or for one call by `vision:false` in the body.
 * A conditional or destructive instruction is skipped unless the call sends `vision:true`.
 */
export function visionGate(body: { vision?: unknown; instruction?: unknown } | null | undefined, env: Record<string, string | undefined> = process.env): VisionGate {
  if (env[VISION_KILL_ENV] === '1') return { enabled: false, why: 'env' }
  if (body?.vision === false) return { enabled: false, why: 'request' }
  const ins = typeof body?.instruction === 'string' ? body.instruction : ''
  if (body?.vision !== true && (CONDITIONAL.test(ins) || DESTRUCTIVE.test(ins))) return { enabled: false, why: 'instruction' }
  return { enabled: true }
}

type Size = { width: number; height: number } | null | undefined
/** Stagehand maps the model's 0-1000 coordinates onto its configured viewport, so any other tab size mis-aims clicks. */
export const viewportMatches = (page: Size, brain: Size): boolean => !!page && !!brain && page.width === brain.width && page.height === brain.height

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

/** Agent tools that look, wait or only re-run the DOM path: none of them is a vision interaction. */
// `act` is the DOM tool: it re-runs the DOM act that just failed, and Stagehand drops its success flag.
const PASSIVE = new Set(['act', 'done', 'think', 'screenshot', 'wait', 'ariaTree', 'extract', 'close'])

type VisionAction = { type?: string; reasoning?: string; description?: string; describe?: string; coordinates?: number[]; success?: boolean; error?: unknown }
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
  return { acted: true, did: `vision (${a.type}): ${String(a.describe ?? a.description ?? a.reasoning ?? res?.message ?? '').slice(0, 120)}${a.coordinates ? ` at (${a.coordinates.join(',')})` : ''}`.trim() }
}
