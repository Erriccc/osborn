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
  appId: 'com.voicenative.app',
  appName: 'Voice Native',
  webDir: 'www',
  server: {
    // Cold-launch straight into the APP, not the desktop-first marketing
    // homepage (/). /dashboard is the post-login home; an unauthenticated
    // WKWebView redirects it to /login. Either way the shell never shows the
    // marketing page, which is where the "it's just a bookmark" feel came from.
    url: 'https://www.voice-native.com/dashboard',
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
    // MUST be true: the web pages rely on normal page scroll. scrollEnabled:
    // false froze the whole UI (unscrollable + taps swallowed). Rubber-band is
    // tamed in CSS (overscroll-behavior: none, globals.css standalone block).
    scrollEnabled: true,
    // 'never' — the web content owns its safe-area insets via env(safe-area-*)
    // padding, so the webview must NOT also inset (double-padding / status-bar
    // collision came from the webview and CSS fighting over the same space).
    contentInset: 'never',
  },
}

export default config
