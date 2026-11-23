/**
 * Screenshot-based retry for an /act the DOM brain could not match (#478).
 * Pure decisions only; the engine owns the Stagehand call, the lock and the fence.
 */

/** Env kill switch: set to 1 and no /act makes a vision attempt. */
export const VISION_KILL_ENV = 'OSBORN_NO_VISION_RETRY'

export type VisionGate = { enabled: boolean; why?: 'env' | 'request' | 'instruction' }

/** "If X ... otherwise do nothing" must stay a no-op, and a guess from pixels must not delete, pay or send. */
const CONDITIONAL = /\b(if|otherwise|unless)\b/i
const DESTRUCTIVE = /\b(pay\w*|checkout|order|subscri\w*|donat\w*|transfer|publish|post|approve|merge|accept|cancel|book|reserve|sign.?out|log.?out|delete|remove|purchase|buy|send|submit|confirm)\b/i

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
/**
 * Stagehand maps the model's 0-1000 coordinates onto its configured viewport, so a click on a tab of another size lands
 * off by up to the size difference (at the far edge). Its default 1288x711 against the engine's 1280x720 tab is 8x9 px;
 * a phone or tablet tab is hundreds.
 */
const VIEWPORT_SLACK_PX = 10
export const viewportMatches = (page: Size, brain: Size): boolean => !!page && !!brain
  && Math.abs(page.width - brain.width) <= VIEWPORT_SLACK_PX && Math.abs(page.height - brain.height) <= VIEWPORT_SLACK_PX

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

/** Tools that look or wait; everything else the agent calls is an interaction (the DOM `act` tool included). */
const PASSIVE = new Set(['done', 'think', 'screenshot', 'wait', 'ariaTree', 'extract', 'close'])
/** The only interactions that are counted, one per attempt. */
const COUNTED = new Set(['click', 'type', 'keys'])

type VisionAction = { type?: string; reasoning?: string; description?: string; describe?: string; coordinates?: number[]; success?: boolean; error?: unknown }
type Part = { type?: string; toolName?: string; output?: { value?: unknown } }
type Msg = { role?: string; content?: unknown }
type AgentLike = { success?: boolean; message?: string; actions?: VisionAction[]; messages?: Msg[] }

/** The model step of the first interaction call, and of the first screenshot that came back with an image. */
function stepsOf(messages: Msg[] = []): { call?: number; looked?: number } {
  let step = -1
  const out: { call?: number; looked?: number } = {}
  for (const m of messages) {
    const parts: Part[] = Array.isArray(m?.content) ? (m.content as Part[]) : []
    if (m?.role === 'assistant') {
      step++
      if (out.call === undefined && parts.some((p) => p?.type === 'tool-call' && p.toolName && !PASSIVE.has(p.toolName))) out.call = step
    } else if (m?.role === 'tool' && out.looked === undefined) {
      const shot = parts.some((p) => p?.type === 'tool-result' && p.toolName === 'screenshot' && Array.isArray(p.output?.value) && (p.output!.value as Array<{ type?: string }>).some((v) => v?.type === 'media'))
      if (shot) out.looked = step
    }
  }
  return out
}

/**
 * What the attempt did. `acted` only for exactly one click, type or keys press that succeeded after a
 * screenshot that returned an image in an EARLIER step. `ran` is true when something else was done
 * (not counted, or not verified): the caller must not treat the page as untouched. `note` says why.
 */
export function summarizeVision(res: AgentLike | null | undefined): { acted: boolean; ran: boolean; did: string; note: string } {
  const none = { acted: false, ran: false, did: '' }
  const run = (res?.actions ?? []).filter((a) => a?.type && !PASSIVE.has(a.type))
  if (!run.length) return { ...none, note: res?.success === false && res.message ? res.message.slice(0, 120) : '' }
  const a = run[0]
  if (run.length === 1 && a.type !== 'act' && (a.success === false || a.error)) return { ...none, note: `the ${a.type} failed${a.error ? `: ${String(a.error).slice(0, 80)}` : ''}` }
  if (run.length > 1 || !COUNTED.has(a.type!)) return { ...none, ran: true, note: `the retry ran ${run.map((x) => x.type).join(' + ')}${a.type === 'act' ? ' (the DOM tool; its effect is unverified)' : ''}; only a single click, type or keys press is counted` }
  const { call, looked } = stepsOf(res?.messages)
  if (looked === undefined || call === undefined || looked >= call) return { ...none, ran: true, note: 'the retry acted without a screenshot that came back with an image first' }
  return { acted: true, ran: true, note: '', did: `vision (${a.type}): ${String(a.describe ?? a.description ?? a.reasoning ?? res?.message ?? '').slice(0, 120)}${a.coordinates ? ` at (${a.coordinates.join(',')})` : ''}`.trim() }
}
