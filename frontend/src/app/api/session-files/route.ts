import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * GET /api/session-files?sessionId=<id> — list every artifact this user has in
 * Supabase Storage for a given session, so the Files explorer can rehydrate on
 * session resume.
 *
 * WHY THIS EXISTS
 * ----------------
 * Session artifacts are uploaded to the `osborn-storage` bucket by the agent
 * via POST /api/upload at the ownership-scoped path:
 *
 *   {userId}/{sessionId}/{folder}/{fileName}
 *
 * Until now, the ONLY thing that repopulated the explorer on resume was the
 * agent's `listWorkspaceArtifacts()`, which scans the agent's LOCAL disk. On a
 * fresh cloud machine (or any reconnect where the working dir was recycled),
 * that local scan returns few/no files — so a session that produced 5–10 files
 * came back looking empty. The durable copies in the bucket were never listed.
 *
 * This route makes the bucket the source of truth: it authenticates the caller
 * via the Supabase session cookie, derives the SAME path prefix the uploader
 * used, and walks it — recursively (Storage `.list()` only returns immediate
 * children) and with pagination (Storage caps a single `.list()` page at 100
 * entries) — so it returns EVERYTHING, not just the first folder's first 100.
 *
 * Returns `{ files: [{ fileName, storagePath, url, type, isImage, size,
 * updatedAt }] }`. The public URL is stable (uploader uses upsert on a fixed
 * key), so the explorer can render/open each file directly with no agent round
 * trip.
 */

const BUCKET = 'osborn-storage'
const PAGE = 100 // Supabase Storage list() hard-caps a page at 100 entries.

// Mirror the uploader's sanitization EXACTLY (see api/upload/route.ts) so the
// prefix we walk matches the keys that were written. Any drift here silently
// lists the wrong folder and the explorer looks empty again.
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 128)
const safeSeg = (s: string) => safe(s).replace(/\./g, '') // dots not allowed in id segments

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

function classify(fileName: string): { type: string; isImage: boolean } {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  if (IMAGE_EXTS.includes(ext)) return { type: 'image', isImage: true }
  if (ext === 'html' || ext === 'htm' || ext === 'svg') return { type: 'html', isImage: false }
  if (ext === 'md' || ext === 'markdown') return { type: 'notes', isImage: false }
  if (ext === 'txt') return { type: 'notes', isImage: false }
  return { type: 'other', isImage: false }
}

interface StorageEntry {
  name: string
  id: string | null
  updated_at?: string | null
  created_at?: string | null
  metadata?: { size?: number; mimetype?: string; lastModified?: string } | null
}

export async function GET(req: NextRequest) {
  const sessionIdRaw = req.nextUrl.searchParams.get('sessionId') || ''
  if (!sessionIdRaw) {
    return NextResponse.json({ success: false, error: 'Missing sessionId' }, { status: 400 })
  }

  let supabase
  try {
    supabase = await createSupabaseServer()
  } catch {
    return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 })
  }

  // Ownership prefix. Authenticated users store under {userId}/{sessionId}/...;
  // guests (no cookie/session) store under {sessionId}/... — match whichever
  // applies so both cases rehydrate correctly.
  let userId = ''
  try {
    const { data } = await supabase.auth.getUser()
    if (data.user) userId = data.user.id
  } catch {
    // proceed as guest
  }

  const safeUserId = safeSeg(userId)
  const safeSessionId = safeSeg(sessionIdRaw)
  const rootParts: string[] = []
  if (safeUserId) rootParts.push(safeUserId)
  rootParts.push(safeSessionId)
  const root = rootParts.join('/')

  // Breadth-first walk with per-folder pagination. A folder entry is any
  // result with `id === null` (Storage's convention for a prefix vs. an
  // object). We cap total depth/entries defensively to avoid runaway walks.
  const files: Array<StorageEntry & { fullPath: string }> = []
  const queue: string[] = [root]
  let guard = 0

  try {
    while (queue.length > 0 && guard < 5000) {
      const prefix = queue.shift() as string
      let offset = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        guard++
        const { data, error } = await supabase.storage
          .from(BUCKET)
          .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
        if (error) {
          console.error('[session-files] list error at', prefix, error.message)
          break
        }
        const entries = (data || []) as StorageEntry[]
        for (const e of entries) {
          const fullPath = `${prefix}/${e.name}`
          if (e.id === null) {
            // Folder — descend.
            queue.push(fullPath)
          } else {
            files.push({ ...e, fullPath })
          }
        }
        if (entries.length < PAGE) break
        offset += PAGE
      }
    }
  } catch (err) {
    return NextResponse.json(
      { success: false, error: `List failed: ${(err as Error).message}` },
      { status: 500 },
    )
  }

  const out = files.map((f) => {
    const { type, isImage } = classify(f.name)
    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(f.fullPath)
    return {
      fileName: f.name,
      storagePath: f.fullPath,
      url: urlData.publicUrl,
      type,
      isImage,
      size: f.metadata?.size ?? 0,
      updatedAt: f.updated_at || f.created_at || f.metadata?.lastModified || null,
    }
  })

  return NextResponse.json({ success: true, sessionId: sessionIdRaw, count: out.length, files: out })
}
