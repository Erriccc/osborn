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
 * ARCHITECTURE (post-2026-05-22 redesign)
 *
 * This page is OUTPUT-ONLY now. It subscribes to osborn's LiveKit audio track
 * and plays it via track.attach() → Recall captures the page's audio output
 * and injects it into the meeting. That's the entire job.
 *
 * It does NOT call getUserMedia or publishTrack. The earlier Phase 2 attempt
 * that tried to capture meeting audio from inside Recall's headless browser
 * and publish it to LiveKit produced (a) silent input capture for the user
 * when voice-native was muted, and (b) garbled audio output to the meeting.
 *
 * Meeting audio INPUT is handled by Recall's documented WebSocket protocol
 * (recording_config.audio_separate_raw + realtime_endpoint websocket), which
 * streams per-participant PCM directly to the agent's /meeting-audio-in
 * handler. The agent feeds those frames into Deepgram STT independently of
 * this page. See recall-client.ts joinMeeting + index.ts meetingAudioInWss
 * for that pipeline.
 *
 * Implementation: raw livekit-client SDK (not @livekit/components-react). The
 * React wrappers (LiveKitRoom + RoomAudioRenderer) were observed producing
 * garbled audio in Recall's headless browser. Manual track.attach() on
 * TrackSubscribed events matches what works in Runway's bot.html reference.
 */

import { useEffect, useRef, useState } from 'react'
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type DataPacket_Kind,
  type RemoteParticipant,
} from 'livekit-client'

interface MeetingBotParams {
  token: string
  url: string
  room: string
  botId: string
}

export default function MeetingBotPage() {
  const [params, setParams] = useState<MeetingBotParams | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastSpoken, setLastSpoken] = useState('')
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting')
  const roomRef = useRef<Room | null>(null)
  const audioElementsRef = useRef<HTMLAudioElement[]>([])
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Read URL params on mount
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const token = sp.get('token')
    const url = sp.get('url') || process.env.NEXT_PUBLIC_LIVEKIT_URL || ''
    const room = sp.get('room')
    const botId = sp.get('botId') || 'unknown'

    if (!token) return setError('Missing token query param')
    if (!url) return setError('Missing url query param (and NEXT_PUBLIC_LIVEKIT_URL not set)')
    if (!room) return setError('Missing room query param')
    setParams({ token, url, room, botId })
  }, [])

  // Set up the LiveKit room — raw SDK, mirrors Runway's bot.html
  useEffect(() => {
    if (!params) return
    let cancelled = false

    const setup = async () => {
      const room = new Room({
        adaptiveStream: false,
        dynacast: false,
      })
      roomRef.current = room

      // Audio playback: attach remote audio tracks to <audio> elements appended
      // to document.body. This is what Recall captures as the bot's mic output
      // for the meeting. NOT RoomAudioRenderer — that React component was
      // observed producing garbled output in Recall's headless browser.
      //
      // CRITICAL feedback-loop filter — skip the `meeting-audio-publisher`
      // participant. That participant is OUR agent re-publishing the meeting's
      // own PCM frames (received from Recall's audio_separate_raw WebSocket)
      // into the LiveKit room so the AgentSession STT can hear it. If we
      // play its track out here, Recall captures the playback as bot output
      // and sends it INTO the meeting — meeting participants hear themselves
      // with ~1-2s of delay, on infinite loop. The publisher identity is set
      // in agent/src/index.ts meetingAudioInWss handler (`meeting-audio-*`).
      //
      // The user's voice-native browser mic is NOT filtered out here — even
      // though the user is also physically in the meeting, the bot page
      // playing the user's voice-native mic back is the original (working)
      // path that lets the user "ask osborn something via the meeting bot
      // page". It's only the meeting-audio republish that creates the loop.
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
        if (track.kind !== Track.Kind.Audio) return
        const identity = participant.identity || ''
        if (identity.startsWith('meeting-audio-')) {
          console.log('[meeting-bot] SKIP audio from meeting-audio-publisher (feedback prevention):', identity)
          return
        }
        const audioEl = track.attach() as HTMLAudioElement
        audioEl.volume = 1.0
        audioEl.autoplay = true
        document.body.appendChild(audioEl)
        audioElementsRef.current.push(audioEl)
        console.log('[meeting-bot] attached remote audio track from', identity)
      })

      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const elements = track.detach() as HTMLAudioElement[]
          elements.forEach(el => {
            el.remove()
            const idx = audioElementsRef.current.indexOf(el)
            if (idx >= 0) audioElementsRef.current.splice(idx, 1)
          })
        }
      })

      // Listen for assistant_response / claude_output data channel events to
      // display the currently-spoken text on screen for the meeting camera.
      room.on(RoomEvent.DataReceived, (payload: Uint8Array, _participant?: RemoteParticipant, _kind?: DataPacket_Kind, topic?: string) => {
        if (topic !== 'osborn-updates') return
        try {
          const text = new TextDecoder().decode(payload)
          const data = JSON.parse(text)
          const spoken = (data.type === 'assistant_response' || data.type === 'claude_output')
            ? data.text
            : null
          if (spoken && typeof spoken === 'string' && spoken.trim()) {
            setLastSpoken(spoken)
            setIsSpeaking(true)
            if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current)
            speakingTimerRef.current = setTimeout(() => setIsSpeaking(false), 6000)
          }
        } catch {
          // Non-JSON or unrelated event — ignore
        }
      })

      try {
        // Connect to LiveKit room (subscribe-only — we don't publish anything).
        await room.connect(params.url, params.token)
        if (cancelled) {
          await room.disconnect()
          return
        }
        setStatus('ready')
        console.log('[meeting-bot] connected to LiveKit room:', params.room)
        // No getUserMedia / publishTrack. Meeting → osborn audio is handled
        // by Recall's documented audio_separate_raw WebSocket protocol; see
        // agent/src/index.ts /meeting-audio-in handler.
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[meeting-bot] setup failed:', msg)
        if (!cancelled) {
          setError(msg)
          setStatus('error')
        }
      }
    }

    setup()

    return () => {
      cancelled = true
      if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current)
      // Detach + remove all audio elements
      audioElementsRef.current.forEach(el => el.remove())
      audioElementsRef.current = []
      // Disconnect
      if (roomRef.current) {
        roomRef.current.disconnect().catch(() => {})
        roomRef.current = null
      }
    }
  }, [params])

  if (error) {
    return (
      <div
        style={{
          position: 'fixed', inset: 0, background: '#0a0a0f', color: '#ef4444',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '24px', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
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
          position: 'fixed', inset: 0, background: '#0a0a0f', color: '#666',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        Initializing…
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: '#0a0a0f', color: '#fff',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', padding: '24px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {/* Header — status dot + OSBORN label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
        <span
          style={{
            width: '12px', height: '12px', borderRadius: '50%',
            background: isSpeaking ? '#f59e0b' : status === 'ready' ? '#3b82f6' : '#666',
            boxShadow: isSpeaking
              ? '0 0 16px rgba(245, 158, 11, 0.6)'
              : status === 'ready'
                ? '0 0 8px rgba(59, 130, 246, 0.4)'
                : 'none',
            transition: 'all 300ms ease',
          }}
        />
        <span style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '0.1em' }}>OSBORN</span>
      </div>

      {/* Currently-spoken text or status placeholder */}
      <div
        style={{
          maxWidth: '80%', textAlign: 'center', fontSize: '28px', lineHeight: 1.4,
          opacity: lastSpoken ? 1 : 0.3,
          transition: 'opacity 400ms ease', minHeight: '120px',
        }}
      >
        {lastSpoken || (status === 'ready' ? 'Listening…' : `${status}…`)}
      </div>

      {/* Footer — bot ID + audio element count (debug) */}
      <div style={{ position: 'absolute', bottom: '12px', fontSize: '10px', opacity: 0.3 }}>
        bot {params.botId.slice(0, 8)} · status {status}
      </div>
    </div>
  )
}
