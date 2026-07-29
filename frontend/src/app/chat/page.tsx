'use client'

/**
 * Chat route page.
 *
 * Purely presentational now — all session state (LiveKit token, connect
 * flow, SSE keepalive, idle timer, sandbox state) lives one layer up in
 * <ChatSessionProvider> (see app/chat/layout.tsx). That layout-level
 * provider is stable across Fast Refresh, so edits to this file no
 * longer tear down the WebRTC connection or force the browser to
 * re-prompt for microphone access.
 */

import VoiceRoom from '@/components/VoiceRoom'
import { useChatSession } from '@/components/ChatSessionProvider'

export default function ChatPage() {
  const {
    connecting,
    connected,
    error,
    statusMsg,
    token,
    roomCode,
    reconnect,
    disconnect,
  } = useChatSession()

  // ─── Connecting state ────────────────────────────
  // Show the pulsing indicator while: (a) no token yet, or (b) token
  // landed but agent hasn't fired `agent_ready` over the data channel.
  if (connecting || (!connected && token && roomCode)) {
    return (
      <>
        <style>{`
          @keyframes breathe { 0%, 100% { transform: scale(1); opacity: 0.7; } 50% { transform: scale(1.15); opacity: 1; } }
          @keyframes ring { 0% { transform: scale(0.8); opacity: 0.5; } 100% { transform: scale(2.2); opacity: 0; } }
        `}</style>
        <main className="min-h-screen bg-[var(--background)] flex flex-col items-center justify-center p-8">
          <div className="flex flex-col items-center gap-6">
            <div className="relative w-20 h-20">
              <div
                className="absolute inset-0 rounded-full bg-[var(--accent)]"
                style={{ animation: 'breathe 2.4s ease-in-out infinite' }}
              />
              <div
                className="absolute inset-0 rounded-full border border-[var(--accent)]"
                style={{ animation: 'ring 2.4s ease-out infinite', opacity: 0.3 }}
              />
            </div>
            <p className="text-[var(--text-secondary)] text-sm">
              {statusMsg || 'Connecting...'}
            </p>
            <button
              onClick={disconnect}
              className="text-[var(--text-muted)] text-sm hover:text-[var(--text-secondary)] underline underline-offset-2 transition-colors"
            >
              Cancel
            </button>
          </div>

          {/* Hidden VoiceRoom keeps the data channel + agent event loop
              running while the connect UI is visible. Once the agent
              fires `agent_ready`, we swap to the full UI below. */}
          {token && roomCode && (
            <div className="hidden">
              <VoiceRoom waitingMode={true} />
            </div>
          )}
        </main>
      </>
    )
  }

  // ─── Error state ──────────────────────────────────
  if (error) {
    return (
      <main className="min-h-screen bg-[var(--background)] flex flex-col items-center justify-center p-8 gap-4">
        <p className="text-red-400 text-sm">{error}</p>
        <div className="flex gap-3">
          <button
            onClick={reconnect}
            className="px-4 py-2 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] text-sm hover:bg-[var(--surface-raised)] transition-colors"
          >
            Retry
          </button>
          <button
            onClick={disconnect}
            className="px-4 py-2 rounded-lg text-[var(--text-muted)] text-sm hover:text-[var(--text-secondary)] transition-colors"
          >
            Back
          </button>
        </div>
      </main>
    )
  }

  // ─── Connected — show VoiceRoom ───────────────────
  // VoiceRoom is rendered inside the <LiveKitRoom> established by the
  // provider, so all LiveKit hooks (useRoomContext, useLocalParticipant,
  // useDataChannel) work from here down.
  if (connected && token && roomCode) {
    return <VoiceRoom waitingMode={false} />
  }

  // ─── Disconnected / idle dead-state ───────────────
  // We fall here when: not connecting, no error, and no live token/room
  // (LiveKit dropped on server-side idle timeout, token expiry, or the agent
  // leaving — state was cleared but there's nothing to render). Previously
  // this returned null → a BLANK GRAY PAGE with no way back (the bug the user
  // kept hitting). Show an explicit "session paused, room saved" screen with a
  // Reconnect button (rejoins the SAME room) so it's never a dead blank tab.
  return (
    <main className="min-h-screen bg-[var(--background)] flex flex-col items-center justify-center p-8 gap-6">
      <div className="text-4xl">💤</div>
      <div className="text-center">
        <p className="text-[var(--text-primary)] text-lg font-medium">Session paused</p>
        <p className="text-[var(--text-muted)] text-sm mt-1">
          Your room is saved — no credits used while idle. Reconnect to pick up where you left off.
        </p>
      </div>
      <div className="flex gap-3">
        <button
          onClick={reconnect}
          className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Reconnect
        </button>
        <button
          onClick={disconnect}
          className="px-4 py-2 rounded-lg text-[var(--text-muted)] text-sm hover:text-[var(--text-secondary)] transition-colors"
        >
          Back to dashboard
        </button>
      </div>
    </main>
  )
}
