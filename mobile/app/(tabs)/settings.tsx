import { StyleSheet, Text, View } from 'react-native'

// Placeholder — Phase 4 ports the iOS-grouped settings (secrets, machine
// controls, drill-in). Here to complete the Phase-0 native tab bar.
export default function Settings() {
  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>⚙️</Text>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.sub}>Account, keys, machine — ported in Phase 4.</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0b09', alignItems: 'center', justifyContent: 'center', gap: 8 },
  emoji: { fontSize: 44 },
  title: { color: '#fff', fontSize: 22, fontWeight: '600' },
  sub: { color: 'rgba(255,255,255,0.4)', fontSize: 14 },
})
