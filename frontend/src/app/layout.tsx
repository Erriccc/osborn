import type { Metadata } from 'next'
import { DM_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'

const sans = DM_Sans({ subsets: ['latin'], variable: '--font-sans-loaded', weight: ['400', '500', '600', '700'] })
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
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
