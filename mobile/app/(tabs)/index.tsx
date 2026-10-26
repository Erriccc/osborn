import * as Haptics from 'expo-haptics'
import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { type AgentSession, getServerUrl, listSessions, relativeTime } from '../../lib/agent'

/**
 * Dashboard (Sessions) — Phase 2: REAL data. Resolves the user's agent URL
 * from the instances table, fetches /sessions off the agent directly, and
 * renders them in a native FlatList with pull-to-refresh. New Session + row
 * taps wire to the voice screen in Phase 3.
 */
export default function Dashboard() {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'no-machine'>('loading')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const url = await getServerUrl()
      if (!url) { setState('no-machine'); return }
      const list = await listSessions(url)
      setSessions(list)
      setState('ready')
    } catch {
      setState('error')
    }
  }, [])

  useEffect(() => { load() }, [load])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  if (state === 'loading') {
    return <View style={styles.center}><ActivityIndicator color="#3b82f6" /></View>
  }

  return (
    <FlatList
      style={styles.list}
      contentInsetAdjustmentBehavior="automatic"
      data={sessions}
      keyExtractor={(s) => s.sessionId}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#8e8e93" />}
      ListHeaderComponent={<NewSessionButton />}
      ItemSeparatorComponent={() => <View style={styles.sep} />}
      ListEmptyComponent={<EmptyState state={state} onRetry={load} />}
      renderItem={({ item }) => <Row session={item} />}
      contentContainerStyle={styles.content}
    />
  )
}

function NewSessionButton() {
  return (
    <Pressable
      onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)}
      style={({ pressed }) => [styles.newBtn, pressed && styles.newBtnPressed]}
    >
      <Text style={styles.newBtnText}>＋  New Session</Text>
    </Pressable>
  )
}

function Row({ session }: { session: AgentSession }) {
  const title = (session.lastMessage || 'New conversation').replace(/\s+/g, ' ').trim()
  const where = session.projectSlug || session.cwd.split('/').pop() || 'workspace'
  return (
    <Pressable
      onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <Text style={styles.glyph}>💬</Text>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {where} · {relativeTime(session.timestamp)} · {session.messageCount} msg
        </Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  )
}

function EmptyState({ state, onRetry }: { state: string; onRetry: () => void }) {
  if (state === 'no-machine') {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyEmoji}>🖥️</Text>
        <Text style={styles.emptyTitle}>No machine yet</Text>
        <Text style={styles.emptySub}>Start a session on the web to provision your agent, then pull to refresh.</Text>
      </View>
    )
  }
  if (state === 'error') {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyEmoji}>⚠️</Text>
        <Text style={styles.emptyTitle}>Couldn’t reach your agent</Text>
        <Pressable onPress={onRetry} style={styles.retry}><Text style={styles.retryText}>Retry</Text></Pressable>
      </View>
    )
  }
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyEmoji}>🎙️</Text>
      <Text style={styles.emptyTitle}>No sessions yet</Text>
      <Text style={styles.emptySub}>Tap New Session to start talking to your agent.</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  list: { backgroundColor: '#0c0b09' },
  center: { flex: 1, backgroundColor: '#0c0b09', alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 16, paddingBottom: 32, flexGrow: 1 },
  newBtn: { height: 50, borderRadius: 16, backgroundColor: '#3b82f6', alignItems: 'center', justifyContent: 'center', marginVertical: 12 },
  newBtnPressed: { backgroundColor: '#2563eb', transform: [{ scale: 0.98 }] },
  newBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 12, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 14 },
  rowPressed: { backgroundColor: 'rgba(255,255,255,0.12)' },
  glyph: { fontSize: 24, marginRight: 12 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: '#fff', fontSize: 17 },
  rowSub: { color: 'rgba(255,255,255,0.45)', fontSize: 13, marginTop: 2 },
  chevron: { color: 'rgba(255,255,255,0.25)', fontSize: 20, marginLeft: 6 },
  sep: { height: 8 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 8 },
  emptyEmoji: { fontSize: 44 },
  emptyTitle: { color: '#fff', fontSize: 18, fontWeight: '600' },
  emptySub: { color: 'rgba(255,255,255,0.4)', fontSize: 14, textAlign: 'center', paddingHorizontal: 32 },
  retry: { marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)' },
  retryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
})
