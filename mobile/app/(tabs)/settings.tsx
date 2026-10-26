import * as Haptics from 'expo-haptics'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useAuth } from '../../lib/auth'

// Phase 1: shows the signed-in account + sign out (completes the auth loop).
// Phase 4 ports the full iOS-grouped settings (secrets, machine controls).
export default function Settings() {
  const { session, signOut } = useAuth()

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.label}>SIGNED IN AS</Text>
        <Text style={styles.email}>{session?.user?.email ?? '—'}</Text>
      </View>

      <Pressable
        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); signOut() }}
        style={({ pressed }) => [styles.signOut, pressed && styles.pressed]}
      >
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>

      <Text style={styles.note}>Keys, machine controls & more — ported in Phase 4.</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0b09', padding: 16, gap: 16 },
  card: { backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 14, padding: 16 },
  label: { color: 'rgba(255,255,255,0.4)', fontSize: 12, fontWeight: '600', marginBottom: 6 },
  email: { color: '#fff', fontSize: 17 },
  signOut: { height: 50, borderRadius: 14, backgroundColor: 'rgba(248,113,113,0.15)', alignItems: 'center', justifyContent: 'center' },
  signOutText: { color: '#f87171', fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.8 },
  note: { color: 'rgba(255,255,255,0.3)', fontSize: 13, textAlign: 'center', marginTop: 8 },
})
