import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Voice Native iOS shell — REMOTE-URL mode.
 *
 * The Next.js frontend cannot be bundled (18 API route handlers + Supabase SSR
 * middleware ≠ `output: 'export'`), so the WKWebView loads the Railway site
 * directly: deploys go live instantly, no app-review cycle for web changes.
 * The native side exists for what a PWA can't do: background audio
 * (UIBackgroundModes: audio), the AVAudioSession voiceChat fix (AppDelegate),
 * haptics/share via the Capacitor bridge, and eventually APNs + TestFlight.
 *
 * When the Apple Developer account lands, flip to signed builds via the
 * APP_STORE_CONNECT_* secrets documented in docs/README-mobile.md.
 */
const config: CapacitorConfig = {
  appId: 'com.audos.voicenative',
  appName: 'Voice Native',
  webDir: 'www',
  server: {
    url: 'https://www.voice-native.com',
    // Allow Supabase OAuth redirects + LiveKit ICE to open in external
    // Safari until the deep-link flow (G-OAUTH) replaces them.
    allowNavigation: [
      'voice-native.com',
      '*.voice-native.com',
      '*.supabase.co',
      'auth.google.com',
      'accounts.google.com',
      'github.com',
      'livekit.cloud',
      '*.livekit.cloud',
    ],
  },
  ios: {
    // WKWebView servlets scroll like native — the app itself doesn't scroll
    // (the web content manages its own panes).
    scrollEnabled: false,
    contentInset: 'always',
  },
}

export default config
