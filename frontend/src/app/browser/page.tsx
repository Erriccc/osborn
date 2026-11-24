'use client'

// In-app Browser page (issue #51) — the shareable home for watching/driving the
// browser-screen-recorder engine, replacing the raw Fly URL. Auth-gated by
// middleware. The link to this page is the per-run shareable link (v1: one engine;
// per-session isolation is a documented follow-up in docs/browser-panel.md).
import { BrowserPanel } from '@/components/BrowserPanel'
import { useDocumentTitle } from '@/lib/use-document-title'

export default function BrowserPage() {
  useDocumentTitle('Browser')
  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-6">
      <div className="mx-auto w-full max-w-3xl">
        <BrowserPanel />
      </div>
    </main>
  )
}
