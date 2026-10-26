import * as Haptics from 'expo-haptics'
import { useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth } from '../lib/auth'

/**
 * Login — the first native screen that does real work. Google sign-in goes
 * through a native Safari sheet (ASWebAuthenticationSession), which Google
 * permits — the exact flow the WKWebView shell was blocked on. Email/password
 * is the fallback.
 */
export default function Login() {
  const { signInWithGoogle, signInWithEmail } = useAuth()
  const insets = useSafeAreaInsets()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'google' | 'email' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function google() {
    setError(null)
    setBusy('google')
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    const { error } = await signInWithGoogle()
    if (error && error !== 'cancelled') setError(error)
    setBusy(null)
  }

  async function emailLogin() {
    if (!email || !password) return
    setError(null)
    setBusy('email')
    const { error } = await signInWithEmail(email.trim(), password)
    if (error) setError(error)
    setBusy(null)
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      <View style={styles.hero}>
        <Text style={styles.orb}>🎙️</Text>
        <Text style={styles.title}>Voice Native</Text>
        <Text style={styles.subtitle}>The AI coding agent you talk to.</Text>
      </View>

      <View style={styles.form}>
        <Pressable
          onPress={google}
          disabled={busy !== null}
          style={({ pressed }) => [styles.googleBtn, pressed && styles.pressed]}
        >
          {busy === 'google' ? (
            <ActivityIndicator color="#0c0b09" />
          ) : (
            <Text style={styles.googleText}>Continue with Google</Text>
          )}
        </Pressable>

        <View style={styles.divider}>
          <View style={styles.line} />
          <Text style={styles.or}>or</Text>
          <View style={styles.line} />
        </View>

        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          placeholderTextColor="rgba(255,255,255,0.35)"
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          style={styles.input}
        />
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor="rgba(255,255,255,0.35)"
          secureTextEntry
          style={styles.input}
        />
        <Pressable
          onPress={emailLogin}
          disabled={busy !== null || !email || !password}
          style={({ pressed }) => [
            styles.emailBtn,
            (!email || !password) && styles.emailBtnDisabled,
            pressed && styles.pressed,
          ]}
        >
          {busy === 'email' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.emailText}>Log in</Text>
          )}
        </Pressable>

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0b09', paddingHorizontal: 24, justifyContent: 'center' },
  hero: { alignItems: 'center', marginBottom: 40 },
  orb: { fontSize: 56, marginBottom: 12 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700' },
  subtitle: { color: 'rgba(255,255,255,0.5)', fontSize: 15, marginTop: 6 },
  form: { gap: 12 },
  googleBtn: { height: 52, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  googleText: { color: '#0c0b09', fontSize: 16, fontWeight: '600' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 4 },
  line: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.15)' },
  or: { color: 'rgba(255,255,255,0.4)', fontSize: 13 },
  input: {
    height: 52,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.07)',
    paddingHorizontal: 16,
    color: '#fff',
    fontSize: 16,
  },
  emailBtn: { height: 52, borderRadius: 14, backgroundColor: '#3b82f6', alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  emailBtnDisabled: { opacity: 0.4 },
  emailText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  error: { color: '#f87171', fontSize: 14, textAlign: 'center', marginTop: 8 },
})
