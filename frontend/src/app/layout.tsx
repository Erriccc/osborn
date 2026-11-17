import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import './globals.css'
import { THEME_INIT_SCRIPT, THEME_COLOR } from '@/lib/theme'
import { ThemeSync } from '@/lib/use-theme'

// "Warm Oracle" type system (2026-08 redesign): Fraunces — a wonky old-style
// variable serif — is the VOICE (display, greetings, assistant identity);
// Instrument Sans is the quiet UI body; JetBrains Mono handles machine truth
// (timestamps, tokens, tool names).
// Self-hosted (src/app/fonts, OFL — see README there): next/font/google fetched
// fonts.googleapis.com at build time and broke a Railway build when Google
// returned an unexpected URL. Same latin subset, weights, styles and variables.
const display = localFont({
  src: [
    { path: './fonts/Fraunces-latin-wght.woff2', weight: '400 700', style: 'normal' },
    { path: './fonts/Fraunces-Italic-latin-wght.woff2', weight: '400 700', style: 'italic' },
  ],
  variable: '--font-display-loaded',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
})
const sans = localFont({
  src: [{ path: './fonts/InstrumentSans-latin-wght.woff2', weight: '400 700', style: 'normal' }],
  variable: '--font-sans-loaded',
  display: 'swap',
})
const mono = localFont({
  src: [{ path: './fonts/JetBrainsMono-latin-wght.woff2', weight: '400 500', style: 'normal' }],
  variable: '--font-mono-loaded',
  display: 'swap',
})

// Mobile/PWA (2026-10-24 mobile branch): viewportFit=cover is the unlock for
// env(safe-area-inset-*) on notched iPhones — the chat composer's bottom inset
// padding existed but was inert without it. maximumScale is deliberately NOT
// set: zoom stays accessible; input auto-zoom is handled at the source instead
// (16px inputs on mobile, see P1.5 in docs/mobile-parity-map.md).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Follows the system until the inline theme script applies the saved choice.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: THEME_COLOR.dark },
    { media: '(prefers-color-scheme: light)', color: THEME_COLOR.light },
  ],
}

export const metadata: Metadata = {
  metadataBase: new URL('https://www.voice-native.com'),
  title: {
    default: 'Voice Native — The AI Coding Agent You Talk To',
    template: '%s · Voice Native',
  },
  description: 'Talk to Voice Native and it writes, runs, and debugs code on your own machine. A team of Claude sub-agents, persistent memory, live activity.',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Voice Native',
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  openGraph: {
    type: 'website',
    siteName: 'Voice Native',
    url: 'https://www.voice-native.com',
    title: 'Voice Native — Talk to it. It ships.',
    description: 'A voice-native AI engineer that writes and runs code on your machine, with a team of Claude sub-agents you watch work in real time.',
  },
  twitter: { card: 'summary_large_image' },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    // data-theme is set before first paint by the inline script (no flash);
    // suppressHydrationWarning because the server cannot know it.
    <html lang="en" suppressHydrationWarning className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeSync />
        {children}
      </body>
    </html>
  )
}
