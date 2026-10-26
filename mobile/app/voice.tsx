import { AudioSession, LiveKitRoom, useDataChannel, useLocalParticipant } from '@livekit/react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as Haptics from 'expo-haptics'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { connectVoice, getServerUrl } from '../lib/agent'
import { LIVEKIT_URL } from '../lib/config'

/**
 * Voice screen (Phase 3 core). Resolves the agent, starts a room via
 * /connect-room, mints a token, and joins the LiveKit room with real native
 * WebRTC audio. Inside: live transcript off the data channel, mic toggle, End.
 * This is the v1 voice loop; the full VoiceRoom feature set (permissions,
 * files, meeting) layers on later.
 */
export default function VoiceScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId?: string }>()
  const [conn, setConn] = useState<{ token: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        await AudioSession.startAudioSession()
        const url = await getServerUrl()
        if (!url) { if (active) setError('No agent machine — start a session on the web first.'); return }
        const c = await connectVoice(url, sessionId)
        if (active) setConn({ token: c.token })
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'connect failed')
      }
    })()
    return () => { active = false; AudioSession.stopAudioSession() }
  }, [sessionId])

  if (error) return <Centered><Text style={styles.err}>{error}</Text><BackButton /></Centered>
  if (!conn) return <Centered><ActivityIndicator color="#3b82f6" /><Text style={styles.connecting}>Connecting…</Text></Centered>

  return (
    <LiveKitRoom serverUrl={LIVEKIT_URL} token={conn.token} connect audio>
      <RoomView />
    </LiveKitRoom>
  )
}

type Line = { id: string; role: 'user' | 'agent'; text: string }

function RoomView() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { localParticipant } = useLocalParticipant()
  const { message } = useDataChannel()
  const [lines, setLines] = useState<Line[]>([])
  const [agentState, setAgentState] = useState('connecting')
  const [micOn, setMicOn] = useState(true)
  const scroll = useRef<ScrollView>(null)

  // Parse the agent's data-channel messages (same protocol the web uses).
  useEffect(() => {
    if (!message?.payload) return
    try {
      const d = JSON.parse(new TextDecoder().decode(message.payload))
      if ((d.type === 'assistant_text' || d.type === 'assistant_result') && d.text) {
        setLines((l) => upsert(l, d.messageId ?? d.type, 'agent', String(d.text)))
      } else if (d.type === 'user_transcript' && d.text) {
        setLines((l) => upsert(l, d.messageId ?? `u-${Date.now()}`, 'user', String(d.text)))
      } else if (d.type === 'agent_state' || d.type === 'state') {
        setAgentState(String(d.state ?? d.agent ?? 'idle'))
      }
    } catch { /* non-JSON data */ }
  }, [message])

  useEffect(() => { scroll.current?.scrollToEnd({ animated: true }) }, [lines])

  function toggleMic() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    const next = !micOn
    setMicOn(next)
    localParticipant?.setMicrophoneEnabled(next)
  }

  function end() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    router.back()
  }

  return (
    <View style={[styles.room, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <StateDot state={agentState} />
        <Text style={styles.state}>{cap(agentState)}</Text>
      </View>

      <ScrollView ref={scroll} style={styles.transcript} contentContainerStyle={styles.transcriptContent}>
        {lines.length === 0 ? (
          <Text style={styles.hint}>Say something to your agent…</Text>
        ) : lines.map((l) => (
          <View key={l.id} style={[styles.bubble, l.role === 'user' ? styles.user : styles.agent]}>
            <Text style={styles.bubbleText}>{l.text}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={[styles.controls, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable onPress={toggleMic} style={({ pressed }) => [styles.micBtn, !micOn && styles.micOff, pressed && styles.pressed]}>
          <Text style={styles.micText}>{micOn ? '🎙️  Mic on' : '🔇  Muted'}</Text>
        </Pressable>
        <Pressable onPress={end} style={({ pressed }) => [styles.endBtn, pressed && styles.pressed]}>
          <Text style={styles.endText}>End</Text>
        </Pressable>
      </View>
    </View>
  )
}

function upsert(lines: Line[], id: string, role: 'user' | 'agent', text: string): Line[] {
  const i = lines.findIndex((l) => l.id === id)
  if (i >= 0) { const next = [...lines]; next[i] = { id, role, text }; return next }
  return [...lines, { id, role, text }]
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function StateDot({ state }: { state: string }) {
  const color = state === 'listening' ? '#22c55e' : state === 'thinking' ? '#eab308' : state === 'speaking' ? '#3b82f6' : '#6b7280'
  return <View style={[styles.dot, { backgroundColor: color }]} />
}

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={styles.centered}>{children}</View>
}
function BackButton() {
  const router = useRouter()
  return <Pressable onPress={() => router.back()} style={styles.backBtn}><Text style={styles.backText}>Back</Text></Pressable>
}

const styles = StyleSheet.create({
  centered: { flex: 1, backgroundColor: '#0c0b09', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  connecting: { color: 'rgba(255,255,255,0.5)', fontSize: 15 },
  err: { color: '#f87171', fontSize: 15, textAlign: 'center' },
  room: { flex: 1, backgroundColor: '#0c0b09' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 12 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  state: { color: '#fff', fontSize: 16, fontWeight: '600' },
  transcript: { flex: 1 },
  transcriptContent: { padding: 16, gap: 10 },
  hint: { color: 'rgba(255,255,255,0.35)', fontSize: 15, textAlign: 'center', marginTop: 40 },
  bubble: { maxWidth: '85%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  user: { alignSelf: 'flex-end', backgroundColor: '#3b82f6' },
  agent: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.08)' },
  bubbleText: { color: '#fff', fontSize: 16, lineHeight: 22 },
  controls: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 12 },
  micBtn: { flex: 1, height: 52, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' },
  micOff: { backgroundColor: 'rgba(248,113,113,0.15)' },
  micText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  endBtn: { width: 110, height: 52, borderRadius: 14, backgroundColor: '#ef4444', alignItems: 'center', justifyContent: 'center' },
  endText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  pressed: { opacity: 0.85 },
  backBtn: { marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)' },
  backText: { color: '#fff', fontSize: 15, fontWeight: '600' },
})
