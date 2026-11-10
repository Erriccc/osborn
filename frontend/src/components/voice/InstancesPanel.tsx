'use client'

import { useState } from 'react'
import { formatTime, deriveSessionTitle, sessionActivityTime, sortSessionsByActivity } from '@/lib/sessions'
import { useViewportClamp, type SessionInfo, type SlotInfo } from './shared'

// Compact live-instances panel + spawn control
export function InstancesPanel({
  slots,
  sessions,
  currentSessionId,
  spawnPending,
  spawnError,
  onSpawn,
  onDispatch,
  onStopInstance,
  onClose,
}: {
  slots: SlotInfo[]
  sessions: SessionInfo[]
  currentSessionId: string | null
  spawnPending: boolean
  spawnError: string | null
  onSpawn: (sessionId?: string, workingDir?: string) => void
  onDispatch: (targetSessionId: string, instruction: string) => void
  onStopInstance: (sessionId: string) => void
  onClose: () => void
}) {
  // Mounted only while open — clamp it into the viewport when the header wraps.
  const panelRef = useViewportClamp(true)
  // Build a synthetic "focused" card from the existing session if the agent's
  // slots_list doesn't include a focused slot (older agent build or no slots yet).
  const hasFocused = slots.some((s) => s.isFocused)
  const displaySlots: SlotInfo[] = hasFocused
    ? slots
    : [
        {
          id: currentSessionId ? currentSessionId.substring(0, 8) : 'focused',
          isFocused: true,
          hasSession: !!currentSessionId,
          status: 'ready',
        },
        ...slots,
      ]

  // Per-slot instruction drafts for tag-&-continue dispatch. Keyed by slot id so
  // each background row keeps its own input text.
  const [dispatchDrafts, setDispatchDrafts] = useState<Record<string, string>>({})
  const submitDispatch = (slotId: string) => {
    const text = (dispatchDrafts[slotId] ?? '').trim()
    if (!text) return
    onDispatch(slotId, text)
    setDispatchDrafts((prev) => ({ ...prev, [slotId]: '' }))
  }

  // Sessions eligible to spawn as a background slot: not the currently-focused session, and
  // not one already running as a slot. Slot ids may be the full sessionId or an 8-char prefix,
  // so match both. Cap is 2 background slots (focused is separate).
  const runningSlotIds = new Set(slots.map((s) => s.id))
  const eligibleSessions = sortSessionsByActivity(sessions).filter((s) =>
    s.sessionId !== currentSessionId &&
    !runningSlotIds.has(s.sessionId) &&
    !runningSlotIds.has(s.sessionId.substring(0, 8))
  )
  const atSpawnCap = slots.filter((s) => !s.isFocused).length >= 2

  return (
    <>
      {/* Mobile backdrop — tap outside the sheet to close (sheet only). */}
      <div className="sm:hidden fixed inset-0 z-[95] bg-black/50" onClick={onClose} aria-hidden="true" />
      {/* Mobile: slide-up bottom-sheet above the dock. Desktop: anchored dropdown
          under the header button (unchanged). */}
      <div ref={panelRef} className="fixed inset-x-0 bottom-0 z-[100] max-h-[80vh] overflow-y-auto rounded-t-2xl pb-[env(safe-area-inset-bottom)] bg-gray-900 border border-gray-700/60 shadow-2xl
        sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-12 sm:right-0 sm:w-72 sm:max-w-[calc(100vw-1rem)] sm:max-h-none sm:rounded-xl sm:pb-0 sm:overflow-hidden">
      {/* Mobile grab handle */}
      <div className="sm:hidden w-10 h-1 rounded-full bg-gray-700 mx-auto mt-2 mb-1" aria-hidden="true" />
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <span className="text-xs font-semibold text-gray-300">Background agents</span>
        <button
          onClick={onClose}
          className="p-0.5 rounded text-gray-500 hover:text-gray-200 transition-colors"
          aria-label="Close instances panel"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Slot list */}
      <div className="p-2 space-y-1.5 max-h-48 overflow-y-auto">
        {displaySlots.map((slot) => (
          <div
            key={slot.id}
            className={`px-2.5 py-2 rounded-lg border text-xs ${
              slot.isFocused
                ? 'bg-amber-500/10 border-amber-500/30'
                : slot.status === 'error'
                  ? 'bg-red-500/10 border-red-500/30'
                  : 'bg-gray-800/50 border-gray-700/40'
            }`}
          >
            <div className="flex items-center gap-2.5">
              {/* Live/ready dot */}
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  slot.status === 'error'
                    ? 'bg-red-400'
                    : slot.hasSession
                      ? slot.isFocused
                        ? 'bg-amber-400'
                        : 'bg-emerald-400'
                      : 'bg-gray-500'
                }`}
              />
              {/* Slot info */}
              <div className="flex-1 min-w-0">
                <div className="font-mono text-gray-200 truncate">{slot.id}</div>
                {slot.error && (
                  <div className="text-red-400 truncate mt-0.5">{slot.error}</div>
                )}
              </div>
              {/* Role badge */}
              <span
                className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  slot.isFocused
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'bg-gray-700 text-gray-400'
                }`}
              >
                {slot.isFocused ? 'focused' : 'background'}
              </span>
              {/* Close/stop — background slots only (never the focused voice session). */}
              {!slot.isFocused && (
                <button
                  onClick={() => onStopInstance(slot.id)}
                  title="Stop this instance"
                  aria-label="Stop this instance"
                  className="shrink-0 p-0.5 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            {/* Tag & continue: dispatch an instruction to this background session.
                Only shown for non-focused slots that have a live session. */}
            {!slot.isFocused && slot.hasSession && slot.status !== 'error' && (
              <div className="flex items-center gap-1.5 mt-2">
                <input
                  type="text"
                  value={dispatchDrafts[slot.id] ?? ''}
                  onChange={(e) => setDispatchDrafts((prev) => ({ ...prev, [slot.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitDispatch(slot.id) } }}
                  placeholder="Send a task…"
                  className="flex-1 min-w-0 bg-gray-900/70 border border-gray-700/60 rounded px-2 py-1 text-[11px] text-gray-200 placeholder-gray-500 focus:outline-none focus:border-sky-500/50"
                />
                <button
                  onClick={() => submitDispatch(slot.id)}
                  disabled={!(dispatchDrafts[slot.id] ?? '').trim()}
                  className="shrink-0 px-2 py-1 rounded text-[11px] font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30 hover:bg-sky-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Dispatch
                </button>
              </div>
            )}
          </div>
        ))}

        {displaySlots.length === 0 && (
          <p className="text-xs text-gray-500 text-center py-2">No instances found</p>
        )}
      </div>

      {/* Spawn control */}
      <div className="px-2 pb-2 pt-1 border-t border-gray-800">
        {spawnError && (
          <p className="text-[11px] text-red-400 mb-1.5 px-1 leading-snug">{spawnError}</p>
        )}
        {atSpawnCap ? (
          <p className="text-[11px] text-gray-500 px-1 py-1.5 text-center leading-snug">
            Max background instances running (2).
          </p>
        ) : (
          <>
            {/* Session picker — spawn a specific session by title (no IDs to remember) */}
            {eligibleSessions.length > 0 && (
              <div className="mb-1.5">
                <p className="text-[10px] uppercase tracking-wide text-gray-500 px-1 mb-1">Start one from a past session</p>
                <div className="max-h-40 overflow-y-auto space-y-0.5 pr-0.5">
                  {eligibleSessions.slice(0, 20).map((s) => (
                    <button
                      key={s.sessionId}
                      onClick={() => onSpawn(s.sessionId, s.cwd)}
                      disabled={spawnPending}
                      title={deriveSessionTitle(s)}
                      className="w-full text-left px-2 py-1.5 rounded-md hover:bg-gray-800/70 disabled:opacity-50 disabled:cursor-not-allowed transition-colors group"
                    >
                      <div className="text-[11px] text-gray-200 truncate group-hover:text-white">{deriveSessionTitle(s)}</div>
                      <div className="text-[10px] text-gray-500">{formatTime(sessionActivityTime(s))}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Auto-pick fallback: spawn the most-recent non-focused session */}
            <button
              onClick={() => onSpawn()}
              disabled={spawnPending}
              className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium transition-all ${
                spawnPending
                  ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                  : 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 hover:border-amber-500/50'
              }`}
            >
              {spawnPending ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Spawning...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  {eligibleSessions.length > 0 ? 'Start from the latest' : 'Start another agent'}
                </>
              )}
            </button>
          </>
        )}
      </div>
      </div>
    </>
  )
}
