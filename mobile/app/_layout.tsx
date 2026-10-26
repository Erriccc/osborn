import { registerGlobals } from '@livekit/react-native'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { AuthProvider, useAuth } from '../lib/auth'

// Required once before any LiveKit/WebRTC use — installs the WebRTC globals.
registerGlobals()

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
