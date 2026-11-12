// ============================================================
// ROOMS ROW MODEL (#75) — pure, client-safe (no React, no Node imports)
// ============================================================
// One function turns what VoiceRoom already tracks (session list, background
// slots, the live session id) into the rows the Rooms sidebar / mobile bar
// render. Each row is recognisable at a glance: a clean title (agent title or
// the cleaned last user message — never a leaked wrapper), a relative
// last-activity time, the project and message count, and a single LIVE marker
// on the session the agent is actually running.

import { deriveSessionTitle, formatTime, sameSession, sessionActivityTime, sortSessionsByActivity, type SessionListFields } from './sessions'

export type RoomStatus = 'live' | 'background' | 'idle'

export interface RoomSessionInput extends SessionListFields {
  sessionId: string
  messageCount?: number
  cwd?: string
}

export interface RoomSlotInput {
  id: string
  isFocused: boolean
  hasSession: boolean
  workingDir?: string
  status?: 'ready' | 'pending' | 'error'
}

export interface RoomRow {
  /** sessionId (live/idle) or slot id (background). */
  id: string
  title: string
  status: RoomStatus
  /** True for exactly one row: the session the agent is running now. */
  isLive: boolean
  /** A switch to this row is pending (the live session is finishing its step). */
  switching: boolean
  /** Relative last-activity time ("3m ago"); '' when unknown. */
  time: string
  /** ISO last-activity time ('' when unknown) — for tooltips. */
  timeIso: string
  /** Last path segment of the session's project directory. */
  project?: string
  cwd?: string
  messageCount?: number
  /** 8-char id hint (only real disambiguator for identical titles). */
  shortId: string
}

export interface BuildRoomRowsOptions {
  /** Concurrently running background slots (agent `slots_list`). */
  slots?: RoomSlotInput[]
  /** Clock for relative times (defaults to now). */
  now?: number
  /** Title for a live session that is not in the list yet (e.g. first user message). */
  liveFallbackTitle?: string | null
  /** Max idle (resumable) rows. Default 12. */
  maxIdle?: number
  /** Session a deferred switch is waiting to open (session_switch_pending). */
  pendingId?: string | null
}

const short = (id: string) => (id ? id.substring(0, 8) : '')

function projectName(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const seg = cwd.replace(/\/+$/, '').split('/').filter(Boolean)
  return seg.length ? seg[seg.length - 1] : undefined
}

function sessionRow(
  s: RoomSessionInput,
  status: RoomStatus,
  now: number,
  id = s.sessionId,
): RoomRow {
  const timeIso = sessionActivityTime(s)
  const valid = timeIso && !Number.isNaN(new Date(timeIso).getTime())
  return {
    id,
    title: deriveSessionTitle(s),
    status,
    isLive: status === 'live',
    switching: false,
    time: valid ? formatTime(timeIso, now) : '',
    timeIso: valid ? timeIso : '',
    project: projectName(s.cwd),
    cwd: s.cwd,
    messageCount: typeof s.messageCount === 'number' ? s.messageCount : undefined,
    shortId: short(s.sessionId),
  }
}

/**
 * Compose the Rooms rows. Order: the live room, then background slots, then
 * recent resumable sessions (most recently active first, capped). A session
 * appears once. Exactly one row has `isLive` when `liveId` is set.
 */
export function buildRoomRows(
  sessions: RoomSessionInput[],
  liveId: string | null,
  opts: BuildRoomRowsOptions = {},
): RoomRow[] {
  const now = opts.now ?? Date.now()
  const slots = opts.slots ?? []
  const maxIdle = opts.maxIdle ?? 12
  const sorted = sortSessionsByActivity(sessions.filter((s) => s && s.sessionId))
  const rows: RoomRow[] = []
  const taken: string[] = []
  const isTaken = (id: string) => taken.some((t) => sameSession(t, id))

  // 1) Live — the session the agent is running right now.
  if (liveId) {
    const match = sorted.find((s) => sameSession(s.sessionId, liveId))
    const row = match
      ? sessionRow(match, 'live', now, liveId)
      : {
          id: liveId,
          title: opts.liveFallbackTitle ? deriveSessionTitle(opts.liveFallbackTitle) : 'Current session',
          status: 'live' as const,
          isLive: true,
          switching: false,
          time: 'Just now',
          timeIso: '',
          shortId: short(liveId),
        }
    rows.push(row)
    taken.push(liveId)
  }

  // 2) Background slots — truly concurrent sessions (never the live one).
  for (const slot of slots) {
    if (slot.isFocused || !slot.hasSession || !slot.id || isTaken(slot.id)) continue
    const match = sorted.find((s) => sameSession(s.sessionId, slot.id))
    const status: RoomStatus = slot.status === 'error' ? 'idle' : 'background'
    const row: RoomRow = match
      ? { ...sessionRow(match, status, now, slot.id), cwd: match.cwd ?? slot.workingDir, project: projectName(match.cwd ?? slot.workingDir) }
      : {
          id: slot.id,
          title: `Background session ${short(slot.id)}`,
          status,
          isLive: false,
          switching: false,
          time: '',
          timeIso: '',
          cwd: slot.workingDir,
          project: projectName(slot.workingDir),
          shortId: short(slot.id),
        }
    rows.push(row)
    taken.push(slot.id)
  }

  // 3) Recent resumable sessions.
  let idle = 0
  for (const s of sorted) {
    if (idle >= maxIdle) break
    if (isTaken(s.sessionId)) continue
    rows.push(sessionRow(s, 'idle', now, s.sessionId))
    taken.push(s.sessionId)
    idle++
  }

  const pendingId = opts.pendingId
  if (pendingId) {
    for (const r of rows) r.switching = !r.isLive && sameSession(r.id, pendingId)
  }
  return rows
}

// ============================================================
// ROW IDENTITY (#75 / #107) — pure, display-only helpers
// ============================================================
// The collapsed rail used to render every row as the same featureless dot, so
// rows carried no identity. These helpers turn a row into a recognisable token:
// a project-derived label, a single initial for the avatar, and a deterministic
// colour hashed from that label. All display-only — they never change the
// agent/server cwd semantics; they only decide what the UI shows.

/** The cwd leaf that means "the workspace root" (no distinguishing folder). */
const WORKSPACE_ROOT = 'workspace'

export interface RoomColor {
  /** Avatar fill. */
  bg: string
  /** Avatar foreground (the initial). */
  fg: string
}

type IdentityFields = { project?: string; title?: string }

/**
 * The identity label for a row: its project folder — EXCEPT a session rooted at
 * the workspace root (leaf "workspace", or no cwd at all) has no distinguishing
 * folder, so every such row would collapse to the same generic "Workspace".
 * For those we fall back to the session's own title so the rows stay distinct.
 * Display-only: this does not change where the session resolves on disk.
 */
export function roomIdentityLabel(row: IdentityFields): string {
  const project = (row.project ?? '').trim()
  if (project && project.toLowerCase() !== WORKSPACE_ROOT) return project
  const title = (row.title ?? '').trim()
  return title || project || ''
}

/** The single uppercase glyph for a row's avatar: the first letter/number of
 * its identity label, else '#'. Prefers an ASCII alphanumeric, then any
 * non-ASCII character (a letter in another script) so non-English projects
 * still get a sensible glyph; pure-punctuation labels fall back to '#'. */
export function roomInitial(row: IdentityFields): string {
  const label = roomIdentityLabel(row).trim()
  for (const ch of label) {
    if (!ch.trim()) continue // skip whitespace
    // Take the first ASCII alphanumeric or any non-ASCII character (a letter in
    // another script); skip ASCII punctuation (so "_beta" → "B", "***" → "#").
    if (/[a-z0-9]/i.test(ch) || ch.charCodeAt(0) > 127) return ch.toUpperCase()
  }
  return '#'
}

/**
 * Deterministic colour for an identity string (FNV-1a hash → hue). The same
 * project always maps to the same colour, so a folder's sessions share a hue
 * and different folders read as different colours; two workspace-root sessions
 * with different titles get different hues (they hash their fallback title).
 * Fixed saturation/lightness keep the initial legible on a dark rail.
 */
export function roomColor(seed: string): RoomColor {
  const key = (seed ?? '').trim().toLowerCase()
  let h = 2166136261 // FNV-1a offset basis
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const hue = (h >>> 0) % 360
  return {
    bg: `hsl(${hue} 52% 38%)`,
    fg: `hsl(${hue} 85% 92%)`,
  }
}

/** One call for the UI: a row's avatar initial and colour together. */
export function roomAvatar(row: IdentityFields): { initial: string; color: RoomColor } {
  return { initial: roomInitial(row), color: roomColor(roomIdentityLabel(row)) }
}

/**
 * Group rows under their project folder, most-recent folder first (rows are
 * already activity-ordered within each). Rows with no project fall into an
 * "Other" bucket shown last. Pure so the rail (#107 grouping) can be unit-
 * tested without React: given rows spanning N distinct project folders it
 * returns one group per folder, each holding exactly that folder's rows.
 */
export function groupRoomsByProject<T extends { project?: string }>(
  rows: T[],
): { project: string; rooms: T[] }[] {
  const map = new Map<string, T[]>()
  for (const r of rows) {
    const key = r.project || 'Other'
    const list = map.get(key)
    if (list) list.push(r)
    else map.set(key, [r])
  }
  return Array.from(map.entries())
    .map(([project, list]) => ({ project, rooms: list }))
    .sort((a, b) => {
      if (a.project === 'Other') return 1
      if (b.project === 'Other') return -1
      return 0 // preserve insertion order (already activity-sorted)
    })
}
