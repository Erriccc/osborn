'use client'

// ── Rooms (§14 first real cut) ────────────────────────────────────────────
// Multiple concurrent sessions ("rooms") the user can switch between inside
// one view, WITHOUT breaking the single-session voice flow:
//
//   • The live voice connection stays single-session (one LiveKitRoom, one
//     controlling tab — see ChatSessionProvider). We do NOT open a second
//     WebRTC connection per room; that would burn connection minutes and fight
//     the tab lock.
//   • Switching to another room sends the existing `resume_session` message on
//     the SAME live channel, so the agent swaps which Claude session it is
//     focused on and replays that session's durable state. Each room keeps its
//     own state because sessions are persisted agent-side (JSONL) — switching
//     away and back is lossless.
//   • Background "slots" (InstancesPanel) are the genuinely-concurrent rooms:
//     they keep running on the agent while another room is in the foreground.
//
// This rail is pure surface over data VoiceRoom already has (sessions, slots,
// currentSessionId) + handlers it already owns (resume, spawn/list). It is
// additive: VoiceRoom renders <RoomsSidebar/> (desktop) and <RoomsBar/>
// (mobile) and nothing else changes.

import { useEffect, useState } from 'react'
import { deriveSessionTitle, sortSessionsByActivity } from '@/lib/sessions'
import type { SessionInfo, SlotInfo } from './shared'

export type RoomStatus = 'live' | 'background' | 'idle'

export interface Room {
  /** sessionId (idle/live) or slot id (background). */
  id: string
  title: string
  status: RoomStatus
  cwd?: string
  /** 8-char short id shown as a monospace hint. */
  shortId: string
}

/** A slot id may be the full sessionId OR an 8-char prefix. Match both. */
function slotMatches(slotId: string, sessionId: string): boolean {
  return slotId === sessionId || slotId === sessionId.substring(0, 8) || sessionId.startsWith(slotId)
}

/**
 * Compose the switchable room list from the three sources VoiceRoom tracks.
 * Order: the live/foreground room first, then concurrently-running background
 * slots, then recent resumable sessions. Deduped so a session that is also a
 * running slot appears once (as the slot).
 */
export function buildRooms(
  sessions: SessionInfo[],
  slots: SlotInfo[],
  currentSessionId: string | null,
): Room[] {
  const rooms: Room[] = []
  const seen = new Set<string>()
  const short = (id: string) => (id ? id.substring(0, 8) : '')

  // 1) Live / foreground — the session the agent is focused on right now.
  if (currentSessionId) {
    const match = sessions.find((s) => s.sessionId === currentSessionId)
    rooms.push({
      id: currentSessionId,
      title: match ? deriveSessionTitle(match) : 'Current session',
      status: 'live',
      cwd: match?.cwd,
      shortId: short(currentSessionId),
    })
    seen.add(currentSessionId)
    seen.add(short(currentSessionId))
  }

  // 2) Background slots — truly concurrent agent sessions. Skip the focused
  //    slot (that is the live room) and anything already listed.
  for (const slot of slots) {
    if (slot.isFocused || !slot.hasSession) continue
    if (seen.has(slot.id) || (currentSessionId && slotMatches(slot.id, currentSessionId))) continue
    rooms.push({
      id: slot.id,
      title: `Background · ${slot.id.substring(0, 6)}`,
      status: slot.status === 'error' ? 'idle' : 'background',
      cwd: slot.workingDir,
      shortId: short(slot.id),
    })
    seen.add(slot.id)
    seen.add(short(slot.id))
  }

  // 3) Recent sessions — resumable into the foreground. Exclude the live room
  //    and any session already running as a background slot.
  const runningSlotIds = new Set(slots.map((s) => s.id))
  for (const s of sortSessionsByActivity(sessions)) {
    if (seen.has(s.sessionId) || seen.has(short(s.sessionId))) continue
    if (runningSlotIds.has(s.sessionId) || runningSlotIds.has(short(s.sessionId))) continue
    rooms.push({
      id: s.sessionId,
      title: deriveSessionTitle(s),
      status: 'idle',
      cwd: s.cwd,
      shortId: short(s.sessionId),
    })
    seen.add(s.sessionId)
    seen.add(short(s.sessionId))
    if (rooms.filter((r) => r.status === 'idle').length >= 12) break
  }

  return rooms
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
}

const COLLAPSE_KEY = 'vn-rooms-collapsed'

// ── Desktop: persistent left sidebar (Phase D) ────────────────────────────
export function RoomsSidebar({
  sessions,
  slots,
  currentSessionId,
  onSwitchRoom,
  onNewRoom,
  onRefresh,
  disabled,
}: RoomsProps) {
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1')
    } catch { /* storage blocked */ }
  }, [])
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  const rooms = buildRooms(sessions, slots, currentSessionId)
  const backgroundCount = rooms.filter((r) => r.status === 'background').length

  if (collapsed) {
    return (
      <aside
        aria-label="Rooms"
        className="hidden sm:flex w-12 shrink-0 flex-col items-center gap-2 py-2 bg-gray-900 rounded-xl border border-gray-800/50"
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
      className="hidden sm:flex w-60 shrink-0 flex-col bg-gray-900 rounded-xl border border-gray-800/50 overflow-hidden"
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

      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-0.5">
        {rooms.length === 0 ? (
          <p className="text-[11px] text-gray-500 text-center py-6 px-2 leading-relaxed">
            No other sessions yet. Start one with “New room”.
          </p>
        ) : (
          rooms.map((room) => {
            const isLive = room.status === 'live'
            return (
              <button
                key={room.id}
                onClick={() => !isLive && !disabled && onSwitchRoom(room)}
                disabled={isLive || disabled}
                title={isLive ? 'This room is live' : `Switch to ${room.title}`}
                className={`w-full text-left px-2.5 py-2 rounded-lg border transition-colors ${
                  isLive
                    ? 'bg-amber-500/10 border-amber-500/30 cursor-default'
                    : 'border-transparent hover:bg-gray-800/60 disabled:opacity-50 disabled:cursor-not-allowed'
                }`}
              >
                <div className="flex items-center gap-2">
                  <StatusDot status={room.status} />
                  <span className="flex-1 min-w-0 text-[12.5px] text-gray-200 truncate">{room.title}</span>
                  <span
                    className={`shrink-0 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                      room.status === 'live'
                        ? 'bg-amber-500/20 text-amber-300'
                        : room.status === 'background'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-gray-800 text-gray-500'
                    }`}
                  >
                    {STATUS_LABEL[room.status]}
                  </span>
                </div>
                <div className="font-mono text-[10px] text-gray-500 truncate pl-4 mt-0.5">{room.shortId}</div>
              </button>
            )
          })
        )}
      </div>

      <div className="p-2 border-t border-gray-800/60 shrink-0">
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

// ── Mobile: slim horizontal room switcher (shown only with 2+ rooms) ──────
export function RoomsBar({
  sessions,
  slots,
  currentSessionId,
  onSwitchRoom,
  onNewRoom,
  disabled,
}: RoomsProps) {
  const rooms = buildRooms(sessions, slots, currentSessionId)
  // Keep the voice screen clean (3-6-9): no rail until there is somewhere to
  // switch to. nav/switchers don't count toward the primary-action budget.
  if (rooms.length <= 1) return null
  return (
    <div className="sm:hidden flex items-center gap-1.5 px-3 py-1.5 overflow-x-auto border-b border-gray-800/50 bg-gray-900/40">
      {rooms.map((room) => {
        const isLive = room.status === 'live'
        return (
          <button
            key={room.id}
            onClick={() => !isLive && !disabled && onSwitchRoom(room)}
            disabled={isLive || disabled}
            title={room.title}
            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap border transition-colors ${
              isLive
                ? 'bg-amber-500/15 text-amber-200 border-amber-500/30'
                : 'bg-gray-800/50 text-gray-300 border-gray-700/50 hover:bg-gray-800 disabled:opacity-50'
            }`}
          >
            <StatusDot status={room.status} />
            <span className="max-w-[9rem] truncate">{room.title}</span>
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
