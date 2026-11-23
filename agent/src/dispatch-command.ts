/**
 * The skill's dispatch command: the placeholder it carries, and the one exact shape that is parsed
 * and labelled. Pure (node:crypto only) so approval-policy can describe a dispatch without the agent's other modules.
 */
import { createHash } from 'node:crypto'

/** Stands in for the one-time key; canUseTool swaps it for a nonce only once the command is approved. */
export const DISPATCH_PLACEHOLDER = '__OSBORN_DISPATCH_APPROVAL__'
export const hasDispatchPlaceholder = (cmd: string): boolean => cmd.includes(DISPATCH_PLACEHOLDER)

/** What a nonce is bound to: the body the user approved (JSON, so no two bodies share a hash). */
export const dispatchBodyHash = (project: string, instruction: string): string =>
  createHash('sha256').update(JSON.stringify([project, instruction])).digest('hex')

/** Both fields are text with no control characters except newline and tab. */
export const dispatchFieldsOk = (project: unknown, instruction: unknown): boolean =>
  typeof project === 'string' && typeof instruction === 'string' && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(project + instruction)

const URL_TOKEN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/dispatch$/
const PLAIN_TOKEN = new Set(['curl', '-s', '-S', '-sS', '-X', 'POST', '-H', '--data-binary', '@-'])
const HEADERS = new Set(['Content-Type: application/json', 'Authorization: Bearer $OSBORN_SYNC_TOKEN', `X-Osborn-Dispatch-Key: ${DISPATCH_PLACEHOLDER}`])

/**
 * {project, instruction} when `cmd` is the skill's command: one line of curl to /dispatch with the
 * placeholder once, only the three expected quoted headers, `--data-binary @-` fed by one `<<'EOF'`
 * heredoc that ends the command. Anything else is null: not labelled, not keyed. This keeps what the
 * user is shown equal to what is sent for the skill's own command; it is a consent step, not a sandbox.
 */
export function parseDispatchCurl(cmd: string): { project: string; instruction: string } | null {
  if (cmd.split(DISPATCH_PLACEHOLDER).length !== 2) return null
  const m = /^([^<]*)<<'EOF'\n([\s\S]*?)\nEOF[ \t]*\n?\s*$/.exec(cmd)
  if (!m || /\\|\n|[;&|`]|\$\(|\$\{/.test(m[1]) || m[2].split('\n').includes('EOF')) return null
  const quoted: string[] = []
  const bare = m[1].replace(/'[^']*'|"[^"]*"/g, (q) => { quoted.push(q.slice(1, -1)); return '' })
  if (!quoted.length || !quoted.every((q) => HEADERS.has(q))) return null
  const tokens = bare.split(/\s+/).filter(Boolean)
  const urls = tokens.filter((t) => URL_TOKEN.test(t))
  const rest = tokens.filter((t) => !URL_TOKEN.test(t))
  if (urls.length !== 1 || tokens[0] !== 'curl' || !rest.every((t) => PLAIN_TOKEN.has(t))) return null
  if (rest.filter((t) => t === '--data-binary').length !== 1 || rest.filter((t) => t === '@-').length !== 1 || rest.filter((t) => t === '-H').length !== quoted.length) return null
  try {
    const j = JSON.parse(m[2])
    return dispatchFieldsOk(j?.project, j?.instruction) ? { project: j.project, instruction: j.instruction } : null
  } catch { return null }
}
