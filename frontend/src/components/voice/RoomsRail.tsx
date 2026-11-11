'use client'

// ── Rooms (§14 first real cut) ────────────────────────────────────────────
// Multiple concurrent sessions ("rooms") the user can switch between inside
// one view, WITHOUT breaking the single-session voice flow:
//
//   • The live voice connection stays single-session (one LiveKitRoom, one
//     controlling tab — see ChatSessionProvider). We do NOT open a second
//     WebRTC connection per room; that would burn connection minutes and fight
//     the tab lock.
//   • Switching to another room sends `switch_session` (with the room's cwd)
//     on the SAME live channel. The agent switches in place: if the current
//     session is busy it finishes the current step first
//     (`session_switch_pending`, Switch now / Cancel), then resumes the target
//     and replays its durable state (`session_switched`). Each room keeps its
//     own state because sessions are persisted agent-side (JSONL) — switching
//     away and back is lossless.
//   • Background "slots" (InstancesPanel) are the genuinely-concurrent rooms:
//     they keep running on the agent while another room is in the foreground.
//
// This rail is pure surface over data VoiceRoom already has (sessions, slots,
// currentSessionId) + handlers it already owns (resume, spawn/list). It is
// additive: VoiceRoom renders <RoomsSidebar/> (the vertical rail, desktop xl+
// only) and <RoomsBar/> (the slim horizontal switcher, below xl — phone AND
// tablet, so the conversation keeps full width instead of a three-column
// squeeze, issue #118) and nothing else changes.

import { useEffect, useMemo, useState } from 'react'
import { buildRoomRows, type RoomRow, type RoomStatus } from '@/lib/rooms'
import { prepareSessions } from '@/lib/session-list'
import type { SessionInfo, SlotInfo } from './shared'

export type { RoomStatus }
export type Room = RoomRow

/**
 * Compose the switchable room list from the three sources VoiceRoom tracks.
 * Thin wrapper over the pure row model (lib/rooms.ts, #75): live room first,
 * then background slots, then recent resumable sessions; one LIVE row.
 */
export function buildRooms(
  sessions: SessionInfo[],
  slots: SlotInfo[],
  currentSessionId: string | null,
  liveFallbackTitle?: string | null,
  pendingId?: string | null,
  opts?: { forkCountById?: Map<string, number>; maxIdle?: number },
): Room[] {
  return buildRoomRows(sessions, currentSessionId, {
    slots,
    liveFallbackTitle,
    pendingId,
    forkCountById: opts?.forkCountById,
    maxIdle: opts?.maxIdle,
  })
}

/** "2 forks" / "1 fork" label for a collapsed fork family (#107). */
function forkLabel(n: number | undefined): string {
  return n && n > 0 ? `${n} fork${n === 1 ? '' : 's'}` : ''
}

/** Group recent (idle) rows under their project, most-recent project first,
 * rows already activity-ordered within each (#107). Rows with no project fall
 * into an "Other" bucket shown last. */
function groupRoomsByProject(rooms: Room[]): { project: string; rooms: Room[] }[] {
  const map = new Map<string, Room[]>()
  for (const r of rooms) {
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

/** Secondary line: "3m ago · osborn · 12 msgs · 2 forks" (falls back to id). */
function roomMeta(room: Room): string {
  const parts = [
    room.time,
    room.project,
    typeof room.messageCount === 'number' && room.messageCount > 0
      ? `${room.messageCount} msg${room.messageCount === 1 ? '' : 's'}`
      : '',
    forkLabel(room.forkCount),
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : room.shortId
}

function StatusDot({ status }: { status: RoomStatus }) {
  const cls =
    status === 'live'
      ? 'bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.7)]'
      : status === 'background'
        ? 'bg-emerald-400'
        : 'bg-gray-600'
  return <span className={`w-2 h-2 rounded-full shrink-0 ${cls}`} aria-hidden="true" />
}

const STATUS_LABEL: Record<RoomStatus, string> = {
  live: 'Live',
  background: 'Running',
  idle: 'Resume',
}

/** One room row in the expanded sidebar (shared by the pinned top section and
 * the per-project recent groups). */
function RoomRowButton({
  room,
  disabled,
  onSwitchRoom,
}: {
  room: Room
  disabled?: boolean
  onSwitchRoom: (room: Room) => void
}) {
  const isLive = room.status === 'live'
  return (
    <button
      onClick={() => !isLive && !disabled && onSwitchRoom(room)}
      disabled={isLive || disabled}
      title={`${isLive ? 'Live now' : `Switch to ${room.title}`}${room.timeIso ? ` · last active ${new Date(room.timeIso).toLocaleString()}` : ''} · ${room.id}`}
      aria-current={isLive ? 'true' : undefined}
      className={`w-full text-left px-2.5 py-2 rounded-lg border transition-colors ${
        isLive
          ? 'bg-amber-500/10 border-amber-500/30 cursor-default'
          : 'border-transparent hover:bg-gray-800/60 disabled:opacity-50 disabled:cursor-not-allowed'
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={room.status} />
        <span className="flex-1 min-w-0 text-[12.5px] text-gray-200 truncate">{room.title}</span>
        {forkLabel(room.forkCount) && (
          <span className="shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300" title={`${forkLabel(room.forkCount)} collapsed under this session`}>
            {forkLabel(room.forkCount)}
          </span>
        )}
        <span
          className={`shrink-0 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
            room.status === 'live'
              ? 'bg-amber-500/20 text-amber-300'
              : room.status === 'background'
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-gray-800 text-gray-500'
          }`}
        >
          {room.switching ? 'Switching…' : STATUS_LABEL[room.status]}
        </span>
      </div>
      <div className="text-[10px] text-gray-500 truncate pl-4 mt-0.5">{roomMeta(room)}</div>
    </button>
  )
}

interface RoomsProps {
  sessions: SessionInfo[]
  slots: SlotInfo[]
  currentSessionId: string | null
  /** Resume a room into the foreground (non-live rooms only). */
  onSwitchRoom: (room: Room) => void
  /** Start a brand-new room. */
  onNewRoom: () => void
  /** Reload the sessions + slots that feed the rail. */
  onRefresh: () => void
  disabled?: boolean
  /** Title for the live session before it shows up in the session list. */
  liveTitle?: string | null
  /** Session a deferred switch is waiting to open (shows "Switching…"). */
  pendingId?: string | null
}

const COLLAPSE_KEY = 'vn-rooms-collapsed'
const SHOW_SYSTEM_KEY = 'vn-rooms-show-system'

// ── Desktop (xl+): persistent left sidebar (Phase D) ──────────────────────
export function RoomsSidebar({
  sessions,
  slots,
  currentSessionId,
  onSwitchRoom,
  onNewRoom,
  onRefresh,
  disabled,
  liveTitle,
  pendingId,
}: RoomsProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1')
      setShowSystem(localStorage.getItem(SHOW_SYSTEM_KEY) === '1')
    } catch { /* storage blocked */ }
  }, [])
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }
  const toggleShowSystem = () => {
    setShowSystem((v) => {
      const next = !v
      try { localStorage.setItem(SHOW_SYSTEM_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  // #107: dedupe copies + collapse forks + hide system sessions + search, then
  // build the switchable rows. Search raises the recent cap so a match isn't
  // hidden below the fold.
  const prepared = useMemo(
    () => prepareSessions(sessions, { search: query, hideSystem: !showSystem }),
    [sessions, query, showSystem],
  )
  const rooms = buildRooms(prepared.sessions, slots, currentSessionId, liveTitle, pendingId, {
    forkCountById: prepared.forkCountById,
    maxIdle: query.trim() ? 100 : 12,
  })
  const backgroundCount = rooms.filter((r) => r.status === 'background').length
  // Live + Running stay pinned at the top; Recent (idle) rows group by project.
  const topRooms = rooms.filter((r) => r.status !== 'idle')
  const idleRooms = rooms.filter((r) => r.status === 'idle')
  const idleByProject = useMemo(() => groupRoomsByProject(idleRooms), [idleRooms])

  if (collapsed) {
    return (
      <aside
        aria-label="Rooms"
        className="hidden xl:flex w-12 shrink-0 flex-col items-center gap-2 py-2 bg-gray-900 rounded-xl border border-gray-800/50"
      >
        <button
          onClick={toggleCollapsed}
          aria-label="Expand rooms sidebar"
          title="Expand rooms"
          className="p-2 rounded-lg text-gray-400 hover:text-gray-100 hover:bg-gray-800/60 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <div className="flex-1 w-full overflow-y-auto flex flex-col items-center gap-1.5 py-1">
          {rooms.slice(0, 10).map((room) => (
            <button
              key={room.id}
              onClick={() => room.status !== 'live' && !disabled && onSwitchRoom(room)}
              title={`${room.title} · ${STATUS_LABEL[room.status]}`}
              aria-label={`${room.title} (${STATUS_LABEL[room.status]})`}
              className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center transition-colors ${
                room.status === 'live' ? 'bg-amber-500/15 ring-1 ring-amber-500/40' : 'hover:bg-gray-800/60'
              }`}
            >
              <StatusDot status={room.status} />
            </button>
          ))}
        </div>
        <button
          onClick={onNewRoom}
          aria-label="New room"
          title="New room"
          className="p-2 rounded-lg text-amber-300 hover:bg-amber-500/15 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </aside>
    )
  }

  return (
    <aside
      aria-label="Rooms"
      className="hidden xl:flex w-60 shrink-0 flex-col bg-gray-900 rounded-xl border border-gray-800/50 overflow-hidden"
    >
      <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-gray-800/60 shrink-0">
        <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5 text-amber-400/90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <rect x="3" y="4" width="8" height="7" rx="1.5" /><rect x="13" y="4" width="8" height="7" rx="1.5" /><rect x="3" y="13" width="8" height="7" rx="1.5" /><rect x="13" y="13" width="8" height="7" rx="1.5" />
          </svg>
          Rooms
        </span>
        {backgroundCount > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 text-[10px] font-semibold">
            {backgroundCount} live
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={onRefresh}
            aria-label="Refresh rooms"
            title="Refresh"
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M5 9a7 7 0 0112-3.5L20 9M19 15a7 7 0 01-12 3.5L4 15" />
            </svg>
          </button>
          <button
            onClick={toggleCollapsed}
            aria-label="Collapse rooms sidebar"
            title="Collapse"
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search (#107) — filter by title / preview / project. */}
      <div className="px-2 py-2 border-b border-gray-800/60 shrink-0">
        <div className="relative">
          <svg className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="w-full pl-7 pr-7 py-1.5 rounded-lg bg-gray-800/60 border border-gray-800 text-[12px] text-gray-200 placeholder-gray-500 outline-none focus:border-amber-500/40"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-500 hover:text-gray-200"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-0.5">
        {rooms.length === 0 ? (
          <p className="text-[11px] text-gray-500 text-center py-6 px-2 leading-relaxed">
            {query.trim()
              ? 'No sessions match your search.'
              : 'No other sessions yet. Start one with “New room”.'}
          </p>
        ) : (
          <>
            {/* Live + Running — pinned above the grouped recents. */}
            {topRooms.map((room) => (
              <RoomRowButton key={room.id} room={room} disabled={disabled} onSwitchRoom={onSwitchRoom} />
            ))}
            {/* Recent — grouped by project. */}
            {idleByProject.map(({ project, rooms: group }) => (
              <div key={project} className="pt-1.5">
                <div className="px-2 pb-0.5 text-[9px] font-semibold uppercase tracking-wider text-gray-600 truncate">
                  {project}
                </div>
                {group.map((room) => (
                  <RoomRowButton key={room.id} room={room} disabled={disabled} onSwitchRoom={onSwitchRoom} />
                ))}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="p-2 border-t border-gray-800/60 shrink-0 space-y-1.5">
        {/* Show system sessions toggle (#107) — off by default. */}
        {(prepared.systemCount > 0 || showSystem) && (
          <button
            onClick={toggleShowSystem}
            aria-pressed={showSystem}
            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-[11px] font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 transition-colors"
          >
            <span>Show system sessions{prepared.systemCount > 0 ? ` (${prepared.systemCount})` : ''}</span>
            <span className={`shrink-0 w-7 h-4 rounded-full relative transition-colors ${showSystem ? 'bg-amber-500/60' : 'bg-gray-700'}`}>
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-gray-100 transition-all ${showSystem ? 'left-3.5' : 'left-0.5'}`} />
            </span>
          </button>
        )}
        <button
          onClick={onNewRoom}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 hover:border-amber-500/50 transition-all"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New room
        </button>
      </div>
    </aside>
  )
}

// ── Below xl (phone + tablet): slim horizontal room switcher (2+ rooms) ────
export function RoomsBar({
  sessions,
  slots,
  currentSessionId,
  onSwitchRoom,
  onNewRoom,
  disabled,
  liveTitle,
  pendingId,
}: RoomsProps) {
  // #107: dedupe copies + collapse forks + hide system sessions so the slim
  // mobile switcher shows one chip per real session (no "three identical rows").
  const prepared = useMemo(() => prepareSessions(sessions, { hideSystem: true }), [sessions])
  const rooms = buildRooms(prepared.sessions, slots, currentSessionId, liveTitle, pendingId, {
    forkCountById: prepared.forkCountById,
  })
  // Keep the voice screen clean (3-6-9): no rail until there is somewhere to
  // switch to. nav/switchers don't count toward the primary-action budget.
  if (rooms.length <= 1) return null
  return (
    <div className="xl:hidden flex items-center gap-1.5 px-3 py-1.5 overflow-x-auto border-b border-gray-800/50 bg-gray-900/40">
      {rooms.map((room) => {
        const isLive = room.status === 'live'
        return (
          <button
            key={room.id}
            onClick={() => !isLive && !disabled && onSwitchRoom(room)}
            disabled={isLive || disabled}
            title={`${room.title}${room.time ? ` · ${room.time}` : ''}`}
            aria-current={isLive ? 'true' : undefined}
            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap border transition-colors ${
              isLive
                ? 'bg-amber-500/15 text-amber-200 border-amber-500/30'
                : 'bg-gray-800/50 text-gray-300 border-gray-700/50 hover:bg-gray-800 disabled:opacity-50'
            }`}
          >
            <StatusDot status={room.status} />
            <span className="max-w-[9rem] truncate">{room.title}</span>
            {isLive ? (
              <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-300">Live</span>
            ) : room.time ? (
              <span className="text-[10px] text-gray-500">{room.time}</span>
            ) : null}
          </button>
        )
      })}
      <button
        onClick={onNewRoom}
        aria-label="New room"
        title="New room"
        className="shrink-0 flex items-center justify-center min-h-8 min-w-8 w-8 h-8 rounded-full bg-gray-800/50 text-amber-300 border border-gray-700/50 hover:bg-amber-500/15 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      </button>
    </div>
  )
}
