import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Osborn - Voice AI Coding Assistant',
  description: 'Voice-enabled coding assistant powered by Claude',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
