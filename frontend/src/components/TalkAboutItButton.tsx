'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import { buildSeededChatUrl, reproduceTaskSeed } from '@/lib/seed-chat'

/**
 * Public-page CTA to REPRODUCE the task. A published piece is a finished task;
 * clicking drops a signed-in visitor into a fresh Voice Native session seeded
 * to help them produce their OWN version (not just discuss it) — otherwise it
 * routes to sign-in. No new API: reuses the /chat flow + seed-prompt mechanism.
 */
export default function TalkAboutItButton({
  itemId,
  type,
  title,
  hook,
  body,
}: {
  itemId: string
  type?: string | null
  title: string | null
  hook: string | null
  body: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const viewed = useRef(false)

  useEffect(() => {
    if (viewed.current) return
    viewed.current = true
    try {
      createSupabaseBrowser().rpc('content_track', { p_item_id: itemId, p_event: 'view' }).then(() => {}, () => {})
    } catch { /* anon tracking is best-effort */ }
  }, [itemId])

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    const sb = createSupabaseBrowser()
    try { sb.rpc('content_track', { p_item_id: itemId, p_event: 'talk' }).then(() => {}, () => {}) } catch {}
    let signedIn = false
    try {
      const { data } = await sb.auth.getSession()
      signedIn = !!data.session
    } catch { /* treat as signed-out */ }
    if (signedIn) {
      router.push(buildSeededChatUrl(reproduceTaskSeed({ type, title, hook, body })))
    } else {
      router.push('/login')
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] text-[var(--background)] px-4 py-2.5 text-[14px] font-semibold hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-60"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 3v4M3 5h4M6 17v4m-2-2h4" /><path d="M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5L13 3z" />
      </svg>
      {busy ? 'Opening…' : 'Make your own version'}
    </button>
  )
}
