'use client'

import { useEffect, useRef } from 'react'
import { BarVisualizer } from '@livekit/components-react'
import { levelToHeight, onGotIt, onMicLevel } from '@/lib/mic-level'
import { resolveOrbState } from '@/lib/orb-state'

// Modern status indicator
// ── The Voice Orb — the interface IS the state (2026-08 "Warm Oracle") ──
// One living orb whose color + motion carry the voice state peripherally:
// idle = dim slow breathing · listening = amber amplitude pulse · thinking =
// violet shimmer · speaking = sage rhythmic ripple. Label is quiet serif —
// the orb does the talking. Same props/name as the old pill (call sites
// untouched).
export function StatusIndicator({ state, isMuted, micBlocked, blocked, reconnecting, error, bargeIn }: {
  state: string
  isMuted: boolean
  /** Mic confirmed off (not merely muted) while the agent is listening. */
  micBlocked?: boolean
  /** Mic permission denied / no device / busy. Not passed by VoiceRoom yet (L6b). */
  blocked?: boolean
  /** Room transport reconnecting. Not passed by VoiceRoom yet (L6b). */
  reconnecting?: boolean
  /** Error known outside agent_state. Not passed by VoiceRoom yet (L6b). */
  error?: boolean
  /** Browser barge-in duck engaged on the user's voice. */
  bargeIn?: boolean
}) {
  // Truthfulness lives in resolveOrbState: never "Listening" when the mic is
  // off/muted/blocked, and agent_state 'error' shows "Error", not "Ready".
  const view = resolveOrbState({
    agentState: state,
    micOff: micBlocked,
    muted: isMuted,
    blocked,
    reconnecting,
    error,
    bargeIn,
  })
  const { colorVar: color, anim, label } = view

  return (
    <div className="flex items-center gap-2 sm:gap-2.5 pl-1 pr-2 py-1 select-none shrink-0">
      {/* The orb */}
      <div className="relative w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center">
        {/* Halo */}
        <div
          className="absolute inset-[-6px] rounded-full blur-md transition-colors duration-500"
          style={{ background: `radial-gradient(circle, color-mix(in srgb, ${color} 27%, transparent) 0%, transparent 70%)` }}
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
        style={{ color: view.key !== 'idle' ? color : undefined }}>
        {label}
      </span>
      {view.mutedBadge && view.key !== 'muted' && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border border-voice-error/40 text-[var(--voice-error)]">muted</span>
      )}
      {view.blockedBadge && view.key !== 'blocked' && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border border-voice-error/40 text-[var(--voice-error)]">mic blocked</span>
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

// Your own mic level plus a short "got it" tick when a transcript lands. Modelled on the
// level bar of a phone-call / voice-message recorder: a few thin bars beside the status,
// driven by the analyser VoiceRoom already runs (no second animation loop, no re-render).
const STRIP_BARS = 5
const BAR_WEIGHTS = [0.55, 0.8, 1, 0.8, 0.55]
export function MicLevelStrip() {
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  const tick = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    const calm = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let timer: ReturnType<typeof setTimeout> | undefined
    const offLevel = onMicLevel((v) => {
      const h = levelToHeight(v)
      bars.current.forEach((el, i) => {
        if (!el) return
        const s = Math.max(0.18, h * BAR_WEIGHTS[i])
        el.style.transform = `scaleY(${calm ? (h > 0.12 ? 0.8 : 0.18) : s.toFixed(2)})`
        el.style.opacity = h > 0.05 ? '1' : '0.45'
      })
    })
    const offGot = onGotIt(() => {
      const el = tick.current
      if (!el) return
      el.style.opacity = '1'
      clearTimeout(timer)
      timer = setTimeout(() => { el.style.opacity = '0' }, 1200)
    })
    return () => { offLevel(); offGot(); clearTimeout(timer) }
  }, [])
  return (
    <div className="relative flex items-center shrink-0 select-none" aria-hidden="true" title="Your mic level">
      <div className="flex items-center gap-[2px] h-4 sm:h-5">
        {Array.from({ length: STRIP_BARS }, (_, i) => (
          <span
            key={i}
            ref={(el) => { bars.current[i] = el }}
            className="block w-[3px] h-full rounded-full bg-[var(--accent)] origin-center motion-safe:transition-transform motion-safe:duration-75"
            style={{ transform: 'scaleY(0.18)', opacity: 0.45 }}
          />
        ))}
      </div>
      <span
        ref={tick}
        className="absolute left-full ml-1.5 whitespace-nowrap pointer-events-none text-[11px] leading-none text-[var(--accent)] border border-[var(--border-subtle)] rounded-full px-1.5 py-0.5 motion-safe:transition-opacity motion-safe:duration-300"
        style={{ opacity: 0 }}
      >
        got it
      </span>
    </div>
  )
}
