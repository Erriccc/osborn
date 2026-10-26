import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config'

/**
 * Supabase client for the native app. Session persists in AsyncStorage (not
 * cookies — there's no browser), auto-refreshes, and detectSessionInUrl is off
 * because we parse the OAuth redirect ourselves (expo-web-browser hands us the
 * callback URL; see lib/auth.tsx).
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})
