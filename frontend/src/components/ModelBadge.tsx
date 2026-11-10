'use client'

import { resolveModelBadge } from '@/lib/modelBadge'

/**
 * ModelBadge — a small, unobtrusive header pill showing WHICH model/provider is
 * actually answering, plus the running Osborn version (issue #87).
 *
 * It is driven ONLY by real server signals, never the agent's prose self-report:
 *   - `provider` comes from the `agent_ready.provider` data-channel message
 *     (the session's declared main-brain provider).
 *   - `version` comes from the agent's GET /health → { version } (already polled
 *     by VoiceRoom for memory stats).
 *
 * Before a provider signal arrives it shows a neutral state rather than guessing.
 * The exact fast-brain (⚡ quick take) provider is not yet on the wire; that is a
 * documented agent-side follow-up.
 */
export default function ModelBadge({
  provider,
  version,
  connected,
}: {
  provider?: string | null
  version?: string | null
  connected?: boolean
}) {
  const badge = resolveModelBadge({ mainProvider: provider, version, connected })

  if (!badge.known) {
    // Neutral state — a version may still be known from /health before the
    // provider is declared. Never fabricate a model name.
    return (
      <span
        title={badge.title}
        className="hidden sm:inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-full bg-gray-800/40 border border-gray-700/40 text-[10px] text-gray-500"
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-gray-500/70" />
        </span>
        <span>Model</span>
        <span className="text-gray-600">&mdash;</span>
        {badge.version && <span className="hidden md:inline text-gray-600">v{badge.version}</span>}
      </span>
    )
  }

  return (
    <span
      title={badge.title}
      className="inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-400/30 text-[10px] text-indigo-200"
    >
      {/* spark/diamond mark — a plain model signifier, not a brand logo */}
      <svg className="w-3 h-3 shrink-0 text-indigo-300" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2l2.1 6.4L20.5 10l-6.4 2.1L12 18l-2.1-6.4L3.5 10l6.4-1.6L12 2z" />
      </svg>
      <span className="font-medium">{badge.label}</span>
      {badge.version && (
        <span className="hidden sm:inline text-indigo-300/70 font-mono tabular-nums">v{badge.version}</span>
      )}
    </span>
  )
}
