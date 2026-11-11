// ============================================================
// ROOMS ROW MODEL (#75) — pure, client-safe (no React, no Node imports)
// ============================================================
// One function turns what VoiceRoom already tracks (session list, background
// slots, the live session id) into the rows the Rooms sidebar / mobile bar
// render. Each row is recognisable at a glance: a clean title (agent title or
// the cleaned last user message — never a leaked wrapper), a relative
// last-activity time, the project and message count, and a single LIVE marker
// on the session the agent is actually running.

import { deriveSessionTitle, formatTime, sessionActivityTime, sortSessionsByActivity, type SessionListFields } from './sessions'

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
  /** Sibling forks collapsed under this row (#107); 0/undefined when none. */
  forkCount?: number
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
  /** sessionId → collapsed fork count, from prepareSessions (#107). */
  forkCountById?: Map<string, number>
}

const short = (id: string) => (id ? id.substring(0, 8) : '')

/** A slot id may be the full sessionId OR an 8-char prefix. */
function sameSession(a: string, b: string): boolean {
  if (!a || !b) return false
  return a === b || (a.length === 8 && b.startsWith(a)) || (b.length === 8 && a.startsWith(b))
}

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
  forks?: Map<string, number>,
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
    forkCount: forks?.get(s.sessionId) || undefined,
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
  const forks = opts.forkCountById
  const sorted = sortSessionsByActivity(sessions.filter((s) => s && s.sessionId))
  const rows: RoomRow[] = []
  const taken: string[] = []
  const isTaken = (id: string) => taken.some((t) => sameSession(t, id))

  // 1) Live — the session the agent is running right now.
  if (liveId) {
    const match = sorted.find((s) => sameSession(s.sessionId, liveId))
    const row = match
      ? sessionRow(match, 'live', now, liveId, forks)
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
      ? { ...sessionRow(match, status, now, slot.id, forks), cwd: match.cwd ?? slot.workingDir, project: projectName(match.cwd ?? slot.workingDir) }
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
    rows.push(sessionRow(s, 'idle', now, s.sessionId, forks))
    taken.push(s.sessionId)
    idle++
  }

  const pendingId = opts.pendingId
  if (pendingId) {
    for (const r of rows) r.switching = !r.isLive && sameSession(r.id, pendingId)
  }
  return rows
}
