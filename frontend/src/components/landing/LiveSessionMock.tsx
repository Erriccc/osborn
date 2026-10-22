'use client'

import { useEffect, useState } from 'react'

type VoiceState = 'listening' | 'thinking' | 'speaking'

const STATE_SEQ: VoiceState[] = ['listening', 'thinking', 'speaking']

const STATE_META: Record<VoiceState, { label: string; color: string }> = {
  listening: { label: 'Listening', color: 'var(--voice-listening)' },
  thinking: { label: 'Thinking', color: 'var(--voice-thinking)' },
  speaking: { label: 'Speaking', color: 'var(--voice-speaking)' },
}

const AGENTS = [
  { dot: '●', name: 'Researcher', model: 'sonnet', status: 'reading repo…', live: true },
  { dot: '●', name: 'Reasoner', model: 'opus', status: 'planning…', live: true },
  { dot: '○', name: 'Writer', model: 'opus', status: 'queued', live: false },
]

export default function LiveSessionMock() {
  const [stateIdx, setStateIdx] = useState(0)
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (reduced) return
    const id = setInterval(() => {
      setStateIdx((i) => (i + 1) % STATE_SEQ.length)
    }, 2600)
    return () => clearInterval(id)
  }, [reduced])

  const state = STATE_SEQ[reduced ? 0 : stateIdx]
  const meta = STATE_META[state]

  // Orb animation per state (frozen on reduced motion)
  const orbAnimation = reduced
    ? 'none'
    : state === 'listening'
      ? 'orbPulse 2.4s ease-in-out infinite'
      : state === 'thinking'
        ? 'orbShimmer 6s linear infinite'
        : 'orbBreathe 3s ease-in-out infinite'

  return (
    <div
      className="relative w-full max-w-[420px] rounded-2xl border border-[var(--border)] overflow-hidden"
      style={{ background: 'var(--surface)' }}
      aria-hidden="true"
    >
      {/* Faux window chrome */}
      <div className="flex items-center justify-between px-4 h-9 border-b border-[var(--border-subtle)]">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
          live session
        </span>
        <span className="font-mono text-[10px] text-[var(--text-muted)]">voice-native.com</span>
      </div>

      {/* Orb + state */}
      <div className="flex flex-col items-center gap-4 pt-8 pb-6">
        <div className="relative w-24 h-24">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: `radial-gradient(circle at 35% 35%, ${meta.color} 0%, var(--accent-dim) 120%)`,
              animation: orbAnimation,
              boxShadow: `0 0 48px color-mix(in srgb, ${meta.color} 40%, transparent)`,
              transition: 'background 0.6s ease, box-shadow 0.6s ease',
            }}
          />
          <svg
            className="absolute inset-0 m-auto"
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--background)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </div>

        <div className="flex items-center gap-2">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: meta.color, transition: 'background 0.6s ease' }}
          />
          <span
            className="font-mono text-[12px] uppercase tracking-[0.14em]"
            style={{ color: meta.color, transition: 'color 0.6s ease' }}
          >
            {meta.label}
          </span>
        </div>
      </div>

      {/* Sub-agent card */}
      <div className="mx-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3 flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
          sub-agents · 3
        </span>
        {AGENTS.map((a) => (
          <div key={a.name} className="flex items-center gap-2 font-mono text-[12px]">
            <span style={{ color: a.live ? 'var(--voice-listening)' : 'var(--text-muted)' }}>
              {a.dot}
            </span>
            <span className="text-[var(--text-primary)]">{a.name}</span>
            <span
              className="px-1.5 py-[1px] rounded text-[10px] text-[var(--text-secondary)] border border-[var(--border)]"
            >
              {a.model}
            </span>
            <span className="text-[var(--text-secondary)] truncate">{a.status}</span>
          </div>
        ))}
      </div>

      {/* Machine stat chip + code diff sliver (hidden on smallest screens) */}
      <div className="hidden sm:block">
        <div className="mx-4 mt-3">
          <span className="inline-flex items-center gap-2 font-mono text-[11px] text-[var(--text-secondary)] rounded-full border border-[var(--border)] px-3 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--voice-speaking)]" />
            machine · 4.1 GB / 8 GB · 3 procs
          </span>
        </div>

        <div className="mx-4 mt-3 mb-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--background)] overflow-hidden">
          <div className="px-3 h-7 flex items-center border-b border-[var(--border-subtle)]">
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              src/billing/stripe.ts
            </span>
          </div>
          <pre className="font-mono text-[11px] leading-[1.7] px-3 py-2 overflow-hidden">
            <code>
              <span className="block text-[var(--text-muted)]">  export async function</span>
              <span
                className="block"
                style={{ background: 'color-mix(in srgb, var(--voice-speaking) 12%, transparent)', color: 'var(--voice-speaking)' }}
              >
                +   createCheckout(uid: string) {'{'}
              </span>
              <span
                className="block"
                style={{ background: 'color-mix(in srgb, var(--voice-speaking) 12%, transparent)', color: 'var(--voice-speaking)' }}
              >
                +     return stripe.checkout.sessions.create(…)
              </span>
              <span className="block text-[var(--text-muted)]">  {'}'}</span>
            </code>
          </pre>
        </div>
      </div>
    </div>
  )
}
