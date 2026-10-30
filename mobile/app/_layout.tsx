import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { AuthProvider, useAuth } from '../lib/auth'

// NOTE: registerGlobals() is NOT called here. Importing @livekit/react-native at
// the root pulls the WebRTC native module into the app-LAUNCH path, which
// crashed on open. It's deferred to the voice screen (lazy route) so launch
// never touches WebRTC — login/dashboard/library/settings don't need it.

/**
 * Root layout — wraps the app in the AuthProvider and gates on the session:
 * no session → /login, session → the (tabs) app. The native stack transitions
 * between them are real iOS pushes.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  )
}

function RootNavigator() {
  const { session, loading } = useAuth()
  const segments = useSegments()
  const router = useRouter()

  useEffect(() => {
    if (loading) return
    const onLogin = segments[0] === 'login'
    if (!session && !onLogin) router.replace('/login')
    else if (session && onLogin) router.replace('/')
  }, [session, loading, segments, router])

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="login" />
      <Stack.Screen name="voice" options={{ presentation: 'fullScreenModal' }} />
    </Stack>
  )
}
