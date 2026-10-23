import type { Metadata } from 'next'
import { Fraunces, Instrument_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'

// "Warm Oracle" type system (2026-08 redesign): Fraunces — a wonky old-style
// variable serif — is the VOICE (display, greetings, assistant identity);
// Instrument Sans is the quiet UI body; JetBrains Mono handles machine truth
// (timestamps, tokens, tool names).
const display = Fraunces({ subsets: ['latin'], variable: '--font-display-loaded', weight: ['400', '500', '600', '700'], style: ['normal', 'italic'] })
const sans = Instrument_Sans({ subsets: ['latin'], variable: '--font-sans-loaded', weight: ['400', '500', '600', '700'] })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono-loaded', weight: ['400', '500'] })

export const metadata: Metadata = {
  metadataBase: new URL('https://www.voice-native.com'),
  title: {
    default: 'Voice Native — The AI Coding Agent You Talk To',
    template: '%s — Voice Native',
  },
  description: 'Talk to Voice Native and it writes, runs, and debugs code on your own machine. A team of Claude sub-agents, persistent memory, live activity.',
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
