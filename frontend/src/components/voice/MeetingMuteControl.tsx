'use client'

import React from 'react'

/**
 * Compact meeting mute control (Phase B surface).
 *
 * Reflects the agent's addressing/mute state — pushed over the existing
 * 'osborn-updates' data channel as `meeting_state` / `mute_changed` — and lets
 * the controlling user mute/unmute a meeting participant by sending a
 * `mute_participant` control message back. Additive and self-contained so it
 * can drop into the existing meeting panel without touching its layout.
 *
 * Renders nothing unless the agent reports addressing is enabled (the
 * OSBORN_MEETING_ADDRESSING flag), so an un-flagged meeting shows no new UI.
 */
export interface MeetingMuteState {
  enabled: boolean
  /** Addressable agent ids (orchestrator + workers), for the "addressed" chip. */
  roster: string[]
  /** Known meeting participant names (mute candidates). */
  speakers: string[]
  /** Muted participant names (lowercased); '*' means everyone is muted. */
  muted: string[]
  /** The agent most recently addressed (@researcher …), or null. */
  addressed: string | null
}

export function MeetingMuteControl({
  state,
  onMute,
}: {
  state: MeetingMuteState | null
  onMute: (action: 'mute' | 'unmute', who: string) => void
}) {
  if (!state || !state.enabled) return null

  const muteAll = state.muted.includes('*')
  const isMuted = (name: string) => muteAll || state.muted.includes(name.trim().toLowerCase())
  const addressedWorker = state.addressed && state.addressed.toLowerCase() !== 'osborn' ? state.addressed : null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-blue-300/70 font-medium">Mics</span>

      {state.speakers.length === 0 ? (
        <span className="text-gray-500 italic">no participants yet</span>
      ) : (
        state.speakers.map((name) => {
          const muted = isMuted(name)
          return (
            <button
              key={name}
              type="button"
              onClick={() => onMute(muted ? 'unmute' : 'mute', name)}
              title={muted ? `Unmute ${name}` : `Mute ${name}`}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 border transition-colors ${
                muted
                  ? 'bg-red-500/15 border-red-500/40 text-red-300 line-through decoration-red-400/60'
                  : 'bg-blue-500/10 border-blue-500/30 text-blue-200 hover:bg-blue-500/20'
              }`}
            >
              <span aria-hidden="true">{muted ? '🔇' : '🎙️'}</span>
              <span className="not-italic no-underline">{name}</span>
            </button>
          )
        })
      )}

      {addressedWorker && (
        <span className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-indigo-500/15 border border-indigo-500/40 text-indigo-200">
          <span aria-hidden="true">🎯</span>
          @{addressedWorker}
        </span>
      )}
    </div>
  )
}
