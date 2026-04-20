'use client'

/**
 * Chat route layout.
 *
 * Wraps every page under /chat with the ChatSessionProvider. Next.js
 * App Router preserves layouts across page edits during Fast Refresh,
 * which is exactly what keeps the LiveKit WebRTC connection alive
 * when a dev edits chat/page.tsx or components/VoiceRoom.tsx.
 *
 * The Suspense boundary here is required because ChatSessionProvider
 * uses `useSearchParams`, which Next.js requires to be inside a
 * Suspense boundary in client components.
 */

import { Suspense } from 'react'
import { ChatSessionProvider } from '@/components/ChatSessionProvider'

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-[var(--background)] flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin" />
        </main>
      }
    >
      <ChatSessionProvider>{children}</ChatSessionProvider>
    </Suspense>
  )
}
