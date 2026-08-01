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
  title: 'Osborn - Voice AI Research Assistant',
  description: 'Voice-native AI research assistant powered by Claude',
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
