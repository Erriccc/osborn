'use client'

/**
 * The in-call controls in one small floating pill (ChatPanel `corner`): side by
 * side at the bottom-right on phones and tablets, where voice apps put them and
 * the text keeps its full width; End above Mic at the top-right on desktop.
 */
export function CallPill({ muted, onToggleMute, onEnd }: {
  muted: boolean
  onToggleMute: () => void
  onEnd?: () => void
}) {
  return (
    <div role="group" aria-label="Call controls"
      className="flex flex-row lg:flex-col items-center gap-1 p-1 rounded-full bg-gray-800/90 border border-gray-700/60 shadow-lg backdrop-blur-sm">
      {onEnd && (
        <button onClick={onEnd} aria-label="End call" title="Hang up (the session stays resumable)"
          className="w-11 min-h-11 py-1.5 flex flex-col items-center justify-center gap-0.5 rounded-full bg-red-500/90 text-white hover:bg-red-500 transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
          </svg>
          <span className="text-[10px] font-semibold leading-none">End</span>
        </button>
      )}
      <button onClick={onToggleMute} aria-label={muted ? 'Unmute mic' : 'Mute mic'} aria-pressed={muted} title={muted ? 'Unmute' : 'Mute'}
        className={`w-11 min-h-11 py-1.5 flex flex-col items-center justify-center gap-0.5 rounded-full transition-colors ${muted ? 'bg-red-500/20 text-red-400' : 'text-gray-200 hover:bg-gray-700/70'}`}>
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          {muted
            ? <><path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" d="M17 14l4-4m0 4l-4-4" /></>
            : <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />}
        </svg>
        <span className="text-[10px] font-medium leading-none">{muted ? 'Muted' : 'Mic'}</span>
      </button>
    </div>
  )
}
