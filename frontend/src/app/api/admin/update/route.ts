import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin, AdminAuthError } from '@/lib/admin'
import {
  isMachinesConfigured,
  updateOsborn,
  resolveNewestSandboxImage,
  imageVersionFromRef,
  parseVersion,
} from '@/lib/machines'

/**
 * POST /api/admin/update — roll one user's machine to a newer osborn.
 *
 * Admin-only (same allowlist as /api/admin/users; the gate is server-side).
 * Body: { sandboxId, version? }. With no `version`, the target is the newest
 * version-tagged image that actually EXISTS in the sandbox registry
 * (resolveNewestSandboxImage, capped at npm `latest`) — never a just-published
 * npm version whose image has not been built yet, which would image-swap to a
 * missing tag and fail. An explicit `version` is an admin override and is used
 * as-is (updateOsborn reports an honest failure if its image is absent).
 *
 * This awaits the full ~1–2 min image-swap and returns its real outcome. It
 * calls the SAME updateOsborn the user-facing dashboard uses, resolving the
 * machine's OWNER (updateOsborn re-forwards that user's platform env) and
 * preserving their existing sync token. The response carries machine
 * bookkeeping only — never keys, secrets, or tokens.
 */
export async function POST(req: Request) {
  try {
    await requireAdmin()
  } catch (err) {
    const status = err instanceof AdminAuthError ? err.status : 403
    const message = err instanceof Error ? err.message : 'Admin access required'
    return NextResponse.json({ error: message }, { status })
  }

  if (!isMachinesConfigured()) {
    return NextResponse.json({ error: 'Machines backend not configured' }, { status: 500 })
  }

  let body: { sandboxId?: unknown; version?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const sandboxId = typeof body.sandboxId === 'string' ? body.sandboxId.trim() : ''
  if (!sandboxId) {
    return NextResponse.json({ error: 'sandboxId required' }, { status: 400 })
  }
  // An explicit version must be a plain x.y.z; reject junk before handing it to updateOsborn.
  let version: string | undefined
  if (body.version !== undefined && body.version !== null && body.version !== '') {
    if (typeof body.version !== 'string' || !parseVersion(body.version)) {
      return NextResponse.json({ error: 'version must be x.y.z' }, { status: 400 })
    }
    version = body.version.trim()
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    console.error('[admin/update] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured')
    return NextResponse.json({ error: 'Server not configured' }, { status: 500 })
  }
  const sb = createClient(url, serviceKey, { auth: { persistSession: false } })

  // Resolve the machine's owner (updateOsborn re-forwards THAT user's platform env) and pass
  // their canonical DB sync token — exactly as the user-facing update-osborn path does via
  // getSyncToken, so a rotated token propagates to the machine rather than keeping its stale
  // baked one. Keyed by sandbox_id.
  const { data: owner, error: ownerErr } = await sb
    .from('instances')
    .select('user_id, sync_token')
    .eq('sandbox_id', sandboxId)
    .maybeSingle()
  if (ownerErr) {
    console.error('[admin/update] owner lookup failed:', ownerErr.message)
    return NextResponse.json({ error: 'Could not resolve machine owner' }, { status: 500 })
  }
  if (!owner?.user_id) {
    return NextResponse.json({ error: 'No user owns that machine' }, { status: 404 })
  }

  // Default target: newest BUILT image version. If the registry can't be resolved,
  // imageVersionFromRef(:latest fallback) is null — DON'T fall through to updateOsborn's npm-latest
  // default, which could target an unbuilt tag; fail loudly instead so the roll is never a surprise.
  if (!version) {
    version = imageVersionFromRef(await resolveNewestSandboxImage()) ?? undefined
    if (!version) {
      return NextResponse.json(
        { error: 'Could not resolve the newest built version (registry unavailable) — retry, or pass an explicit version' },
        { status: 503 },
      )
    }
  }

  const syncToken = typeof owner.sync_token === 'string' ? owner.sync_token : undefined
  console.log(`[admin/update] rolling ${sandboxId} (owner ${owner.user_id}) -> ${version ?? 'latest'}`)
  const result = await updateOsborn(sandboxId, owner.user_id as string, version, syncToken)
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.log }, { status: 500 })
  }
  return NextResponse.json({ success: true, version: result.version, target: version ?? null })
}
