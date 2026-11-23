/**
 * loops-ledger.ts — follow-through (#378): the per-session ledger of open items.
 *
 * Hooks append small JSON lines to `{osbDir}/loops.jsonl` with no model involved:
 * the user's own asks, todo and task changes, sub-agent dispatches that never
 * stopped, unanswered questions, unsettled permission requests, refused
 * background sessions and work cut off by the tool-call limit. Folding the lines
 * gives the items still open; the flush worker files those as GitHub issues
 * through the frontend and appends `filed`, and the next session start recaps
 * up to three of them (`recapped`).
 *
 * Who said it matters: every record carries an `origin`. Only a verbatim ask in
 * the user's own prompt (`user_mic`) is `explicit`; meeting, phone, tool and
 * system text is always `inferred`. Only the foreground voice session's records
 * (`fg`) are ever filed; background slots keep theirs local.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSidecarPath } from './session-store.js'
import { appendJsonlLine, readJsonlLines } from './jsonl-sidecar.js'
import { claudeDir } from './content/lens-paths.js'
import { githubIssueBase } from './steward-verdict.js'

const LOOPS_FILE = 'loops.jsonl'
export const LOOPS_LOCK = 'loops.flush.lock'
// Shorter than the startup drain's delay (index.ts, 120s after boot): a worker killed with the
// machine (Fly stop) leaves a lock that the next boot's drain can already replace.
export const LOOPS_LOCK_TTL_MS = 90_000
/** One appendFileSync under this size is a single O_APPEND write. */
export const MAX_LINE_BYTES = 4000
/** Raw prompts are kept as evidence up to this many bytes. */
export const MAX_PROMPT_BYTES = 3500
/** An item's text is a short paraphrase, never a long transcript quote. */
export const MAX_ITEM_CHARS = 200
const RECAP_MAX = 3

export type LoopOrigin = 'user_mic' | 'meeting' | 'phone' | 'tool' | 'system'
export type LoopSource = 'explicit' | 'inferred'

export type LoopKind =
  | 'session' | 'prompt' | 'ask'
  | 'todo' | 'todo_status' | 'task' | 'task_status'
  | 'dispatch_started' | 'dispatch_stopped' | 'dispatch_severed'
  | 'steward_block' | 'steward_clear'
  | 'question' | 'question_answered'
  | 'permission_pending' | 'permission_settled'
  | 'slot_refused' | 'budget_denied' | 'open_loop' | 'queued'
  | 'filed' | 'recapped' | 'held'

export interface LoopRecord {
  v: 1
  at: string
  kind: LoopKind
  /** The item this record opens or changes. */
  id?: string
  text?: string
  source?: LoopSource
  origin?: LoopOrigin
  /** Written by the foreground voice session: the only records that may file. */
  fg?: boolean
  turn?: number
  status?: string
  by?: 'user' | 'abort'
  url?: string
  cwd?: string
  /** `queued`: the project the instruction was meant for, and the instruction itself (`text` is a short title). */
  project?: string
  instruction?: string
  /** `held`: the repo that held the item back (public or unknown visibility). */
  repo?: string
  truncated?: boolean
}

export type LoopRecordInput = Omit<LoopRecord, 'v' | 'at'> & { at?: string }

export interface LoopItem {
  id: string
  kind: LoopKind
  text: string
  source: LoopSource
  origin: LoopOrigin
  fg: boolean
  turn?: number
  at: string
  open: boolean
  filedUrl?: string
  filedAt?: string
  recapped?: boolean
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** 12 hex of sha256 over kind + normalized text: stable under case and punctuation. */
export function loopKey(kind: string, text: string): string {
  const norm = `${kind}:${(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`
  return createHash('sha256').update(norm).digest('hex').slice(0, 12)
}

/** Who a prompt came from. Anything tagged like `[MEETING`, `[SYSTEM`, `[CONTEXT` is never the user's own ask. */
export function classifyPromptOrigin(text: string, opts: { phone?: boolean } = {}): LoopOrigin {
  const t = String(text || '').trimStart()
  if (/^\[MEETING\b/i.test(t)) return 'meeting'
  if (opts.phone) return 'phone'
  if (/^\[[A-Z][A-Z0-9 _-]*(?:\]|\s|—|:)/.test(t)) return 'system'
  return 'user_mic'
}

const ASK_RE = /\b(remind me|don'?t (?:let me )?forget|do not forget|let'?s not forget|remember to|(?:we|i) still need to|still have to|follow up (?:on|with)|note to self|make a note|add (?:this|that|it) to (?:the|my|our) (?:list|backlog|todos?)|(?:later|eventually|at some point),? (?:we|i) should|(?:we|i) should (?:later|eventually|at some point)|to-?do:)/i

/** The user's own asks in a prompt, verbatim sentences, capped. Only meaningful for user_mic prompts. */
export function extractAsks(text: string, max = 3): string[] {
  const out: string[] = []
  for (const raw of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.replace(/\s+/g, ' ').trim()
    if (s.length < 6 || !ASK_RE.test(s)) continue
    out.push(s.length > MAX_ITEM_CHARS ? s.slice(0, MAX_ITEM_CHARS - 1) + '…' : s)
    if (out.length >= max) break
  }
  return out
}

/** One todo-list snapshot diff: new items and status changes, keyed by content. */
export function diffTodos(
  prev: Map<string, string> | undefined,
  todos: Array<{ content?: unknown; status?: unknown }>,
): { next: Map<string, string>; changes: Array<{ content: string; from?: string; to: string }> } {
  const next = new Map<string, string>()
  const changes: Array<{ content: string; from?: string; to: string }> = []
  for (const t of Array.isArray(todos) ? todos : []) {
    const content = typeof t?.content === 'string' ? t.content.trim() : ''
    const status = typeof t?.status === 'string' ? t.status : 'pending'
    if (!content) continue
    next.set(content, status)
    const from = prev?.get(content)
    if (from !== status) changes.push({ content, ...(from ? { from } : {}), to: status })
  }
  return { next, changes }
}

const OPENS: Partial<Record<LoopKind, (r: LoopRecord) => boolean>> = {
  ask: () => true,
  todo: (r) => r.status !== 'completed',
  todo_status: (r) => r.status === 'pending' || r.status === 'in_progress',
  task: (r) => r.status !== 'completed' && r.status !== 'deleted',
  task_status: (r) => r.status === 'pending' || r.status === 'in_progress',
  dispatch_started: () => true,
  dispatch_stopped: () => false,
  // Cut off by an interrupt or a close: SubagentStop never fires, the work did not finish.
  dispatch_severed: () => true,
  steward_block: () => true,
  steward_clear: () => false,
  question: () => true,
  question_answered: () => false,
  permission_pending: () => true,
  // Settled by an abort is NOT an answer: it stays open.
  permission_settled: (r) => r.by !== 'user',
  slot_refused: () => true,
  budget_denied: () => true,
  open_loop: () => true,
  // An instruction that found no free background slot: startable later, open until filed.
  queued: () => true,
}

/** Fold the ledger: the last record per item id wins. `prompt` and `session` lines are never items. */
export function foldLoops(records: LoopRecord[]): Map<string, LoopItem> {
  const items = new Map<string, LoopItem>()
  for (const r of records) {
    if (!r || !r.id) continue
    if (r.kind === 'filed') {
      const it = items.get(r.id)
      if (it) { it.filedUrl = r.url; it.filedAt = r.at }
      continue
    }
    if (r.kind === 'recapped') {
      const it = items.get(r.id)
      if (it) it.recapped = true
      continue
    }
    const opens = OPENS[r.kind]
    if (!opens) continue
    const prev = items.get(r.id)
    const origin: LoopOrigin = r.origin ?? prev?.origin ?? 'tool'
    const item: LoopItem = prev ?? {
      id: r.id, kind: r.kind, text: '', source: 'inferred', origin, fg: false, at: r.at, open: true,
    }
    if (r.text && (!prev || !item.text)) item.text = r.text
    if (!prev) {
      // Only a user's own words can be explicit.
      item.source = r.source === 'explicit' && origin === 'user_mic' ? 'explicit' : 'inferred'
      item.fg = r.fg === true
      if (typeof r.turn === 'number') item.turn = r.turn
    }
    item.open = opens(r)
    items.set(r.id, item)
  }
  return items
}

/** Items still open and not yet filed. */
export function openLoops(records: LoopRecord[]): LoopItem[] {
  return [...foldLoops(records).values()].filter((i) => i.open && !i.filedUrl && !!i.text)
}

/** Repos this ledger has learned are public (or of unknown visibility): they held an item back. */
export function publicRepos(records: LoopRecord[]): Set<string> {
  return new Set(records.filter((r) => r.kind === 'held' && r.repo).map((r) => r.repo!.toLowerCase()))
}

/** Open items this machine may file: written by the foreground voice session only. */
export function fileableLoops(records: LoopRecord[]): LoopItem[] {
  return openLoops(records).filter((i) => i.fg)
}

function isLoopRecord(o: any): o is LoopRecord {
  return !!o && typeof o === 'object' && o.v === 1 && typeof o.kind === 'string' && typeof o.at === 'string'
}

/** Serialize under MAX_LINE_BYTES, truncating the text when needed. */
export function serializeLoopRecord(rec: LoopRecord): string {
  let line = JSON.stringify(rec)
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES || !rec.text) return line
  let text = rec.text
  while (Buffer.byteLength(line) > MAX_LINE_BYTES && text.length > 0) {
    text = text.slice(0, Math.floor(text.length * 0.8))
    line = JSON.stringify({ ...rec, text, truncated: true })
  }
  return line
}

/** Ids for the item records (so status changes fold onto the same item). */
export const loopIds = {
  ask: (text: string) => `ask:${loopKey('ask', text)}`,
  todo: (content: string) => `todo:${loopKey('todo', content)}`,
  task: (taskId: string) => `task:${taskId}`,
  dispatch: (agentId: string) => `dispatch:${agentId}`,
  question: (toolUseId: string) => `question:${toolUseId}`,
  permission: (requestId: string) => `perm:${requestId}`,
  slot: (text: string) => `slot:${loopKey('slot', text)}`,
  budget: (turn: number, at: string) => `budget:${turn}:${at}`,
  openLoop: (text: string) => `open_loop:${loopKey('open_loop', text)}`,
  queued: (project: string, instruction: string) => `queued:${loopKey('queued', `${project} ${instruction}`)}`,
  steward: () => 'steward',
}

const MAX_QUEUED_INSTRUCTION = 800
const clipEllipsis = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/**
 * The record for an instruction refused at slot capacity. `text` is a short title; `instruction` keeps enough
 * to start it later. The hub model wrote the instruction, so it is inferred; only text the user typed
 * themselves (`typed`) is explicit.
 */
export function queuedLoopRecord(instruction: string, project: string, opts: { typed?: boolean } = {}): LoopRecordInput {
  const full = clipEllipsis(String(instruction || '').replace(/\s+/g, ' ').trim(), MAX_QUEUED_INSTRUCTION)
  const typed = opts.typed === true
  return {
    kind: 'queued', id: loopIds.queued(project, full), text: clipEllipsis(`Queued for ${project}: ${full}`, MAX_ITEM_CHARS), instruction: full, project,
    source: typed ? 'explicit' : 'inferred', origin: typed ? 'user_mic' : 'tool',
  }
}

/**
 * Keep a refused instruction in the TARGET project's ledger (its session `sessionId` under `cwd`), so the flush
 * files it to that project's own repo and never to the hub's. Writes the ledger's `session` line when missing.
 */
export function appendQueuedLoop(sessionId: string, cwd: string, instruction: string, project: string, opts: { typed?: boolean } = {}): boolean {
  if (!readLoopRecords(sessionId, cwd).some((r) => r.kind === 'session' && r.cwd)) appendLoopRecord(sessionId, cwd, { kind: 'session', cwd, fg: true })
  return appendLoopRecord(sessionId, cwd, { ...queuedLoopRecord(instruction, project, opts), fg: true })
}

// ── IO ──────────────────────────────────────────────────────────────────────

export function getLoopsPath(sessionId: string, workingDir: string): string {
  return getSidecarPath(sessionId, workingDir, LOOPS_FILE)
}

/** Append one record. Never throws: a ledger failure must not break a hook. */
export function appendLoopRecord(sessionId: string, workingDir: string, input: LoopRecordInput): boolean {
  try {
    if (!sessionId || !workingDir) return false
    const { at, ...rest } = input
    const rec: LoopRecord = { v: 1, at: at || new Date().toISOString(), ...rest }
    appendJsonlLine(getLoopsPath(sessionId, workingDir), serializeLoopRecord(rec))
    return true
  } catch {
    return false
  }
}

export function readLoopRecordsAt(path: string): LoopRecord[] {
  return readJsonlLines(path).filter(isLoopRecord)
}

export function readLoopRecords(sessionId: string, workingDir: string): LoopRecord[] {
  return readLoopRecordsAt(getLoopsPath(sessionId, workingDir))
}

/** `owner/name` of the working repo's github.com origin, else undefined. */
export function repoFromCwd(cwd: string): string | undefined {
  const base = cwd ? githubIssueBase(cwd) : undefined
  const m = base?.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/?$/)
  return m ? `${m[1]}/${m[2]}` : undefined
}

/** Every session ledger on this machine: `{sessionId, path, cwd}` (cwd from its `session` line). */
export function listLedgers(): Array<{ sessionId: string; path: string; cwd?: string }> {
  const out: Array<{ sessionId: string; path: string; cwd?: string }> = []
  const root = join(claudeDir(), 'projects')
  let projects: string[] = []
  try { projects = readdirSync(root) } catch { return out }
  for (const proj of projects) {
    const osb = join(root, proj, 'osb')
    let sessions: string[] = []
    try { sessions = readdirSync(osb) } catch { continue }
    for (const sid of sessions) {
      const path = join(osb, sid, LOOPS_FILE)
      if (!existsSync(path)) continue
      const cwd = readLoopRecordsAt(path).find((r) => r.kind === 'session' && typeof r.cwd === 'string')?.cwd
      out.push({ sessionId: sid, path, ...(cwd ? { cwd } : {}) })
    }
  }
  return out
}

// ── Recap (tier b): at most RECAP_MAX lines, each item once ─────────────────

/**
 * Filed-but-not-recapped items across this project's sessions, newest first, at most
 * RECAP_MAX. Appends `recapped` for the ones returned, so each is recapped once.
 */
export function takeLoopsRecap(workingDir: string, max = RECAP_MAX): Array<{ text: string; url: string }> {
  try {
    const osbRoot = dirname(dirname(getLoopsPath('_', workingDir)))
    let sessions: string[] = []
    try { sessions = readdirSync(osbRoot) } catch { return [] }
    const found: Array<{ sessionId: string; item: LoopItem }> = []
    for (const sid of sessions) {
      const path = join(osbRoot, sid, LOOPS_FILE)
      if (!existsSync(path)) continue
      for (const item of foldLoops(readLoopRecordsAt(path)).values()) {
        if (item.filedUrl && !item.recapped) found.push({ sessionId: sid, item })
      }
    }
    found.sort((a, b) => (b.item.filedAt ?? '').localeCompare(a.item.filedAt ?? ''))
    const picked = found.slice(0, max)
    for (const p of picked) appendLoopRecord(p.sessionId, workingDir, { kind: 'recapped', id: p.item.id })
    return picked.map((p) => ({ text: p.item.text, url: p.item.filedUrl! }))
  } catch {
    return []
  }
}
