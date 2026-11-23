/**
 * The hub's `dispatch` tool: an in-process MCP tool with structured input, so the permission dialog
 * (and the phone and watch prompts) describe what will be sent. Not in allowedTools, so every call goes
 * through canUseTool and the approval mode; the tier is high (an MCP call). Only the hub's LLM is given
 * the server (background slots never are) and its sub-agents are refused. Also: project name to session.
 */
import { basename } from 'node:path'
import { clip } from './content/lens-ingest.js'
import { redactSecrets } from './content/secret-rules.js'
import type { AdmitResult } from './slot-manager.js'

export const DISPATCH_SERVER = 'dispatch'
export const DISPATCH_TOOL_NAME = 'send'
export const DISPATCH_TOOL = `mcp__${DISPATCH_SERVER}__${DISPATCH_TOOL_NAME}`

/** Why a dispatch call is refused for this caller, or null. Sub-agents inherit every tool, so they are refused here. */
export const dispatchCallRefusal = (toolName: string, agentType: unknown): string | null =>
  toolName === DISPATCH_TOOL && agentType ? 'Only the main conversation can dispatch to another project; a sub-agent cannot. Report back to the main agent instead.' : null

const MAX_PROJECT = 100
const MAX_INSTRUCTION = 2000

/** Text with no control characters (newline and tab allowed): NUL, C0/C1 (incl. U+0085, U+009B), bidi marks and overrides (U+200E/F, U+202A-E, U+2066-9). */
export const dispatchFieldsOk = (project: unknown, instruction: unknown): boolean =>
  typeof project === 'string' && typeof instruction === 'string'
  && project.trim().length > 0 && instruction.trim().length > 0
  && project.length <= MAX_PROJECT && instruction.length <= MAX_INSTRUCTION
  && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(project + instruction)

const RUNS_UNASKED = 'The new session runs without asking you again'

/** The dialog text for a dispatch call, from its structured input: all of what will be sent. */
export function describeDispatch(input: { project?: unknown; instruction?: unknown } | null | undefined): string {
  const { project, instruction } = fields(input)
  return `Start a background session in ${project}: ${instruction}\n${RUNS_UNASKED}.`
}

/** The phone and watch version: short, and says the rest is in the app. */
export function speakableDispatch(input: { project?: unknown; instruction?: unknown } | null | undefined): string {
  const { project, instruction } = fields(input)
  const one = instruction.replace(/\s+/g, ' ')
  return `start a background session in ${clip(project, 60)}: ${clip(one, 120)}${one.length > 120 ? ' and more; the full text is in the app' : ''}. ${RUNS_UNASKED}`
}

function fields(input: { project?: unknown; instruction?: unknown } | null | undefined): { project: string; instruction: string } {
  return { project: typeof input?.project === 'string' ? input.project : '', instruction: typeof input?.instruction === 'string' ? input.instruction : '' }
}

/** What leaves the machine for the phone when a spoke finishes: short, with secrets redacted. */
export function spokePhoneNotice(project: string, status: string, text: string): string {
  if (status === 'timed_out') return `${project} is still working after an hour.`
  if (status === 'stopped') return `${project} was stopped before it finished (the session ended).`
  return `${project} ${status}: ${redactSecrets(text.trim()).slice(0, 300) || 'no final message'}`
}

/** Flat shape: the agent builds without strictNullChecks, so a union would not narrow. */
export interface DispatchTarget { ok: boolean; sessionId?: string; cwd?: string; project?: string; error?: string; reason?: string }

const DISPATCH_LIVE_WINDOW_MS = 3 * 60_000
const projectKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * The newest session whose project folder name matches `project` (case and punctuation ignored).
 * Two different folders with that name are ambiguous; the focused session, a busy slot or a full
 * slot cap are refused. `sessions` is listAllClaudeSessions' output.
 */
export function resolveDispatchTarget(
  project: string,
  sessions: Array<{ sessionId: string; cwd: string; timestamp: Date }>,
  deps: { seat: (id: string) => AdmitResult; slotState: (id: string) => 'none' | 'idle' | 'busy'; dirExists: (cwd: string) => boolean; now?: number; ownWriteAt?: (id: string) => number | undefined },
): DispatchTarget {
  const want = projectKey(project || '')
  if (!want) return { ok: false, error: 'name the project to send this to' }
  const hits = sessions.filter((s) => s.cwd && projectKey(basename(s.cwd)) === want && deps.dirExists(s.cwd))
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  if (!hits.length) return { ok: false, error: `no session found for a project called "${project}"` }
  const folders = [...new Set(hits.map((h) => h.cwd))]
  if (folders.length > 1) return { ok: false, error: `"${project}" matches ${folders.length} folders (${folders.join(', ')}); say which one` }
  const pick = hits[0]
  const seat = deps.seat(pick.sessionId)
  if (!seat.ok) {
    // At the cap the target is known, so the caller can keep the instruction for that project (#378).
    if (seat.reason === 'cap') return { ok: false, error: seat.error, reason: 'cap', sessionId: pick.sessionId, cwd: pick.cwd, project: basename(pick.cwd) }
    if (seat.reason !== 'duplicate') return { ok: false, error: seat.error }
    if (deps.slotState(pick.sessionId) === 'busy') return { ok: false, error: `${basename(pick.cwd)} is still working on an earlier task` }
  }
  // Written to moments ago and not by our own slot: probably open in a terminal, and a second process resuming it corrupts the transcript.
  const own = deps.ownWriteAt?.(pick.sessionId)  // the last write was our own freed slot's
  const ours = own !== undefined && pick.timestamp.getTime() <= own + 5_000
  if (seat.ok && !ours && (deps.now ?? Date.now()) - pick.timestamp.getTime() < DISPATCH_LIVE_WINDOW_MS) {
    return { ok: false, error: `the newest ${basename(pick.cwd)} session was active a moment ago and may be open elsewhere; close it or try again in a few minutes` }
  }
  return { ok: true, sessionId: pick.sessionId, cwd: pick.cwd, project: basename(pick.cwd) }
}

