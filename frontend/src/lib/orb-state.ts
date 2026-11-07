// Pure mapping from voice-session signals to what the orb shows.
//
// The orb must be honest: it never says "Listening" when the mic is muted,
// blocked or confirmed off, and it never says "Ready" for anything except a
// genuinely idle agent (the old config map had no `error` key, so the agent's
// `agent_state:'error'` fell back to "Ready").
//
// Precedence (highest first):
//   error > reconnecting > blocked* > micOff(listening|idle) > muted(listening|idle) > agentState
// * While the agent is speaking or thinking, `blocked` does not replace the
//   main state; it shows as a "mic blocked" badge instead (blockedBadge).
// The muted badge is independent of the resolved state.

export type OrbKey =
  | 'error'
  | 'reconnecting'
  | 'blocked'
  | 'micOff'
  | 'muted'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'idle'
  | 'disconnected'
  | 'unknown'

export interface OrbInput {
  /** Effective agent state: the agent's `agent_state` value, or the LiveKit
   *  voice-assistant state when the agent reports idle. */
  agentState?: string | null
  /** Mic confirmed off (not merely muted) for a grace period. */
  micOff?: boolean
  /** User intentionally muted the mic. */
  muted?: boolean
  /** Room transport is reconnecting. */
  reconnecting?: boolean
  /** Mic permission denied / no device / device busy. */
  blocked?: boolean
  /** An error is known outside of agentState (e.g. a connection error). */
  error?: boolean
}

export interface OrbView {
  key: OrbKey
  label: string
  colorVar: string
  anim: string
  /** True whenever the user is muted, regardless of the resolved state. */
  mutedBadge: boolean
  /** True when the mic is blocked but the main label shows the agent's
   *  speaking/thinking state instead of "Mic blocked". */
  blockedBadge: boolean
}

const BREATHE = 'orbBreathe 3.5s ease-in-out infinite'
const SLOW_BREATHE = 'orbBreathe 1.8s ease-in-out infinite'
const PULSE = 'orbPulse 1.6s ease-in-out infinite'
const SHIMMER = 'orbShimmer 2.4s linear infinite'
const RIPPLE = 'orbRipple 1.1s ease-out infinite'

// --voice-blocked / --voice-reconnecting / --voice-connecting are not defined
// in globals.css yet; the fallbacks keep them distinct until they are.
export const ORB_VIEWS: Record<OrbKey, Omit<OrbView, 'mutedBadge' | 'blockedBadge'>> = {
  error:        { key: 'error',        label: 'Error',        colorVar: 'var(--voice-error)',                       anim: 'none' },
  reconnecting: { key: 'reconnecting', label: 'Reconnecting', colorVar: 'var(--voice-reconnecting, #b89b5e)',       anim: SLOW_BREATHE },
  blocked:      { key: 'blocked',      label: 'Mic blocked',  colorVar: 'var(--voice-blocked, #c4756b)',            anim: BREATHE },
  micOff:       { key: 'micOff',       label: 'Mic off',      colorVar: 'var(--voice-error)',                       anim: BREATHE },
  muted:        { key: 'muted',        label: 'Muted',        colorVar: 'var(--voice-idle)',                        anim: BREATHE },
  connecting:   { key: 'connecting',   label: 'Connecting',   colorVar: 'var(--voice-connecting, #7d7768)',         anim: SLOW_BREATHE },
  listening:    { key: 'listening',    label: 'Listening',    colorVar: 'var(--voice-listening)',                   anim: PULSE },
  thinking:     { key: 'thinking',     label: 'Thinking',     colorVar: 'var(--voice-thinking)',                    anim: SHIMMER },
  speaking:     { key: 'speaking',     label: 'Speaking',     colorVar: 'var(--voice-speaking)',                    anim: RIPPLE },
  idle:         { key: 'idle',         label: 'Ready',        colorVar: 'var(--voice-idle)',                        anim: BREATHE },
  disconnected: { key: 'disconnected', label: 'Disconnected', colorVar: 'var(--voice-idle)',                        anim: 'none' },
  unknown:      { key: 'unknown',      label: 'Waiting',      colorVar: 'var(--voice-idle)',                        anim: BREATHE },
}

/** Map a raw agent / LiveKit state string to a base orb key. Only `idle`
 *  maps to "Ready"; unrecognised states map to a neutral "Waiting". */
export function baseOrbKey(agentState: string | null | undefined): OrbKey {
  switch (agentState) {
    case 'idle': return 'idle'
    case 'listening': return 'listening'
    case 'thinking': return 'thinking'
    case 'speaking': return 'speaking'
    case 'error': return 'error'
    case 'connecting':
    case 'initializing':
    case 'pre-connect-buffering':
      return 'connecting'
    case 'disconnected': return 'disconnected'
    default: return 'unknown'
  }
}

export function resolveOrbState(input: OrbInput): OrbView {
  const muted = !!input.muted
  const blocked = !!input.blocked
  const base = baseOrbKey(input.agentState)
  const agentBusy = base === 'speaking' || base === 'thinking'
  const micGated = base === 'listening' || base === 'idle'
  let key: OrbKey
  if (input.error || base === 'error') key = 'error'
  else if (input.reconnecting) key = 'reconnecting'
  else if (blocked && !agentBusy) key = 'blocked'
  else if (micGated && input.micOff) key = 'micOff'
  else if (micGated && muted) key = 'muted'
  else key = base
  const blockedBadge = blocked && (key === 'speaking' || key === 'thinking')
  return { ...ORB_VIEWS[key], mutedBadge: muted, blockedBadge }
}
