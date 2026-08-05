// Session sharing (0.9.123) — COPY model, owner-pre-signed transfer.
//
// shareSession:   A exports one session from A's machine → uploads to the
//                 private `session-shares` bucket → pre-signs a long-lived URL
//                 → records a `shared_sessions` row addressed to B's email.
// listSharedWithMe: B reads rows addressed to their email (RLS-gated).
// importSharedSession: B downloads the snapshot (pre-signed URL) → POSTs it to
//                 B's OWN machine `/sessions/import` (slug-remapped into B's
//                 workspace) → marks the row imported.
//
// Nothing here touches existing session flows — it's purely additive. Both
// sides act only against THEIR OWN machine; Supabase Storage bridges the gap.

import { createSupabaseBrowser } from './supabase-browser'

const BUCKET = 'session-shares'
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export interface SharedSession {
  id: string
  owner_user_id: string
  owner_email: string
  recipient_email: string
  session_id: string
  session_title: string
  snapshot_path: string
  snapshot_url: string
  status: 'ready' | 'imported'
  created_at: string
}

type Result = { ok: true } | { ok: false; error: string }

const trimUrl = (u: string) => u.replace(/\/+$/, '')

/** A shares one session with B (by email). Exports from A's machine → Storage → row. */
export async function shareSession(opts: {
  agentUrl: string        // A's own machine URL (already resolved in the caller's context)
  sessionId: string
  title: string
  recipientEmail: string
}): Promise<Result> {
  const supabase = createSupabaseBrowser()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return { ok: false, error: 'You must be signed in to share.' }
  if (!opts.agentUrl || opts.agentUrl.startsWith('http://localhost')) {
    return { ok: false, error: 'No cloud machine detected — sharing needs your session on a cloud machine.' }
  }

  const recipient = opts.recipientEmail.trim().toLowerCase()
  if (!EMAIL_RE.test(recipient)) return { ok: false, error: 'Enter a valid email address.' }
  if (recipient === user.email.toLowerCase()) return { ok: false, error: "That's your own email." }

  // 1. Export the single session from A's machine.
  let blob: Blob
  try {
    const res = await fetch(`${trimUrl(opts.agentUrl)}/sessions/export-one?sessionId=${encodeURIComponent(opts.sessionId)}`)
    if (!res.ok) return { ok: false, error: `Couldn't export the session (${res.status}).` }
    blob = await res.blob()
    if (!blob.size) return { ok: false, error: 'Exported session was empty.' }
  } catch (e) {
    return { ok: false, error: `Couldn't reach your machine to export: ${(e as Error).message}` }
  }

  // 2. Upload to the private bucket under the owner's uid prefix (RLS: own prefix only).
  const objectPath = `${user.id}/${crypto.randomUUID()}.tar.gz`
  const up = await supabase.storage.from(BUCKET).upload(objectPath, blob, { contentType: 'application/gzip', upsert: false })
  if (up.error) return { ok: false, error: `Upload failed: ${up.error.message}` }

  // 3. Owner pre-signs a long-lived download URL (their RLS lets them sign own objects).
  const signed = await supabase.storage.from(BUCKET).createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS)
  if (signed.error || !signed.data?.signedUrl) {
    return { ok: false, error: `Couldn't create the share link: ${signed.error?.message ?? 'unknown'}` }
  }

  // 4. Record the share (RLS: owner insert own).
  const ins = await supabase.from('shared_sessions').insert({
    owner_user_id: user.id,
    owner_email: user.email,
    recipient_email: recipient,
    session_id: opts.sessionId,
    session_title: (opts.title || 'Shared session').slice(0, 300),
    snapshot_path: objectPath,
    snapshot_url: signed.data.signedUrl,
    status: 'ready',
  })
  if (ins.error) return { ok: false, error: `Couldn't save the share: ${ins.error.message}` }
  return { ok: true }
}

/** B: sessions shared with me that I haven't imported yet.
 *  Must filter to recipient-only: RLS also grants owners SELECT on their own
 *  rows (owner_all policy), so without the explicit recipient_email filter +
 *  excluding my own shares, "Shared with me" would wrongly list the shares I
 *  SENT. (Caught in visual QA 2026-08-05.) */
export async function listSharedWithMe(): Promise<SharedSession[]> {
  const supabase = createSupabaseBrowser()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return []
  const { data, error } = await supabase
    .from('shared_sessions')
    .select('*')
    .eq('status', 'ready')
    .eq('recipient_email', user.email.toLowerCase())
    .neq('owner_user_id', user.id)
    .order('created_at', { ascending: false })
  if (error) { console.error('[session-sharing] listSharedWithMe:', error.message); return [] }
  return (data ?? []) as SharedSession[]
}

/** B: import a shared session onto B's OWN machine, then mark it imported. */
export async function importSharedSession(opts: {
  share: SharedSession
  agentUrl: string        // B's own machine URL
}): Promise<Result> {
  const supabase = createSupabaseBrowser()
  if (!opts.agentUrl || opts.agentUrl.startsWith('http://localhost')) {
    return { ok: false, error: 'No cloud machine detected — connect one first, then add the shared session.' }
  }
  // 1. Download the snapshot (owner-pre-signed URL).
  let blob: Blob
  try {
    const res = await fetch(opts.share.snapshot_url)
    if (!res.ok) return { ok: false, error: `Download failed (${res.status}) — the share link may have expired.` }
    blob = await res.blob()
  } catch (e) {
    return { ok: false, error: `Download failed: ${(e as Error).message}` }
  }
  // 2. Import onto B's machine (slug-remaps into B's own workspace).
  try {
    const res = await fetch(`${trimUrl(opts.agentUrl)}/sessions/import`, { method: 'POST', body: blob })
    if (!res.ok) return { ok: false, error: `Import failed (${res.status}).` }
  } catch (e) {
    return { ok: false, error: `Couldn't reach your machine to import: ${(e as Error).message}` }
  }
  // 3. Mark imported (best-effort; RLS: recipient update own).
  const upd = await supabase.from('shared_sessions').update({ status: 'imported' }).eq('id', opts.share.id)
  if (upd.error) console.warn('[session-sharing] mark imported failed:', upd.error.message)
  return { ok: true }
}
