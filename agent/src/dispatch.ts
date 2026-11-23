/**
 * The hub's `dispatch` tool: an in-process MCP tool with structured input, so the permission dialog
 * (and the phone and watch prompts) describe exactly what will be sent. Not in allowedTools, so every
 * call goes through canUseTool and the approval mode; the tier is high (an MCP call). Only the hub's
 * LLM is given the server; background slots never are. Pure: no imports.
 */
export const DISPATCH_SERVER = 'dispatch'
export const DISPATCH_TOOL = `mcp__${DISPATCH_SERVER}__send`

const MAX_PROJECT = 100
const MAX_INSTRUCTION = 8000

/** Text with no control characters (newline and tab allowed): NUL, C0/C1 (incl. U+0085, U+009B), bidi marks and overrides (U+200E/F, U+202A-E, U+2066-9). */
export const dispatchFieldsOk = (project: unknown, instruction: unknown): boolean =>
  typeof project === 'string' && typeof instruction === 'string'
  && project.trim().length > 0 && instruction.trim().length > 0
  && project.length <= MAX_PROJECT && instruction.length <= MAX_INSTRUCTION
  && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/.test(project + instruction)

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s)

/** The dialog line for a dispatch call, from its structured input (never a shell command). */
export function describeDispatch(input: { project?: unknown; instruction?: unknown } | null | undefined): string {
  const project = typeof input?.project === 'string' ? input.project : ''
  const instruction = typeof input?.instruction === 'string' ? input.instruction : ''
  return `Start a background session in ${cut(project, 60)}: ${cut(instruction.replace(/\s+/g, ' '), 120)}`
}
