import * as Haptics from 'expo-haptics'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'

/**
 * Dashboard (Sessions) — the Phase-0 native screen. This is REAL native: a
 * UITableView-backed FlatList, native large-title header (set in the tab
 * layout), native pressed-state feedback, and real haptics on tap. Mock data
 * for now; Phase 2 wires the live /sessions list. The point of this screen is
 * to let the founder feel the difference from the webview on real hardware.
 */

type Session = { id: string; title: string; sub: string; glyph: string }

const SESSIONS: Session[] = [
  { id: '1', title: 'Mobile iOS + watchOS shell', sub: 'osborn · 2m ago', glyph: '📱' },
  { id: '2', title: 'Pushover + ntfy wrist bridge', sub: 'osborn · 1h ago', glyph: '⌚️' },
  { id: '3', title: 'Marketing V2 redesign', sub: 'voice-native · yesterday', glyph: '🎨' },
  { id: '4', title: 'LiveKit reconnect grace', sub: 'osborn · yesterday', glyph: '🔌' },
  { id: '5', title: 'Noise-gate triage layer', sub: 'osborn · 2 days ago', glyph: '🎙️' },
]

export default function Dashboard() {
  return (
    <FlatList
      style={styles.list}
      contentInsetAdjustmentBehavior="automatic"
      data={SESSIONS}
      keyExtractor={(s) => s.id}
      ListHeaderComponent={<NewSessionButton />}
      ItemSeparatorComponent={() => <View style={styles.sep} />}
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

function Row({ session }: { session: Session }) {
  return (
    <Pressable
      onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <Text style={styles.glyph}>{session.glyph}</Text>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{session.title}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>{session.sub}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  list: { backgroundColor: '#0c0b09' },
  content: { paddingHorizontal: 16, paddingBottom: 32 },
  newBtn: {
    height: 50,
    borderRadius: 16,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 12,
  },
  newBtnPressed: { backgroundColor: '#2563eb', transform: [{ scale: 0.98 }] },
  newBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 14,
  },
  rowPressed: { backgroundColor: 'rgba(255,255,255,0.12)' },
  glyph: { fontSize: 24, marginRight: 12 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: '#fff', fontSize: 17 },
  rowSub: { color: 'rgba(255,255,255,0.45)', fontSize: 13, marginTop: 2 },
  chevron: { color: 'rgba(255,255,255,0.25)', fontSize: 20, marginLeft: 6 },
  sep: { height: 8 },
})
