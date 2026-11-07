// Outputs model (build plan L4; UI review items 13, 17-21). Pure functions only:
// no React, no DOM, no fetch, so `npx tsx tests/outputs-model.test.ts` covers it.
// The Outputs drawer, the in-chat file card and the expanded Files view all read
// files through this module so the surfaces cannot drift apart again.

/** Coordinator decision (2026-11-07): an agent write does NOT pop the Outputs
 *  drawer open. It raises an unread badge instead, cleared when the user opens
 *  Outputs. Flip to true to restore auto-open. */
export const AUTO_OPEN_OUTPUTS_ON_WRITE = false

/** The agent caps the resume-time `session_artifacts` push at this many entries
 *  (agent/src/index.ts, data-channel size limit). A list of exactly this length
 *  is treated as partial, so a re-list never drops files it simply did not send. */
export const ARTIFACT_LIST_CAP = 120

/** Structural shape of a file row. `GeneratedFile` (voice/shared.ts) satisfies it. */
export interface OutputFile {
  filePath: string
  fileName: string
  type: string
  source?: string
  updatedAt: Date | string | number
  /** When this browser first saw the agent write the file (set by file events). */
  createdAt?: Date | string | number
  /** Session whose workspace holds the file (set when listed or written). */
  sessionId?: string
  content?: string
  url?: string
  isImage?: boolean
  mimeType?: string
  truncated?: boolean
  originalSize?: number
  /** The agent could not read the file (replaces the old literal "Empty file"). */
  loadError?: string
}

export type DayBucket = 'today' | 'yesterday' | 'thisWeek' | 'older'

export interface OutputGroups<T extends OutputFile = OutputFile> {
  justMade: T[]
  pinned: T[]
  today: T[]
  yesterday: T[]
  thisWeek: T[]
  older: T[]
}

export function toMs(d: Date | string | number | undefined | null): number {
  if (d == null) return NaN
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime()
  return Number.isFinite(ms) ? ms : NaN
}

export function fileExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'])
const TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'html', 'htm', 'svg', 'json', 'csv', 'log', 'yaml', 'yml', 'ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'css', 'sql', 'mmd', 'mermaid', 'xml', 'toml'])

/** Raster image by extension. SVG is handled separately (it is text markup). */
export function isImageName(name: string): boolean {
  return IMAGE_EXTS.has(fileExt(name))
}

export function isTextName(name: string): boolean {
  return TEXT_EXTS.has(fileExt(name))
}

/** Newest first; ties broken by name, then path, so the order never jitters. */
export function compareOutputs(a: OutputFile, b: OutputFile): number {
  const ta = toMs(a.updatedAt)
  const tb = toMs(b.updatedAt)
  const va = Number.isFinite(ta) ? ta : -Infinity
  const vb = Number.isFinite(tb) ? tb : -Infinity
  if (va !== vb) return vb - va
  if (a.fileName !== b.fileName) return a.fileName < b.fileName ? -1 : 1
  if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1
  return 0
}

export function sortOutputs<T extends OutputFile>(files: readonly T[]): T[] {
  return [...files].sort(compareOutputs)
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Calendar-day bucket relative to `now` (local time). */
export function dayBucket(ms: number, now: number): DayBucket {
  if (!Number.isFinite(ms)) return 'older'
  const today = startOfDay(now)
  if (ms >= today) return 'today'
  const yesterday = startOfDay(today - 1)
  if (ms >= yesterday) return 'yesterday'
  const weekStart = startOfDay(today - 6 * 86_400_000)
  if (ms >= weekStart) return 'thisWeek'
  return 'older'
}

export interface JustMadeContext {
  sessionId: string | null | undefined
  /** When this browser joined the session (ms). */
  joinedAt: number
}

/** Just made = written in the CURRENT session after the user joined. Files that
 *  arrive by re-list (e.g. written by Bash, so no write event) have no createdAt;
 *  their mtime stands in. */
export function isJustMade(f: OutputFile, ctx: JustMadeContext): boolean {
  if (!ctx.sessionId || f.sessionId !== ctx.sessionId) return false
  const created = toMs(f.createdAt ?? f.updatedAt)
  return Number.isFinite(created) && created >= ctx.joinedAt
}

export interface GroupContext extends JustMadeContext {
  now: number
  pinnedPaths: ReadonlySet<string>
}

/** Each file lands in exactly one group: pinned > just made > day bucket. */
export function groupOutputs<T extends OutputFile>(files: readonly T[], ctx: GroupContext): OutputGroups<T> {
  const g: OutputGroups<T> = { justMade: [], pinned: [], today: [], yesterday: [], thisWeek: [], older: [] }
  for (const f of sortOutputs(files)) {
    if (ctx.pinnedPaths.has(f.filePath)) g.pinned.push(f)
    else if (isJustMade(f, ctx)) g.justMade.push(f)
    else g[dayBucket(toMs(f.updatedAt), ctx.now)].push(f)
  }
  return g
}

/** UI#21: the star is shown only on rows the user pinned. */
export function showStar(f: OutputFile, pinnedPaths: ReadonlySet<string>): boolean {
  return pinnedPaths.has(f.filePath)
}

/** "New" until the user has looked at Outputs since the file was written. */
export function isNew(f: OutputFile, seenAt: number): boolean {
  const t = toMs(f.updatedAt)
  return Number.isFinite(t) && t > seenAt
}

export function countNew(files: readonly OutputFile[], seenAt: number): number {
  let n = 0
  for (const f of files) if (isNew(f, seenAt)) n++
  return n
}

function hasSearchableText(f: OutputFile): f is OutputFile & { content: string } {
  if (typeof f.content !== 'string' || f.content.length === 0) return false
  if (f.isImage || isImageName(f.fileName)) return false
  return true
}

function clipAround(line: string, idx: number, qLen: number, max = 120): string {
  const lead = line.length - line.trimStart().length
  const s = line.trim()
  if (s.length <= max) return s
  const at = Math.max(0, idx - lead)
  const start = Math.max(0, Math.min(at - Math.floor((max - qLen) / 2), s.length - max))
  const body = s.slice(start, start + max)
  return `${start > 0 ? '…' : ''}${body}${start + max < s.length ? '…' : ''}`
}

export interface SearchResult<T extends OutputFile = OutputFile> {
  byName: T[]
  byContent: Array<{ file: T; snippet: string }>
}

/** UI#19: instant match on name/path/type, plus a "Matches in contents" section
 *  over every file whose text is already loaded (no fetch storm). */
export function searchOutputs<T extends OutputFile>(files: readonly T[], query: string): SearchResult<T> {
  const q = query.trim().toLowerCase()
  const sorted = sortOutputs(files)
  if (!q) return { byName: sorted, byContent: [] }
  const byName: T[] = []
  const byContent: Array<{ file: T; snippet: string }> = []
  for (const f of sorted) {
    if (f.fileName.toLowerCase().includes(q) || f.filePath.toLowerCase().includes(q) || f.type.toLowerCase().includes(q)) {
      byName.push(f)
      continue
    }
    if (!hasSearchableText(f)) continue
    const lower = f.content.toLowerCase()
    const idx = lower.indexOf(q)
    if (idx < 0) continue
    const lineStart = f.content.lastIndexOf('\n', idx) + 1
    const lineEndRaw = f.content.indexOf('\n', idx)
    const line = f.content.slice(lineStart, lineEndRaw < 0 ? undefined : lineEndRaw)
    byContent.push({ file: f, snippet: clipAround(line, idx - lineStart, q.length) })
  }
  return { byName, byContent }
}

function clip(s: string, max = 100): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}

function decodeEntities(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

/** One-line summary for a row or card. Null when the text is not loaded. */
export function summarize(f: OutputFile): string | null {
  if (!hasSearchableText(f)) return null
  let text = f.content
  const ext = fileExt(f.fileName)
  if (f.type === 'html' || ext === 'html' || ext === 'htm' || ext === 'svg') {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)
    if (title && title[1].trim()) return clip(decodeEntities(title[1].replace(/\s+/g, ' ').trim()))
    text = text.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    const flat = decodeEntities(text).replace(/\s+/g, ' ').trim()
    return flat ? clip(flat) : null
  }
  const lines = text.split(/\r?\n/)
  let i = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === '---')
    if (end > 0) i = end + 1
  }
  let inFence = false
  for (; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (raw.startsWith('```') || raw.startsWith('~~~')) { inFence = !inFence; continue }
    if (inFence || !raw) continue
    const cleaned = raw
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned || /^[-=|:\s]+$/.test(cleaned)) continue
    return clip(cleaned)
  }
  return null
}

export interface ReplaceContext {
  sessionId: string | null | undefined
  pinnedPaths: ReadonlySet<string>
}

/** UI#13/19 root cause: the list used to be add-only. A full listing of the
 *  session workspace now REPLACES that folder's rows: vanished files go, changed
 *  files drop their cached body (fetched again lazily), unchanged ones keep it.
 *  Never dropped: pinned files, plan files, other sessions, bucket copies, and
 *  anything when the list may be partial (agent cap) or has no session id. */
export function replaceArtifacts<T extends OutputFile>(prev: readonly T[], incoming: readonly T[], ctx: ReplaceContext): T[] {
  const sid = ctx.sessionId || null
  const partial = !sid || incoming.length >= ARTIFACT_LIST_CAP
  const folder = sid ? `/osb/${sid}/` : null
  const prevByPath = new Map(prev.map((f) => [f.filePath, f] as const))
  const incomingPaths = new Set(incoming.map((f) => f.filePath))
  const out: T[] = []
  for (const f of prev) {
    if (incomingPaths.has(f.filePath)) continue // replaced below, in place of the old row
    const inFolder = !!folder && f.filePath.includes(folder)
    if (inFolder && !partial && !ctx.pinnedPaths.has(f.filePath)) continue // vanished from disk
    out.push(f)
  }
  for (const n of incoming) {
    const old = prevByPath.get(n.filePath)
    const merged = { ...(old || {}), ...n } as T
    if (sid) merged.sessionId = sid
    if (old) {
      if (old.createdAt !== undefined) merged.createdAt = old.createdAt
      const changed = toMs(old.updatedAt) !== toMs(n.updatedAt)
      if (changed) {
        merged.content = undefined
        merged.url = undefined
        merged.truncated = undefined
        merged.originalSize = undefined
        merged.loadError = undefined
      } else {
        merged.content = n.content ?? old.content
        merged.url = n.url ?? old.url
      }
    }
    out.push(merged)
  }
  return out
}

// ── Live agent writes (bugs 34808f72 / 59bb7e8d) ─────────────────────────────
// The agent's research_artifact_updated / plan_file_updated events only cover
// the session workspace and plans folder. A file it writes anywhere else (e.g.
// /workspace/report.txt) arrives only as a completed Write/Edit tool event, so
// that event is the source of truth for "Osborn just made this".

/** Tools whose completion means a file on disk was created or changed. */
export const AGENT_WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Agent bookkeeping that is never a user-facing output. */
const INTERNAL_PATH_RES: RegExp[] = [
  /\/\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/,
  /\/osb\/[^/]+\/(?:spec\.md|search-index\.txt|search-index-meta\.json)$/,
  /\/node_modules\//,
  /\/\.git\//,
]

export type OutputFileType = 'plan' | 'diagram' | 'notes' | 'image' | 'summary' | 'html' | 'other'

/** File type badge from the name (same rules as the artifact event handler). */
export function fileTypeOf(fileName: string): OutputFileType {
  const ext = fileExt(fileName)
  if (fileName.includes('plan')) return 'plan'
  if (ext === 'mmd' || ext === 'mermaid' || ext === 'svg') return 'diagram'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md') return 'notes'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (fileName.includes('summary')) return 'summary'
  return 'other'
}

export interface ToolFileEvent {
  tool?: unknown
  status?: unknown
  filePath?: unknown
  fileName?: unknown
}

/** An output row for a COMPLETED agent write, or null when the event is not one. */
export function fileFromToolEvent(
  ev: ToolFileEvent,
  ctx: { sessionId: string | null | undefined; now: number },
): (OutputFile & { type: OutputFileType; source: 'plan' | 'research'; createdAt: Date; updatedAt: Date }) | null {
  if (ev.status !== 'completed' || typeof ev.tool !== 'string' || !AGENT_WRITE_TOOLS.has(ev.tool)) return null
  if (typeof ev.filePath !== 'string' || !ev.filePath.startsWith('/')) return null
  const filePath = ev.filePath
  if (INTERNAL_PATH_RES.some((re) => re.test(filePath))) return null
  const fileName = (typeof ev.fileName === 'string' && ev.fileName) || filePath.split('/').pop() || filePath
  const at = new Date(ctx.now)
  const isPlan = filePath.includes('/.claude/plans/')
  return {
    filePath, fileName,
    type: isPlan ? 'plan' : fileTypeOf(fileName),
    source: isPlan ? 'plan' : 'research',
    updatedAt: at, createdAt: at,
    sessionId: ctx.sessionId || undefined,
    isImage: isImageName(fileName) || undefined,
  }
}

/** Insert a freshly written file (newest first) or refresh the existing row:
 *  first-seen time kept, cached body dropped so the next open refetches. */
export function upsertAgentFile<T extends OutputFile>(prev: readonly T[], file: T): T[] {
  const i = prev.findIndex((f) => f.filePath === file.filePath)
  if (i < 0) return [file, ...prev]
  const old = prev[i]
  const merged = {
    ...old, ...file,
    createdAt: old.createdAt ?? file.createdAt,
    sessionId: old.sessionId ?? file.sessionId,
    content: undefined, url: undefined, truncated: undefined, originalSize: undefined, loadError: undefined,
  } as T
  const next = [...prev]
  next[i] = merged
  return next
}

/** The ONE unread count: distinct agent-written paths not yet seen. Only agent
 *  file events feed it (never re-lists, favorites or bucket listings), so it
 *  moves by one per new file and cannot jump. Returns the same set when
 *  unchanged. Nothing is added while Outputs is on screen. */
export function markUnread(unread: ReadonlySet<string>, filePath: string, outputsVisible: boolean): ReadonlySet<string> {
  if (outputsVisible || unread.has(filePath)) return unread
  const next = new Set(unread)
  next.add(filePath)
  return next
}

/** loadError marker for a file the agent wrote outside the folders it serves. */
export const LOAD_ERROR_OUTSIDE = 'outside-workspace'
/** loadError marker when the agent did not answer a body request in time. */
export const LOAD_ERROR_NO_REPLY = 'no-reply'
/** How long a body request may stay unanswered before the view stops spinning. */
export const CONTENT_REPLY_TIMEOUT_MS = 15_000

// ── Legacy favorites without a durable copy (bug 55033541) ─────────────────
export type FavoriteCopyState = 'ok' | 'recovering' | 'repairable' | 'dead'

/** Where a pinned file stands: has a durable copy, is being fetched from the
 *  agent, came back whole (store a copy), or cannot be recovered. */
export function favoriteCopyState(f: OutputFile, pinned: boolean): FavoriteCopyState {
  if (!pinned || f.url) return 'ok'
  if (f.loadError) return 'dead'
  if (typeof f.content === 'string') {
    return f.content.length > 0 && !f.truncated ? 'repairable' : 'dead'
  }
  return 'recovering'
}

export type FavoriteRepair = { kind: 'set-url'; url: string } | { kind: 'upload' }

/** What to do for a favorite without a durable url, given the live row. */
export function favoriteRepairAction(fav: OutputFile, live: OutputFile | null | undefined): FavoriteRepair | null {
  if (fav.url || !live) return null
  if (live.url) return { kind: 'set-url', url: live.url }
  return favoriteCopyState(live, true) === 'repairable' ? { kind: 'upload' } : null
}

/** The message "Ask agent to regenerate" sends (an ordinary user request). */
export function regeneratePrompt(f: Pick<OutputFile, 'fileName' | 'filePath'>): string {
  return `Please regenerate ${f.fileName}. It is one of my favorites, but its saved copy is missing (it was at ${f.filePath}). Write it again and tell me where you saved it.`
}

/** Can the agent send this file's body? get_research_artifact serves only the
 *  session workspace (and legacy .osborn dirs); get_plan_file serves plans. */
export function agentCanServe(filePath: string, source?: string): boolean {
  if (source === 'plan') return filePath.includes('.claude/plans/')
  return filePath.includes('/osb/') || filePath.includes('.osborn/sessions/') || filePath.includes('.osborn/research/')
}

export type FavoriteSaveOutcome = 'ok' | 'local-only' | 'rollback'

/** UI#21: decide what a POST /api/favorites result means for the optimistic star.
 *  401 = guest (no account): favorites are device-local by design, keep them. */
export function favoriteSaveOutcome(status: number | null): FavoriteSaveOutcome {
  if (status != null && status >= 200 && status < 300) return 'ok'
  if (status === 401) return 'local-only'
  return 'rollback'
}

export type PreviewKind =
  | 'loading' | 'error' | 'image' | 'pdf' | 'html' | 'svg' | 'mermaid' | 'markdown'
  | 'empty' | 'unavailable' | 'link'

/** UI#20: what the preview pane should render. Images go by extension (the
 *  event's isImage flag can be wrong); an empty body is "empty", a truncated
 *  body with no bytes is "unavailable", never the literal text "Empty file". */
export function previewKind(f: OutputFile): PreviewKind {
  if (f.loadError) return 'error'
  const ext = fileExt(f.fileName)
  if (ext === 'svg') {
    if (typeof f.content === 'string' && f.content.length > 0) return 'svg'
    if (f.url) return 'image'
    if (typeof f.content === 'string') return f.truncated ? 'unavailable' : 'empty'
    return 'loading'
  }
  if (isImageName(f.fileName) || f.isImage) {
    if (f.url) return 'image'
    if (typeof f.content === 'string') return f.content.length > 0 ? 'image' : 'unavailable'
    return 'loading'
  }
  if (typeof f.content === 'string') {
    if (f.content.length === 0) return f.truncated ? 'unavailable' : 'empty'
    if (f.type === 'html' || ext === 'html' || ext === 'htm') return 'html'
    if (ext === 'mmd' || ext === 'mermaid') return 'mermaid'
    return 'markdown'
  }
  if (f.url) {
    if (ext === 'pdf') return 'pdf'
    return isTextName(f.fileName) || !ext ? 'loading' : 'link'
  }
  return 'loading'
}

const MIME_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml' }

export function imageSrc(f: OutputFile): string | null {
  if (f.url) return f.url
  if (typeof f.content === 'string' && f.content.length > 0) {
    const mime = f.mimeType && f.mimeType.startsWith('image/') && f.mimeType !== 'image/jpg' ? f.mimeType : (MIME_BY_EXT[fileExt(f.fileName)] || 'image/png')
    return `data:${mime};base64,${f.content}`
  }
  return null
}

/** Which project/session a file belongs to, from its path. */
export function projectOf(filePath: string): { project: string; session: string | null } {
  const ws = /\/\.claude\/projects\/([^/]+)\/osb\/([^/]+)\//.exec(filePath)
  if (ws) {
    const slug = ws[1].replace(/^-+/, '') || 'workspace'
    return { project: slug, session: ws[2].slice(0, 8) }
  }
  if (/\/\.claude\/plans\//.test(filePath)) return { project: 'Plans', session: null }
  const bucket = /^[^/]+\/([0-9a-f-]{8,})\/artifacts\//i.exec(filePath)
  if (bucket) return { project: 'Saved copies', session: bucket[1].slice(0, 8) }
  return { project: 'Other', session: null }
}

export interface ProjectGroup<T extends OutputFile = OutputFile> {
  project: string
  sessions: Array<{ session: string | null; files: T[] }>
}

/** "By project": project, then session inside it; both ordered by newest file. */
export function groupByProject<T extends OutputFile>(files: readonly T[]): ProjectGroup<T>[] {
  const projects = new Map<string, Map<string | null, T[]>>()
  for (const f of sortOutputs(files)) {
    const { project, session } = projectOf(f.filePath)
    if (!projects.has(project)) projects.set(project, new Map())
    const sessions = projects.get(project)!
    if (!sessions.has(session)) sessions.set(session, [])
    sessions.get(session)!.push(f)
  }
  // Map preserves insertion order and files were visited newest first, so the
  // first-seen project/session is the one with the newest file.
  return Array.from(projects.entries()).map(([project, sessions]) => ({
    project,
    sessions: Array.from(sessions.entries()).map(([session, list]) => ({ session, files: list })),
  }))
}

/** Compact relative time for a row: "now", "5m", "3h", "Yesterday", "4d", "Oct 18". */
export function fmtRelative(d: Date | string | number, now: number = Date.now()): string {
  const ms = toMs(d)
  if (!Number.isFinite(ms)) return ''
  const min = Math.floor((now - ms) / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const bucket = dayBucket(ms, now)
  if (bucket === 'yesterday') return 'Yesterday'
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000)
  if (days < 7) return `${days}d`
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: '2-digit' })
}

/** "Synced 12s ago" text for the Refresh row. */
export function fmtSynced(syncedAt: number | null, now: number = Date.now()): string {
  if (!syncedAt) return 'Not synced yet'
  const s = Math.max(0, Math.floor((now - syncedAt) / 1000))
  if (s < 5) return 'Synced just now'
  if (s < 60) return `Synced ${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `Synced ${m}m ago`
  return `Synced ${Math.floor(m / 60)}h ago`
}
