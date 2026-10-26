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
 * Login — OTP-first (fully native: email → 6-digit code → in, no browser or
 * redirect). Google is the secondary option (needs the Supabase redirect
 * allow-list). This is the cleanest native auth: no password, no deep link.
 */
export default function Login() {
  const { sendEmailCode, verifyEmailCode, signInWithGoogle } = useAuth()
  const insets = useSafeAreaInsets()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'send' | 'verify' | 'google' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    if (!email.includes('@')) { setError('Enter a valid email'); return }
    setError(null); setBusy('send')
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    const { error } = await sendEmailCode(email)
    setBusy(null)
    if (error) setError(error)
    else setStep('code')
  }

  async function verify() {
    if (code.length < 6) return
    setError(null); setBusy('verify')
    const { error } = await verifyEmailCode(email, code)
    setBusy(null)
    if (error) setError(error)
    else Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
  }

  async function google() {
    setError(null); setBusy('google')
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    const { error } = await signInWithGoogle()
    setBusy(null)
    if (error && error !== 'cancelled') setError(error)
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

      {step === 'email' ? (
        <View style={styles.form}>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@email.com"
            placeholderTextColor="rgba(255,255,255,0.35)"
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            autoFocus
            style={styles.input}
          />
          <Pressable
            onPress={send}
            disabled={busy !== null}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
          >
            {busy === 'send' ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Email me a code</Text>}
          </Pressable>

          <View style={styles.divider}><View style={styles.line} /><Text style={styles.or}>or</Text><View style={styles.line} /></View>

          <Pressable
            onPress={google}
            disabled={busy !== null}
            style={({ pressed }) => [styles.googleBtn, pressed && styles.pressed]}
          >
            {busy === 'google' ? <ActivityIndicator color="#0c0b09" /> : <Text style={styles.googleText}>Continue with Google</Text>}
          </Pressable>
        </View>
      ) : (
        <View style={styles.form}>
          <Text style={styles.codeLabel}>Enter the 6-digit code sent to{'\n'}<Text style={styles.codeEmail}>{email}</Text></Text>
          <TextInput
            value={code}
            onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
            placeholder="______"
            placeholderTextColor="rgba(255,255,255,0.25)"
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            autoFocus
            style={styles.codeInput}
          />
          <Pressable
            onPress={verify}
            disabled={busy !== null || code.length < 6}
            style={({ pressed }) => [styles.primary, code.length < 6 && styles.disabled, pressed && styles.pressed]}
          >
            {busy === 'verify' ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Verify</Text>}
          </Pressable>
          <Pressable onPress={() => { setStep('email'); setCode(''); setError(null) }}>
            <Text style={styles.back}>Use a different email</Text>
          </Pressable>
        </View>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
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
  input: { height: 52, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.07)', paddingHorizontal: 16, color: '#fff', fontSize: 16 },
  primary: { height: 52, borderRadius: 14, backgroundColor: '#3b82f6', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 4 },
  line: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.15)' },
  or: { color: 'rgba(255,255,255,0.4)', fontSize: 13 },
  googleBtn: { height: 52, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  googleText: { color: '#0c0b09', fontSize: 16, fontWeight: '600' },
  codeLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 15, textAlign: 'center', lineHeight: 22 },
  codeEmail: { color: '#fff', fontWeight: '600' },
  codeInput: { height: 64, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.07)', color: '#fff', fontSize: 32, fontWeight: '700', textAlign: 'center', letterSpacing: 8 },
  back: { color: 'rgba(255,255,255,0.5)', fontSize: 14, textAlign: 'center', marginTop: 4 },
  pressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  error: { color: '#f87171', fontSize: 14, textAlign: 'center', marginTop: 16 },
})
