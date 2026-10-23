/**
 * Orb — reused voice orb from the live landing (LiveSessionMock), extracted as a
 * standalone presentational piece for V2 so hero + assembly can both use it.
 * Pure CSS motion driven by the globals.css keyframes (orbPulse / orbBreathe /
 * orbShimmer). No client JS needed; the breathing is ambient + decorative.
 */

type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking'

const STATE_COLOR: Record<OrbState, string> = {
  idle: 'var(--voice-idle)',
  listening: 'var(--voice-listening)',
  thinking: 'var(--voice-thinking)',
  speaking: 'var(--voice-speaking)',
}

const STATE_ANIM: Record<OrbState, string> = {
  idle: 'orbBreathe 6s ease-in-out infinite',
  listening: 'orbPulse 2.4s ease-in-out infinite',
  thinking: 'orbShimmer 6s linear infinite',
  speaking: 'orbBreathe 3s ease-in-out infinite',
}

export default function Orb({
  size = 120,
  state = 'listening',
  className = '',
}: {
  size?: number
  state?: OrbState
  className?: string
}) {
  const color = STATE_COLOR[state]
  const icon = Math.round(size * 0.26)
  return (
    <div
      className={`vn2-orb relative ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <div
        className="vn2-orb-body absolute inset-0 rounded-full"
        style={{
          background: `radial-gradient(circle at 35% 35%, ${color} 0%, var(--accent-dim) 120%)`,
          animation: STATE_ANIM[state],
          boxShadow: `0 0 ${Math.round(size * 0.5)}px color-mix(in srgb, ${color} 42%, transparent)`,
        }}
      />
      <svg
        className="absolute inset-0 m-auto"
        width={icon}
        height={icon}
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
  )
}
