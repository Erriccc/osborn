/**
 * approval-policy.ts — what happens to a tool permission request, whoever
 * answers it (browser card, watch, phone keypad).
 *
 * Pure (no LiveKit, no SDK), so the rules are testable on their own:
 * - the approval mode (Ask me / Auto-review / Allow all), saved on the agent
 *   and applied here for the browser and phone calls alike (#364),
 * - the plain-words description of a request (browser card and phone prompt),
 * - the session's always-allow list ("Always" in the browser, keypad 3) and what it covers.
 */
import { classifyRisk, type RiskTier } from './risk-tier.js'
import { DISPATCH_TOOL, describeDispatch } from './dispatch.js'

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
  workspaceRoot: string | undefined,
): { approve: boolean; tier: RiskTier } {
  // No known cwd → nothing is provably inside it → nothing is low risk.
  const tier: RiskTier = workspaceRoot ? classifyRisk(toolName, input, workspaceRoot) : 'high'
  return { approve: mode === 'allow-all' || (mode === 'auto-review' && tier === 'low'), tier }
}

/**
 * What a phone caller hears at the start of the call about approvals (#364).
 * It says what actually happens on the call: with phone tools off nothing
 * runs; with keypad approvals off every request that needs an OK is declined
 * (the phone policy runs before the mode), so the mode is not claimed.
 */
export function approvalModeAnnouncement(mode: ApprovalMode, call: { toolsOn: boolean; keypadOn: boolean }): string {
  if (!call.toolsOn) return 'Tools are off on phone calls for now, so on this call I can only talk.'
  if (!call.keypadOn) return 'Approvals are off on phone calls for now: anything that needs your OK is declined, so approve it in the app.'
  const how = mode === 'allow-all'
    ? 'I will run actions without asking.'
    : mode === 'auto-review'
      ? 'I will run low-risk actions and ask you about anything risky: press 1 to allow, 2 to deny, 3 to always allow.'
      : 'I will ask you before each action: press 1 to allow, 2 to deny, 3 to always allow.'
  return `${approvalModeLabel(mode)} is on. ${how}`
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
  if (toolName === DISPATCH_TOOL) return describeDispatch(input)
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
  if (toolName === DISPATCH_TOOL) return describeDispatch(input).replace(/^Start/, 'start')
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
  return `Osborn wants to ${speakablePermission(toolName, input)}. Press 1 to allow, 2 to deny, or 3 to always allow ${alwaysScope(toolName, input).label} for this call.`
}

/** JSON with sorted keys, so the same input always gives the same key. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/**
 * What "always allow" covers for this request, and its plain-words label
 * (shown on the browser's Always button and read out on a call):
 * - Write/Edit/MultiEdit: writing this file;
 * - Read/NotebookRead: reading this file; LS: listing this folder (a read
 *   approval never covers a write, nor another file);
 * - Bash: this exact command;
 * - Grep/Glob: this exact search (same pattern, path and options);
 * - anything else: this exact request (same tool, same input).
 * No tool is ever allowed as a whole. `key` is null when nothing can be
 * recorded (a file tool with no file).
 */
export function alwaysScope(toolName: string, input: ToolInput): { key: string | null; label: string } {
  if (PATH_SCOPED_TOOLS.has(toolName)) {
    const file = str(input?.file_path)
    return { key: file ? `path:${file}` : null, label: 'this file' }
  }
  if (toolName === 'Read' || toolName === 'NotebookRead') {
    const file = str(input?.file_path) || str(input?.notebook_path)
    return { key: file ? `read:${file}` : null, label: 'reading this file' }
  }
  if (toolName === 'LS') {
    const dir = str(input?.path)
    return { key: dir ? `ls:${dir}` : null, label: 'listing this folder' }
  }
  if (toolName === 'Bash') {
    const cmd = str(input?.command)
    return { key: cmd ? `bash:${cmd}` : null, label: 'this exact command' }
  }
  const exact = `exact:${toolName}:${stableJson(input ?? {})}`
  if (toolName === 'Grep' || toolName === 'Glob') return { key: exact, label: 'this exact search' }
  return { key: exact, label: 'this exact request' }
}

/** What answerPending needs from an LLM holding a permission request (ClaudeLLM / PipelineDirectLLM). */
export interface PermissionHolder {
  getPendingPermission?(): { toolName: string; input: any; requestId: string } | null
  respondToPermission(allow: boolean, message?: string, requestId?: string): boolean | void
}

/**
 * Answers ONE request: the one `requestId` names, if `holder` still has it
 * pending. A late answer (its request already settled, or a different one
 * pending now, a parked brain's included) settles nothing. 'always_allow'
 * records that request's alwaysScope. True when it was settled.
 */
export function answerPending(
  holder: PermissionHolder | null | undefined,
  answer: PermissionAnswer,
  requestId: unknown,
  allows: SessionAllows,
): boolean {
  if (typeof requestId !== 'string' || !requestId || !holder) return false
  const pending = holder.getPendingPermission?.()
  if (!pending || pending.requestId !== requestId) return false
  if (answer === 'always_allow') {
    const added = recordAlwaysAllow(allows, pending.toolName, pending.input)
    if (added) console.log(`🔒 Always-allow added for session: ${added}`)
  }
  return holder.respondToPermission(answer !== 'deny', undefined, requestId) !== false
}

/**
 * An answer with no requestId, from a browser tab or mobile build older than
 * request ids. Settles only the LIVE session's request, only when it is the one
 * request pending anywhere (a parked brain with a pending request blocks it),
 * and never records an always-allow: a no-id Always is allow-once. True when settled.
 */
export function answerPendingWithoutId(
  live: PermissionHolder | null | undefined,
  parked: PermissionHolder | null | undefined,
  answer: PermissionAnswer,
): boolean {
  const pending = live?.getPendingPermission?.()
  if (!live || !pending) return false
  if (parked && parked !== live && parked.getPendingPermission?.()) return false
  return live.respondToPermission(answer !== 'deny', undefined, pending.requestId) !== false
}

/** The session's always-allow list (keys from alwaysScope). Cleared with each new voice session. */
export type SessionAllows = Set<string>

export function newSessionAllows(): SessionAllows {
  return new Set()
}

export function isAlwaysAllowed(allows: SessionAllows, toolName: string, input: ToolInput): boolean {
  const { key } = alwaysScope(toolName, input)
  return !!key && allows.has(key)
}

/** Records an "always allow" for this request. Returns what was added, for the log. */
export function recordAlwaysAllow(allows: SessionAllows, toolName: string, input: ToolInput): string | null {
  const { key } = alwaysScope(toolName, input)
  if (!key) return null
  allows.add(key)
  return key
}

