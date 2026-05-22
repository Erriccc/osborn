'use client'

/**
 * Meeting Bot page — rendered by Recall.ai's headless browser as the bot's
 * "camera" feed for Zoom / Google Meet / Teams.
 *
 * URL shape: /meeting-bot?token=<jwt>&url=<livekit-url>&room=<room-name>&botId=<id>
 *   token   — short-lived LiveKit token minted by /api/meeting-bot-token
 *   url     — LiveKit server URL (e.g. wss://voicenative.livekit.cloud)
 *   room    — same LiveKit room name the osborn agent is in
 *   botId   — Recall bot ID (for display only)
 *
 * Audio flow (Phase 2 — bidirectional via LiveKit):
 *   - getUserMedia captures meeting audio (Recall's headless browser auto-grants
 *     permission and exposes the meeting's audio stream as the default mic).
 *     We disable echoCancellation / noiseSuppression / autoGainControl per
 *     Runway's documented pattern to preserve raw meeting audio quality.
 *   - The captured track is published to LiveKit as `meeting-audio`. The agent's
 *     existing STT pipeline (Deepgram Flux with end-of-turn detection) processes
 *     it the same way as any other participant's mic — ONE chat() call per actual
 *     end-of-turn, NOT per sentence fragment as Recall's webhook STT was doing.
 *   - <RoomAudioRenderer /> subscribes to osborn's TTS track and plays it via the
 *     page's audio output. Recall captures that output and injects it into the
 *     meeting. SpeechHandle on osborn's side serializes the playback (one
 *     utterance at a time) — kills the parallel-speech overlap bug.
 *
 * Why this beats the legacy WebSocket+WAV pipe:
 *   The old path (synthesizeForMeeting → meetingOutputWs) spawned a fire-and-
 *   forget WAV pump per tts_say event. Multiple events back-to-back meant
 *   multiple WAV streams pumping in parallel → meeting heard overlapping audio.
 *   The LiveKit path uses session.say() → SpeechHandle queue → sequential by
 *   design. Plus we get bidirectional audio (meeting → LiveKit → agent STT) for
 *   free, and can disable Recall's per-fragment webhook STT that was firing
 *   ~10 chat() calls per actual utterance.
 *
 * Visual: minimal dark page with status dot + agent name + last spoken text.
 * Recall captures the rendered page as the bot's camera feed.
 *
 * This page does NOT render the full chat UI (intentional — meeting participants
 * shouldn't see a chat sidebar in the bot's camera tile).
 *
 * Reference implementation: https://github.com/runwayml/runway-characters-meet/blob/main/public/bot.html
 */

import { useEffect, useState } from 'react'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useDataChannel,
  useLocalParticipant,
} from '@livekit/components-react'
import '@livekit/components-styles'

interface MeetingBotParams {
  token: string
  url: string
  room: string
  botId: string
}

/**
 * Publishes the page's getUserMedia audio to the LiveKit room as `meeting-audio`.
 *
 * Recall's headless browser auto-grants the mic permission and exposes whatever
 * the bot is hearing (the meeting audio) as the default mic input. We disable
 * the standard browser audio processing flags so the meeting audio passes
 * through raw — echoCancellation/etc are designed for human users on noisy
 * microphones, not for streams that have already been processed by the meeting
 * platform.
 */
function PublishMeetingAudio() {
  const { localParticipant } = useLocalParticipant()
  const [published, setPublished] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)

  useEffect(() => {
    if (!localParticipant || published) return
    let cancelled = false

    const publish = async () => {
      try {
        // setMicrophoneEnabled is LiveKit's higher-level API for publishing the
        // local mic. It accepts AudioCaptureOptions so we can override the
        // default echoCancellation/noiseSuppression/autoGainControl flags.
        await localParticipant.setMicrophoneEnabled(true, {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        })
        if (!cancelled) {
          setPublished(true)
          console.log('[meeting-bot] published meeting-audio track')
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err)
          setPublishError(msg)
          console.error('[meeting-bot] failed to publish meeting-audio:', msg)
        }
      }
    }
    publish()

    return () => {
      cancelled = true
    }
  }, [localParticipant, published])

  // No visible UI — pure side-effect component. Errors are surfaced via console.
  // The status indicator in MeetingBotUI shows the connected/speaking state.
  if (publishError) {
    return (
      <div
        style={{
          position: 'fixed',
          bottom: 28,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: 10,
          color: '#ef4444',
          opacity: 0.6,
        }}
      >
        publish error: {publishError.substring(0, 100)}
      </div>
    )
  }
  return null
}

function MeetingBotUI({ botId }: { botId: string }) {
  const [lastSpoken, setLastSpoken] = useState('')
  const [isSpeaking, setIsSpeaking] = useState(false)

  // Listen for assistant_response / claude_output events to display the
  // currently-spoken text. Reuses the same topic + event shape as the chat UI.
  useDataChannel('osborn-updates', (msg) => {
    try {
      const text = new TextDecoder().decode(msg.payload)
      const data = JSON.parse(text)
      const spoken = (data.type === 'assistant_response' || data.type === 'claude_output') ? data.text : null
      if (spoken && typeof spoken === 'string' && spoken.trim()) {
        setLastSpoken(spoken)
        setIsSpeaking(true)
        // Clear "speaking" state ~6s after last update so the indicator dims
        // when osborn finishes a long utterance and no new chunks arrive.
        const t = setTimeout(() => setIsSpeaking(false), 6000)
        return () => clearTimeout(t)
      }
    } catch {
      // Non-JSON or unrelated event — ignore
    }
  })

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0a0a0f',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {/* Header — status dot + OSBORN label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
        <span
          style={{
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            background: isSpeaking ? '#f59e0b' : '#3b82f6',
            boxShadow: isSpeaking
              ? '0 0 16px rgba(245, 158, 11, 0.6)'
              : '0 0 8px rgba(59, 130, 246, 0.4)',
            transition: 'all 300ms ease',
          }}
        />
        <span style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '0.1em' }}>OSBORN</span>
      </div>

      {/* Currently-spoken text */}
      <div
        style={{
          maxWidth: '80%',
          textAlign: 'center',
          fontSize: '28px',
          lineHeight: 1.4,
          opacity: lastSpoken ? 1 : 0.3,
          transition: 'opacity 400ms ease',
          minHeight: '120px',
        }}
      >
        {lastSpoken || 'Listening…'}
      </div>

      {/* Footer — bot ID (small, debug) */}
      <div style={{ position: 'absolute', bottom: '12px', fontSize: '10px', opacity: 0.3 }}>
        bot {botId.slice(0, 8)}
      </div>
    </div>
  )
}

export default function MeetingBotPage() {
  const [params, setParams] = useState<MeetingBotParams | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const token = sp.get('token')
    const url = sp.get('url') || process.env.NEXT_PUBLIC_LIVEKIT_URL || ''
    const room = sp.get('room')
    const botId = sp.get('botId') || 'unknown'

    if (!token) {
      setError('Missing token query param')
      return
    }
    if (!url) {
      setError('Missing url query param (and NEXT_PUBLIC_LIVEKIT_URL not set)')
      return
    }
    if (!room) {
      setError('Missing room query param')
      return
    }

    setParams({ token, url, room, botId })
  }, [])

  if (error) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: '#0a0a0f',
          color: '#ef4444',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
          fontSize: '14px',
        }}
      >
        {error}
      </div>
    )
  }

  if (!params) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: '#0a0a0f',
          color: '#666',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        Initializing…
      </div>
    )
  }

  return (
    <LiveKitRoom
      token={params.token}
      serverUrl={params.url}
      connect={true}
      // We don't use audio={true} — PublishMeetingAudio publishes manually with
      // custom AudioCaptureOptions (echo/noise/AGC disabled). audio={true} would
      // use the LiveKit defaults (all three enabled), distorting meeting audio.
      audio={false}
      video={false}
      // Bot context — disable adaptive bitrate + simulcast for predictable audio.
      // Recall's headless browser has fixed-cost bandwidth and we don't need
      // multi-quality streams.
      options={{ adaptiveStream: false, dynacast: false }}
    >
      <RoomAudioRenderer />
      <PublishMeetingAudio />
      <MeetingBotUI botId={params.botId} />
    </LiveKitRoom>
  )
}
