/**
 * approval-policy.ts — what happens to a tool permission request, whoever
 * answers it (browser card, watch, phone keypad).
 *
 * Pure (no LiveKit, no SDK), so the rules are testable on their own:
 * - the approval mode (Ask me / Auto-review / Allow all), saved on the agent
 *   and applied here for the browser and phone calls alike (#364),
 * - the plain-words description of a request (browser card and phone prompt),
 * - the session's always-allow list ("Always" in the browser, keypad 3).
 */
import { classifyRisk, type RiskTier } from './risk-tier.js'

/** An answer to a pending permission, from any surface. */
export type PermissionAnswer = 'allow' | 'deny' | 'always_allow'

/**
 * 'ask'         → every request asks (browser card, or the keypad on a call).
 * 'auto-review' → low-risk requests (classifyRisk) are approved; the rest ask.
 * 'allow-all'   → every request is approved.
 * It only answers requests the agent raises: the PreToolUse / canUseTool gate
 * still denies what it denies, and on a phone call the phone policy runs first.
 */
export type ApprovalMode = 'ask' | 'auto-review' | 'allow-all'

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'ask'

export function isApprovalMode(v: unknown): v is ApprovalMode {
  return v === 'ask' || v === 'auto-review' || v === 'allow-all'
}

const MODE_LABELS: Record<ApprovalMode, string> = { 'ask': 'Ask me', 'auto-review': 'Auto-review', 'allow-all': 'Allow all' }

/** The mode's name as the app shows it. */
export function approvalModeLabel(mode: ApprovalMode): string {
  return MODE_LABELS[mode]
}

/**
 * Whether the mode approves this request without asking, and its risk tier.
 * `workspaceRoot` is the session's working directory (in-workspace edits are low risk).
 */
export function autoApproval(
  mode: ApprovalMode,
  toolName: string,
  input: ToolInput,
  workspaceRoot?: string,
): { approve: boolean; tier: RiskTier } {
  const tier = classifyRisk(toolName, input, workspaceRoot)
  return { approve: mode === 'allow-all' || (mode === 'auto-review' && tier === 'low'), tier }
}

/** What a phone caller hears at the start of the call about approvals (#364). */
export function approvalModeAnnouncement(mode: ApprovalMode, phoneToolsOn: boolean): string {
  const how = mode === 'allow-all'
    ? 'I will run actions without asking.'
    : mode === 'auto-review'
      ? 'I will run low-risk actions and ask you about anything risky.'
      : 'I will ask you before each action.'
  const toolsOff = phoneToolsOn ? '' : ' Tools are off on phone calls for now, so on this call I can only talk.'
  return `${approvalModeLabel(mode)} is on. ${how}${toolsOff}`
}

type ToolInput = Record<string, unknown> | null | undefined

// File tools whose "always allow" covers one file, not the whole tool.
const PATH_SCOPED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const baseName = (p: string) => p.split('/').filter(Boolean).pop() || p

/**
 * The browser card's one-line description of a request (sent as
 * permission_request.description).
 */
export function describePermission(toolName: string, input: ToolInput): string {
  const cmd = str(input?.command)
  const file = str(input?.file_path)
  const url = str(input?.url)
  if (toolName === 'Bash' && cmd) return `I want to run the command: ${cmd.substring(0, 60)}${cmd.length > 60 ? '...' : ''}`
  if (toolName === 'Write' && file) return `I want to create or overwrite the file: ${file}`
  if (toolName === 'Edit' && file) return `I want to edit the file: ${file}`
  if (toolName === 'WebFetch' && url) return `I want to fetch content from: ${url}`
  return `I need permission to use ${toolName}.`
}

/** The same request in words that read well aloud (short: a caller hears all of it). */
export function speakablePermission(toolName: string, input: ToolInput): string {
  const cmd = str(input?.command).trim()
  const file = str(input?.file_path) || str(input?.notebook_path)
  const url = str(input?.url)
  if (toolName === 'Bash' && cmd) {
    const words = cmd.split(/\s+/).slice(0, 8).join(' ')
    return `run the command ${words}${cmd.split(/\s+/).length > 8 ? ' and so on' : ''}`
  }
  if (toolName === 'Write' && file) return `create or overwrite the file ${baseName(file)}`
  if ((toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') && file) return `edit the file ${baseName(file)}`
  if (toolName === 'WebFetch' && url) {
    try { return `fetch a page from ${new URL(url).hostname}` } catch { return 'fetch a web page' }
  }
  if (toolName === 'WebSearch') return 'search the web'
  if (toolName === 'Task' || toolName === 'Agent') {
    const who = str(input?.subagent_type)
    return who ? `start the ${who} agent` : 'start a helper agent'
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (mcp) return `use ${mcp[2].replace(/[_-]+/g, ' ')} from ${mcp[1].replace(/[_-]+/g, ' ')}`
  return `use the ${toolName.replace(/[_-]+/g, ' ')} tool`
}

/** What a phone caller hears for a pending request (keypad approvals, #363). */
export function phoneApprovalPrompt(toolName: string, input: ToolInput): string {
  return `Osborn wants to ${speakablePermission(toolName, input)}. Press 1 to allow, 2 to deny, or 3 to always allow.`
}

/**
 * The session's always-allow list. "Always" covers one file for the file
 * tools (Write, Edit, MultiEdit) and the whole tool for every other tool.
 * Cleared with each new voice session.
 */
export interface SessionAllows {
  paths: Set<string>
  tools: Set<string>
}

export function newSessionAllows(): SessionAllows {
  return { paths: new Set(), tools: new Set() }
}

export function isAlwaysAllowed(allows: SessionAllows, toolName: string, input: ToolInput): boolean {
  if (PATH_SCOPED_TOOLS.has(toolName)) {
    const file = str(input?.file_path)
    return !!file && allows.paths.has(file)
  }
  return allows.tools.has(toolName)
}

/** Records an "always allow" for this request. Returns what was added, for the log. */
export function recordAlwaysAllow(allows: SessionAllows, toolName: string, input: ToolInput): string | null {
  if (PATH_SCOPED_TOOLS.has(toolName)) {
    const file = str(input?.file_path)
    if (!file) return null
    allows.paths.add(file)
    return file
  }
  if (!toolName) return null
  allows.tools.add(toolName)
  return toolName
}
