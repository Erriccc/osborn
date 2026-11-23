/**
 * The skill's dispatch command: the placeholder it carries, and the one exact shape that is parsed
 * and labelled. Pure (node:crypto only) so approval-policy can describe a dispatch without the agent's other modules.
 */
import { createHash } from 'node:crypto'

/** Stands in for the one-time key; canUseTool swaps it for a nonce only once the command is approved. */
export const DISPATCH_PLACEHOLDER = '__OSBORN_DISPATCH_APPROVAL__'
export const hasDispatchPlaceholder = (cmd: string): boolean => cmd.includes(DISPATCH_PLACEHOLDER)

/** What a nonce is bound to: the body the user approved. */
export const dispatchBodyHash = (project: string, instruction: string): string =>
  createHash('sha256').update(`${project}\0${instruction}`).digest('hex')

const URL_TOKEN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/dispatch$/
const PLAIN_TOKEN = new Set(['curl', '-s', '-S', '-sS', '-X', 'POST', '-H', '--data-binary', '@-', '\\'])

/**
 * {project, instruction} when `cmd` is exactly the skill's command: one curl to /dispatch carrying the
 * placeholder once, `--data-binary @-` fed by one quoted heredoc that ends the command, quoted header
 * values with no substitution, and nothing else (no -d/--data/--json/-F/@file, no other commands).
 * Anything else is null, and is neither labelled nor given a key.
 */
export function parseDispatchCurl(cmd: string): { project: string; instruction: string } | null {
  if (cmd.split(DISPATCH_PLACEHOLDER).length !== 2) return null
  const m = /^([^<]*)<<'(\w+)'\n([\s\S]*?)\n\2[ \t]*\n?\s*$/.exec(cmd)
  if (!m) return null
  const head = m[1].replace(/\\\n/g, ' ')
  if (/\n/.test(head)) return null
  const quoted: string[] = []
  const bare = head.replace(/'[^']*'|"[^"]*"/g, (q) => { quoted.push(q); return '' })
  if (quoted.some((q) => /`|\$\(|\$\{/.test(q))) return null
  const tokens = bare.split(/\s+/).filter(Boolean)
  const urls = tokens.filter((t) => URL_TOKEN.test(t))
  const rest = tokens.filter((t) => !URL_TOKEN.test(t))
  if (urls.length !== 1 || tokens[0] !== 'curl' || !rest.every((t) => PLAIN_TOKEN.has(t))) return null
  if (rest.filter((t) => t === '--data-binary').length !== 1 || rest.filter((t) => t === '@-').length !== 1) return null
  try {
    const j = JSON.parse(m[3])
    return typeof j?.project === 'string' && typeof j?.instruction === 'string' ? { project: j.project, instruction: j.instruction } : null
  } catch { return null }
}
