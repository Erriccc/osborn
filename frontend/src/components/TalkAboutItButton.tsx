'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import { buildSeededChatUrl, talkAboutSeed } from '@/lib/seed-chat'

/**
 * Public-page CTA. On mount it records a view; on click it seeds a chat with
 * the content and (if signed in) drops the visitor into a fresh session that
 * auto-sends the seed — otherwise it routes to sign-in. No new API: reuses the
 * /chat flow + the seed-prompt mechanism.
 */
export default function TalkAboutItButton({
  itemId,
  title,
  hook,
  body,
}: {
  itemId: string
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
      router.push(buildSeededChatUrl(talkAboutSeed({ title, hook, body })))
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
        <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
      </svg>
      {busy ? 'Opening…' : 'Talk about it'}
    </button>
  )
}
