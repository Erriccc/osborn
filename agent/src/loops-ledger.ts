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
import { clip } from './content/lens-ingest.js'
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
/** A work row that was never delivered is dropped after this long, so a stuck row cannot linger. */
export const WORK_TTL_MS = 6 * 60 * 60 * 1000
/** Surfaced at most this often per row and this many times, then it waits for the recap. */
const WORK_SURFACE_MAX = 2
export const WORK_SURFACE_GAP_MS = 2 * 60 * 1000
/** A result must be this old before it is surfaced: the turn that received it gets to report it first. */
const WORK_SETTLE_MS = 10 * 1000
/** A result is only surfaced while it is this fresh (the TTL above only drops rows). */
export const WORK_SURFACE_WINDOW_MS = 20 * 60 * 1000
/** At most one surfaced notice per this gap, and this many per hour. */
export const WORK_NOTICE_GAP_MS = 5 * 60 * 1000
export const WORK_NOTICE_PER_HOUR = 3
/** OSBORN_WORK_LEDGER=on|1|true turns delegation tracking on; default off (foreground session only, see `recordWork`). */
export const workLedgerEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => /^(on|1|true)$/i.test(String(env.OSBORN_WORK_LEDGER ?? '').trim())

export type LoopOrigin = 'user_mic' | 'meeting' | 'phone' | 'tool' | 'system'
export type LoopSource = 'explicit' | 'inferred'

export type LoopKind =
  | 'session' | 'prompt' | 'ask' | 'point' | 'point_addressed'
  | 'todo' | 'todo_status' | 'task' | 'task_status'
  | 'dispatch_started' | 'dispatch_stopped' | 'dispatch_severed'
  | 'steward_block' | 'steward_clear'
  | 'question' | 'question_answered'
  | 'permission_pending' | 'permission_settled'
  | 'slot_refused' | 'budget_denied' | 'open_loop' | 'queued' | 'started'
  | 'filed' | 'recapped' | 'held'
  | 'work_opened' | 'work_result' | 'work_surfaced' | 'work_delivered' | 'work_dropped'

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
  by?: 'user' | 'abort' | WorkDelivery
  url?: string
  cwd?: string
  /** `queued`: the instruction itself, kept to start it later (`text` is a short title). */
  instruction?: string
  /** `held`: the repo that held the item back (public or unknown visibility). */
  repo?: string
  truncated?: boolean
  /** `work_*`: who holds the work ('main', 'local:<role>', 'local:<project>'), its role, how it was sent. */
  owner?: string
  role?: string
  via?: WorkVia
  /** `work_result`: what came back, short, secrets redacted. */
  result?: string
  /** `work_dropped`: why it was closed without delivery. */
  reason?: string
}

export type WorkVia = 'task' | 'dispatch'
export type WorkDelivery = 'spoken' | 'shown' | 'phone' | 'seen'
export type WorkState = 'opened' | 'result_ready' | 'delivered' | 'dropped'

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
  /** `work_*` rows only: derived by the fold. */
  state?: WorkState
  owner?: string
  role?: string
  via?: WorkVia
  result?: string
  resultAt?: string
  surfaced?: number
  lastSurfacedAt?: string
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
  // A point of a long turn (#455), its own kind so a build without it skips it; closed when the reply covered it.
  point: () => true,
  point_addressed: () => false,
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
  // The queued item was sent (the hub's dispatch matched it): closed, so it is neither offered nor filed.
  started: () => false,
  // Delegated work (work ledger): open until its result is delivered or it is dropped, never by the run merely stopping.
  work_opened: () => true,
  work_result: () => true,
  work_surfaced: () => true,
  work_delivered: () => false,
  work_dropped: () => false,
}

const WORK_STATE: Partial<Record<LoopKind, WorkState>> = {
  work_opened: 'opened', work_result: 'result_ready', work_delivered: 'delivered', work_dropped: 'dropped',
}
/** Old builds ignore these kinds (no OPENS entry), so a mixed fleet shares one ledger safely. */
const isWorkKind =(k: string): boolean => k.startsWith('work_')
const WORK_END: WorkState[] = ['delivered', 'dropped']

function applyWork(item: LoopItem, r: LoopRecord): void {
  const st = WORK_STATE[r.kind]
  if (st) item.state = st
  if (r.owner) item.owner = r.owner
  if (r.role) item.role = r.role
  if (r.via) item.via = r.via
  if (r.kind === 'work_result') { item.result = r.result ?? r.text; item.resultAt = r.at }
  if (r.kind === 'work_surfaced') { item.surfaced = (item.surfaced ?? 0) + 1; item.lastSurfacedAt = r.at }
}

/** Fold the ledger: the last record per item id wins. `prompt` and `session` lines are never items. */
export function foldLoops(records: LoopRecord[]): Map<string, LoopItem> {
  const items = new Map<string, LoopItem>()
  for (const r of records) {
    if (!r || !r.id) continue
    if (r.kind === 'filed') {
      const it = items.get(r.id)
      if (it) { it.filedUrl = r.url; it.filedAt = r.at; it.recapped = false }
      continue
    }
    if (r.kind === 'recapped') {
      const it = items.get(r.id)
      if (it) it.recapped = true
      continue
    }
    const opens = Object.hasOwn(OPENS, r.kind) ? OPENS[r.kind] : undefined
    if (!opens) continue
    const prev = items.get(r.id)
    // A finished row stays finished: a duplicate or late record (a SubagentStop that fires twice) never reopens it.
    if (prev?.state && WORK_END.includes(prev.state) && isWorkKind(r.kind)) continue
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
    if (isWorkKind(r.kind)) applyWork(item, r)
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
  // A point inferred from a long turn stays local until a read-back exists (#461).
  // Delegated work is tracked for delivery here, never filed.
  return openLoops(records).filter((i) => i.fg && i.kind !== 'point' && !isWorkKind(i.kind))
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
  point: (text: string) => `point:${loopKey('point', text)}`,
  todo: (content: string) => `todo:${loopKey('todo', content)}`,
  task: (taskId: string) => `task:${taskId}`,
  dispatch: (agentId: string) => `dispatch:${agentId}`,
  /** `work:<agentId>` for a sub-agent, `work:dispatch:<project>:<hash>` for a spoke. */
  work: (key: string) => `work:${key}`,
  question: (toolUseId: string) => `question:${toolUseId}`,
  permission: (requestId: string) => `perm:${requestId}`,
  slot: (text: string) => `slot:${loopKey('slot', text)}`,
  budget: (turn: number, at: string) => `budget:${turn}:${at}`,
  openLoop: (text: string) => `open_loop:${loopKey('open_loop', text)}`,
  queued: (project: string, instruction: string) => `queued:${loopKey('queued', `${project} ${instruction}`)}`,
  steward: () => 'steward',
}

// Keeps the record, title included, under MAX_LINE_BYTES (one O_APPEND write) for most text.
const MAX_QUEUED_INSTRUCTION = 800

/**
 * The record for an instruction refused at slot capacity. `text` is a short title; `instruction` keeps enough
 * to start it later. The hub model wrote the instruction, so it is inferred; only text the user typed
 * themselves (`typed`) is explicit.
 */
export function queuedLoopRecord(instruction: string, project: string, opts: { typed?: boolean } = {}): LoopRecordInput {
  const full = clip(String(instruction || '').replace(/\s+/g, ' ').trim(), MAX_QUEUED_INSTRUCTION)
  const typed = opts.typed === true
  return {
    kind: 'queued', id: loopIds.queued(project, full), text: clip(`Queued for ${project}: ${full}`, MAX_ITEM_CHARS), instruction: full,
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

/**
 * The hub sent `instruction` to `project` (folder `cwd`): close a matching open queued item in any of that
 * project's ledgers with `started` (same id as queuedLoopRecord). Returns whether one matched.
 */
export function markQueuedStarted(cwd: string, project: string, instruction: string): boolean {
  const id = queuedLoopRecord(instruction, project).id!
  let hit = false
  for (const l of ledgersIn(projectOsbDir(cwd))) {
    if (foldLoops(readLoopRecordsAt(l.path)).get(id)?.open && appendLoopRecord(l.sessionId, cwd, { kind: 'started', id })) hit = true
  }
  return hit
}

/** Work rows whose result exists but was never delivered, oldest first, bounded: what to surface at the next idle moment. */
export function pendingDeliveries(records: LoopRecord[], now: number, opts: { max?: number; ttlMs?: number; sinceMs?: number } = {}): LoopItem[] {
  const ttl = opts.ttlMs ?? WORK_TTL_MS
  return [...foldLoops(records).values()]
    .filter((i) => i.fg && i.open && i.state === 'result_ready' && !!i.result && !!i.resultAt)
    .filter((i) => {
      const age = now - Date.parse(i.resultAt!)
      if (!(age >= WORK_SETTLE_MS) || age > Math.min(ttl, WORK_SURFACE_WINDOW_MS)) return false
      if (opts.sinceMs !== undefined && Date.parse(i.resultAt!) < opts.sinceMs) return false
      if ((i.surfaced ?? 0) >= WORK_SURFACE_MAX) return false
      return !i.lastSurfacedAt || now - Date.parse(i.lastSurfacedAt) >= WORK_SURFACE_GAP_MS
    })
    .sort((a, b) => a.resultAt!.localeCompare(b.resultAt!))
    .slice(0, opts.max ?? 1)
}

/** True while a new notice would break the global limit: one per 5 minutes, three per hour, counted from `work_surfaced` records. */
export function noticeThrottled(records: LoopRecord[], now: number): boolean {
  const at = records.filter((r) => r.kind === 'work_surfaced').map((r) => Date.parse(r.at)).filter((t) => t <= now)
  if (at.some((t) => now - t < WORK_NOTICE_GAP_MS)) return true
  return at.filter((t) => now - t < 3_600_000).length >= WORK_NOTICE_PER_HOUR
}

/** Ids of open work rows past the TTL (from the result, else from opening), to close with `work_dropped`. */
export function expiredWork(records: LoopRecord[], now: number, ttlMs = WORK_TTL_MS): string[] {
  return [...foldLoops(records).values()]
    .filter((i) => i.open && !!i.state && now - Date.parse(i.resultAt ?? i.at) > ttlMs)
    .map((i) => i.id)
}

// ── IO ──────────────────────────────────────────────────────────────────────

const projectOsbDir = (cwd: string): string => dirname(dirname(getLoopsPath('_', cwd)))

/** The session ledgers that exist under one project's `osb` folder. */
function ledgersIn(osbDir: string): Array<{ sessionId: string; path: string }> {
  let sessions: string[] = []
  try { sessions = readdirSync(osbDir) } catch { return [] }
  return sessions.map((sessionId) => ({ sessionId, path: join(osbDir, sessionId, LOOPS_FILE) })).filter((l) => existsSync(l.path))
}

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
    for (const { sessionId, path } of ledgersIn(join(root, proj, 'osb'))) {
      const cwd = readLoopRecordsAt(path).find((r) => r.kind === 'session' && typeof r.cwd === 'string')?.cwd
      out.push({ sessionId, path, ...(cwd ? { cwd } : {}) })
    }
  }
  return out
}

// ── Recap (tier b): at most RECAP_MAX lines, each item once ─────────────────

/** Unfiled open items come back in this order: refused-at-capacity work, unanswered questions, the rest, then inferred points. */
const UNFILED_RANK: Partial<Record<LoopKind, number>> = { queued: 0, question: 1, point: 3, work_opened: 3, work_result: 3, work_surfaced: 3 }

/** `filed` marks an item the ledger says was filed; `url` is set only when it points into this project's own repo. */
export interface RecapItem { text: string; url?: string; filed?: true }

/**
 * Not-yet-recapped foreground items across this project's sessions, at most `max` in all: filed ones first (newest
 * first), then the still-open unfiled ones (queued, questions, other loops; newest first within a rank).
 * `skipSession` is the live session: what it just recorded is not "earlier". Appends `recapped` for each
 * item returned, so each is recapped once. Ledger text is untrusted: the caller quotes it as data.
 */
export function takeLoopsRecap(workingDir: string, max = RECAP_MAX, skipSession?: string): RecapItem[] {
  try {
    const filed: Array<{ sessionId: string; item: LoopItem }> = []
    const unfiled: Array<{ sessionId: string; item: LoopItem }> = []
    for (const { sessionId, path } of ledgersIn(projectOsbDir(workingDir))) {
      const folded = foldLoops(readLoopRecordsAt(path))
      for (const item of folded.values()) {
        // One line per delegation: an open dispatch:<id> row ("Unfinished … run", "cut off") already says its work:<id>.
        if (item.id.startsWith('work:') && folded.get(loopIds.dispatch(item.id.slice(5)))?.open) continue
        // Foreground items only, as for filing: a background slot keeps its ledger local.
        if (item.recapped || !item.fg) continue
        if (!item.text) continue
        // Filing happens after a session ends, so the live session still hears of its own filed items.
        if (item.filedUrl) filed.push({ sessionId, item })
        else if (item.open && sessionId !== skipSession) unfiled.push({ sessionId, item })
      }
    }
    filed.sort((a, b) => (b.item.filedAt ?? '').localeCompare(a.item.filedAt ?? ''))
    const rank = (k: LoopKind) => UNFILED_RANK[k] ?? 2
    unfiled.sort((a, b) => rank(a.item.kind) - rank(b.item.kind) || b.item.at.localeCompare(a.item.at))
    const picked = [...filed, ...unfiled].slice(0, max)
    for (const p of picked) appendLoopRecord(p.sessionId, workingDir, { kind: 'recapped', id: p.item.id })
    const repo = picked.some((p) => p.item.filedUrl) ? repoFromCwd(workingDir)?.toLowerCase() : undefined
    const own = (u: string) => !!repo && new RegExp(`^https://github\\.com/${repo.replace(/[.]/g, '\\.')}/issues/\\d+$`, 'i').test(u)
    return picked.map((p) => p.item.filedUrl
      ? { text: p.item.text, filed: true as const, ...(own(p.item.filedUrl) ? { url: p.item.filedUrl } : {}) }
      : { text: p.item.text })
  } catch {
    return []
  }
}
