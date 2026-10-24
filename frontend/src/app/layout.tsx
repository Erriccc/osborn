import type { Metadata, Viewport } from 'next'
import { Fraunces, Instrument_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'

// "Warm Oracle" type system (2026-08 redesign): Fraunces — a wonky old-style
// variable serif — is the VOICE (display, greetings, assistant identity);
// Instrument Sans is the quiet UI body; JetBrains Mono handles machine truth
// (timestamps, tokens, tool names).
const display = Fraunces({ subsets: ['latin'], variable: '--font-display-loaded', weight: ['400', '500', '600', '700'], style: ['normal', 'italic'] })
const sans = Instrument_Sans({ subsets: ['latin'], variable: '--font-sans-loaded', weight: ['400', '500', '600', '700'] })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono-loaded', weight: ['400', '500'] })

// Mobile/PWA (2026-10-24 mobile branch): viewportFit=cover is the unlock for
// env(safe-area-inset-*) on notched iPhones — the chat composer's bottom inset
// padding existed but was inert without it. maximumScale is deliberately NOT
// set: zoom stays accessible; input auto-zoom is handled at the source instead
// (16px inputs on mobile, see P1.5 in docs/mobile-parity-map.md).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0c0b09',
}

export const metadata: Metadata = {
  metadataBase: new URL('https://www.voice-native.com'),
  title: {
    default: 'Voice Native — The AI Coding Agent You Talk To',
    template: '%s — Voice Native',
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
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
