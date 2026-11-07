'use client'

import { BarVisualizer } from '@livekit/components-react'

// Modern status indicator
// ── The Voice Orb — the interface IS the state (2026-08 "Warm Oracle") ──
// One living orb whose color + motion carry the voice state peripherally:
// idle = dim slow breathing · listening = amber amplitude pulse · thinking =
// violet shimmer · speaking = sage rhythmic ripple. Label is quiet serif —
// the orb does the talking. Same props/name as the old pill (call sites
// untouched).
export function StatusIndicator({ state, isMuted, micBlocked }: { state: string; isMuted: boolean; micBlocked?: boolean }) {
  const config: Record<string, { color: string; anim: string; label: string }> = {
    listening: { color: 'var(--voice-listening)', anim: 'orbPulse 1.6s ease-in-out infinite', label: 'Listening' },
    thinking:  { color: 'var(--voice-thinking)',  anim: 'orbShimmer 2.4s linear infinite',    label: 'Thinking' },
    speaking:  { color: 'var(--voice-speaking)',  anim: 'orbRipple 1.1s ease-out infinite',   label: 'Speaking' },
    idle:      { color: 'var(--voice-idle)',      anim: 'orbBreathe 3.5s ease-in-out infinite', label: 'Ready' },
  }
  // Truthfulness: when the mic is confirmed off (not merely muted) the orb must
  // NOT keep claiming "Listening" — show "Mic off" instead, so a stranger isn't
  // told the agent is hearing them when it cannot.
  const micOff = micBlocked && state === 'listening'
  const { color, anim, label } = micOff
    ? { color: 'var(--voice-error)', anim: 'orbBreathe 3.5s ease-in-out infinite', label: 'Mic off' }
    : (config[state] || config.idle)

  return (
    <div className="flex items-center gap-2 sm:gap-2.5 pl-1 pr-2 py-1 select-none shrink-0">
      {/* The orb */}
      <div className="relative w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center">
        {/* Halo */}
        <div
          className="absolute inset-[-6px] rounded-full blur-md transition-colors duration-500"
          style={{ background: `radial-gradient(circle, ${color}44 0%, transparent 70%)` }}
        />
        {/* Core */}
        <div
          className="relative w-full h-full rounded-full transition-colors duration-500"
          style={{
            background: `radial-gradient(circle at 32% 30%, ${color} 0%, color-mix(in srgb, ${color} 55%, #0c0b09) 100%)`,
            animation: anim,
          }}
        />
      </div>
      <span className="font-display italic text-[13px] sm:text-sm text-[var(--text-secondary)] transition-colors duration-500 tracking-tight"
        style={{ color: state !== 'idle' ? color : undefined }}>
        {label}
      </span>
      {isMuted && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border border-[var(--voice-error)]/40 text-[var(--voice-error)]">muted</span>
      )}
    </div>
  )
}

// Voice visualizer with modern design
export type AgentState = 'disconnected' | 'connecting' | 'initializing' | 'listening' | 'thinking' | 'speaking'

export function VoiceVisualizer({ state, audioTrack }: { state: string; audioTrack: any }) {
  // Map state to valid AgentState for BarVisualizer
  const visualizerState: AgentState = ['listening', 'thinking', 'speaking'].includes(state)
    ? (state as AgentState)
    : 'disconnected'

  return (
    <>
      {/* Desktop: full visualizer */}
      <div className="relative hidden sm:block">
        <div className={`absolute inset-0 rounded-2xl blur-xl transition-opacity duration-300 ${
          state === 'speaking' ? 'bg-amber-500/30 opacity-100' :
          state === 'listening' ? 'bg-green-500/20 opacity-100' : 'opacity-0'
        }`} />
        <div className="relative h-16 w-32 bg-gray-800/50 rounded-2xl border border-gray-700/50 flex items-center justify-center overflow-hidden backdrop-blur-sm">
          <BarVisualizer
            state={visualizerState}
            trackRef={audioTrack}
            barCount={7}
            options={{ minHeight: 4 }}
          />
        </div>
      </div>
      {/* Mobile: compact mini visualizer */}
      <div className="relative sm:hidden">
        <div className="relative h-8 w-16 bg-gray-800/50 rounded-xl border border-gray-700/50 flex items-center justify-center overflow-hidden">
          <BarVisualizer
            state={visualizerState}
            trackRef={audioTrack}
            barCount={4}
            options={{ minHeight: 2 }}
          />
        </div>
      </div>
    </>
  )
}
