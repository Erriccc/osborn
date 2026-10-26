import type { Session } from '@supabase/supabase-js'
import { makeRedirectUri } from 'expo-auth-session'
import * as WebBrowser from 'expo-web-browser'
import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabase'

// Finish any auth session that was left open (recommended by expo-web-browser).
WebBrowser.maybeCompleteAuthSession()

// Native deep-link the OAuth provider redirects back to. Registered in app.json
// (scheme: voicenative) AND must be in Supabase's redirect allow-list.
const redirectTo = makeRedirectUri({ scheme: 'voicenative', path: 'auth/callback' })

type AuthState = {
  session: Session | null
  loading: boolean
  signInWithGoogle: () => Promise<{ error?: string }>
  signInWithEmail: (email: string, password: string) => Promise<{ error?: string }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  async function signInWithGoogle(): Promise<{ error?: string }> {
    // Google blocks OAuth inside embedded webviews — but openAuthSessionAsync
    // uses ASWebAuthenticationSession (a real Safari sheet), which Google
    // allows. This is the whole reason native fixes the login the shell couldn't.
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    })
    if (error || !data?.url) return { error: error?.message ?? 'no auth url' }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo)
    if (result.type !== 'success') return { error: 'cancelled' }

    // Supabase returns tokens in the URL fragment: #access_token=…&refresh_token=…
    const fragment = result.url.split('#')[1] ?? ''
    const params = new URLSearchParams(fragment)
    const access_token = params.get('access_token')
    const refresh_token = params.get('refresh_token')
    if (!access_token || !refresh_token) return { error: 'no tokens in callback' }

    const { error: setErr } = await supabase.auth.setSession({ access_token, refresh_token })
    return setErr ? { error: setErr.message } : {}
  }

  async function signInWithEmail(email: string, password: string): Promise<{ error?: string }> {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return error ? { error: error.message } : {}
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ session, loading, signInWithGoogle, signInWithEmail, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
