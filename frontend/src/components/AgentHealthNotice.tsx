'use client'

import { resolveAgentHealth, type KeyHealthEntry } from '@/lib/agent-health'

/**
 * AgentHealthNotice — a small header pill that surfaces a SILENT failure the
 * session would otherwise hide (issue #87, gap 3):
 *
 *   - the machine's agent predates the demo-model fallback (version floor), so a
 *     configured key is being silently ignored, or
 *   - every configured fallback key failed its self-test (agent-emitted).
 *
 * It renders nothing when there is nothing honest to say, and only ever appears
 * for a session that is actually relying on the fallback (no Claude login) — a
 * Claude-connected session is unaffected by the demo tier's health. Driven by
 * the same real signals as the model badge (GET /health → version); it never
 * fabricates a status.
 */
export default function AgentHealthNotice({
  version,
  relyingOnFallback,
  keyHealth,
}: {
  version?: string | null
  relyingOnFallback?: boolean
  keyHealth?: KeyHealthEntry[]
}) {
  const health = resolveAgentHealth({ version, relyingOnFallback, keyHealth })
  if (!health.show) return null

  return (
    <span
      title={health.title}
      role="status"
      className="inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-400/40 text-[10px] text-amber-200"
    >
      {/* warning triangle — a plain status signifier */}
      <svg className="w-3 h-3 shrink-0 text-amber-300" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2L1 21h22L12 2zm0 6l6.5 11h-13L12 8zm-1 3v4h2v-4h-2zm0 5v2h2v-2h-2z" />
      </svg>
      <span className="font-medium">{health.label}</span>
    </span>
  )
}
