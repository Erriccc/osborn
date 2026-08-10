import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * POST /api/upload — server-side Supabase Storage upload for agent workspace files.
 *
 * This mirrors the browser-side `uploadFile()` in `lib/supabase.ts` that the
 * frontend uses for user attachments, but runs on the server so the agent can
 * call it without embedding Supabase credentials in the agent container.
 *
 * Why this exists: when the agent sends workspace artifacts (cv.md, reports,
 * resume.pdf, etc.) back to the frontend via the LiveKit data channel, the raw
 * file content blows through the WebRTC SCTP data channel limits (~256KB
 * theoretical, ~50KB practical under concurrent pressure). The publisher PC
 * enters a zombie state and every subsequent send fails with
 * "could not establish publisher connection: timeout". We hit this with a
 * 480KB evaluation PDF and a 110KB search index on session resume.
 *
 * By uploading to Supabase Storage and passing just the URL (~100 bytes) via
 * the data channel, file size becomes irrelevant — the frontend fetches the
 * content directly from Supabase on demand.
 *
 * Accepts multipart/form-data with a `file` field and optional `folder` field
 * (defaults to "artifacts"). Returns `{ success, url, fileName, size }`.
 *
 * Uses the same `NEXT_PUBLIC_SUPABASE_*` keys the frontend browser uses. The
 * anon key is safe to run server-side — the bucket's RLS policies are what
 * actually gate writes, and they already permit anon uploads.
 */
export async function POST(req: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json(
      { success: false, error: 'Supabase not configured' },
      { status: 503 },
    )
  }

  let file: File
  let folder: string
  let userId: string
  let sessionId: string
  try {
    const form = await req.formData()
    const fileField = form.get('file')
    // Duck-type instead of `instanceof File`: Node runtimes without the global
    // File class throw ReferenceError there, which broke every non-browser
    // client (curl/agents) with "File is not defined".
    if (!fileField || typeof fileField === 'string' || typeof (fileField as Blob).arrayBuffer !== 'function') {
      return NextResponse.json(
        { success: false, error: 'Missing `file` field in multipart form' },
        { status: 400 },
      )
    }
    file = fileField as File
    folder = (form.get('folder') as string) || 'artifacts'
    userId = (form.get('userId') as string) || ''
    sessionId = (form.get('sessionId') as string) || ''
  } catch (err) {
    return NextResponse.json(
      { success: false, error: `Failed to parse multipart form: ${(err as Error).message}` },
      { status: 400 },
    )
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey)

  // Build an ownership-scoped storage path.
  //
  //   {userId}/{sessionId}/{folder}/{fileName}
  //
  // Note the filename is the ORIGINAL name — no timestamp, no random suffix.
  // Combined with `upsert: true` below, every request for the same
  // (userId, sessionId, fileName) tuple produces the SAME storage key and
  // overwrites in place. The public URL is therefore stable across all
  // subsequent session resumes — the frontend sees one URL per file per
  // session, not a new one every time get_research_artifact fires.
  //
  // Before this change, every upload generated a `{timestamp}-{random}.ext`
  // filename, so reconnecting to a career-ops session created ~40 duplicate
  // copies of cv.md across two resume cycles, each at a different URL.
  // All orphaned, all still sitting in the bucket forever.
  //
  // RLS scoping: first path segment is userId, which makes
  // `auth.uid()::text = (storage.foldername(name))[1]` policies trivial.
  //
  // userId/sessionId are optional — unauthenticated guests still get a
  // writable path, just without the ownership prefix. Sanitize aggressively:
  // only allow characters that are safe in storage keys (letters, digits,
  // dash, underscore, dot) so a bad client can't inject `../` escapes.
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 128)
  const safeUserId = safe(userId).replace(/\./g, '') // dots not allowed in id segments
  const safeSessionId = safe(sessionId).replace(/\./g, '')
  const safeFileName = safe(file.name) || `unnamed-${Date.now()}.bin`

  const pathParts: string[] = []
  if (safeUserId) pathParts.push(safeUserId)
  if (safeSessionId) pathParts.push(safeSessionId)
  pathParts.push(folder, safeFileName)
  const storagePath = pathParts.join('/')

  const { error: uploadError } = await supabase.storage
    .from('osborn-storage')
    .upload(storagePath, file, {
      cacheControl: '3600',
      // upsert: true — overwrite the same storage key on repeat uploads of
      // the same file so URLs stay stable and the bucket doesn't accumulate
      // duplicates. The alternative (timestamped paths + upsert: false) was
      // creating ~20 duplicate copies per session resume.
      upsert: true,
    })

  if (uploadError) {
    console.error('[upload] Supabase upload failed:', uploadError)
    return NextResponse.json(
      { success: false, error: uploadError.message },
      { status: 500 },
    )
  }

  const { data: urlData } = supabase.storage
    .from('osborn-storage')
    .getPublicUrl(storagePath)

  return NextResponse.json({
    success: true,
    url: urlData.publicUrl,
    fileName: file.name,
    fileType: file.type,
    size: file.size,
    storagePath,
  })
}
