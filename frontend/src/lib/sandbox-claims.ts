/**
 * sandbox-claims.ts — server-side ownership of instances.sandbox_id.
 *
 * instances.sandbox_id decides which Fly app / sprite a user controls
 * (/api/sandbox) and which LiveKit rooms they can mint tokens for (/api/token).
 * Before migration 012 a signed-in user could write any value into their own
 * row, so ownership must never be taken from the row alone:
 *
 *  - checkSandboxClaim() asks whether ANY OTHER user's row (or another user's
 *    deterministic legacy app name) also claims the id. It FAILS CLOSED: if the
 *    answer cannot be determined it returns 'unknown', which callers treat as
 *    "not yours".
 *  - claimSandboxForUser() is the only write path for sandbox_id. It calls the
 *    SECURITY DEFINER function public.set_instance_sandbox (migration 012),
 *    which writes only auth.uid()'s own row and refuses an id another row
 *    already claims.
 *
 * Both prefer the SECURITY DEFINER RPCs through the caller's own (RLS-scoped)
 * client, because SUPABASE_SERVICE_ROLE_KEY is not set on Railway. The
 * service-role key is only a fallback.
 *
 * DEPLOY ORDER: apply migration 012 BEFORE deploying this code. Without the
 * RPCs and without a service-role key the claim check returns 'unknown' and
 * users with a recorded sandbox_id are refused (fail closed).
 */
import { createClient } from '@supabase/supabase-js'

export type SandboxClaim = 'mine' | 'disputed' | 'unknown'

// Structural type so both the SSR client and test doubles fit.
type RpcResult = { data: unknown; error: { message?: string; code?: string } | null }
interface MaybeRpcClient {
  rpc?: (fn: string, args?: Record<string, unknown>) => PromiseLike<RpcResult>
}

function hasRpc(client: unknown): client is Required<MaybeRpcClient> {
  return !!client && typeof (client as MaybeRpcClient).rpc === 'function'
}

/** Postgres/PostgREST "function does not exist" (migration 012 not applied). */
function isMissingFunction(err: { code?: string } | null | undefined): boolean {
  return !!err && (err.code === 'PGRST202' || err.code === '42883')
}

/** Service-role client, or null when SUPABASE_SERVICE_ROLE_KEY is absent
 *  (it is not set on Railway — every caller must handle null). */
export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

/**
 * Is `sandboxId` claimed only by `userId`? 'disputed' = another user's row
 * also claims it (or it is another user's legacy app name, RPC path only).
 * 'unknown' = the check could not run; callers must treat it as not owned.
 */
export async function checkSandboxClaim(
  userClient: unknown,
  sandboxId: string,
  userId: string,
): Promise<SandboxClaim> {
  // 1) SECURITY DEFINER RPC through the caller's own session (works without
  //    the service-role key).
  if (hasRpc(userClient)) {
    try {
      const { data, error } = await userClient.rpc('sandbox_claimed_by_other', { p_sandbox_id: sandboxId })
      if (!error && typeof data === 'boolean') return data ? 'disputed' : 'mine'
      if (error && !isMissingFunction(error)) {
        console.warn(`[sandbox-claims] sandbox_claimed_by_other failed: ${error.message}`)
      }
    } catch (e) {
      console.warn(`[sandbox-claims] sandbox_claimed_by_other threw: ${(e as Error).message}`)
    }
  }

  // 2) Service-role fallback.
  const admin = serviceClient()
  if (!admin) {
    console.warn(`[sandbox-claims] cannot verify sandbox ${sandboxId} (no RPC, no service key); failing closed`)
    return 'unknown'
  }
  try {
    const { data, error } = await admin.from('instances').select('user_id').eq('sandbox_id', sandboxId)
    if (error || !Array.isArray(data)) return 'unknown'
    return (data as { user_id: string }[]).some((r) => r.user_id !== userId) ? 'disputed' : 'mine'
  } catch {
    return 'unknown'
  }
}

/** Fail-closed convenience: true unless the id is positively the caller's alone. */
export async function sandboxClaimedByAnotherUser(
  userClient: unknown,
  sandboxId: string,
  userId: string,
): Promise<boolean> {
  return (await checkSandboxClaim(userClient, sandboxId, userId)) !== 'mine'
}

/**
 * Record `sandboxId` on the caller's own instances row. The row must already
 * exist (upsert the other fields first, WITHOUT sandbox_id). Returns false
 * when the id is refused (claimed by someone else) or the write failed.
 * Only call this with an id the server itself obtained from the cloud
 * provider (createSandbox / findUserSandbox), never one from a request body.
 */
export async function claimSandboxForUser(
  userClient: unknown,
  sandboxId: string,
  userId: string,
): Promise<boolean> {
  if (hasRpc(userClient)) {
    try {
      const { data, error } = await userClient.rpc('set_instance_sandbox', { p_sandbox_id: sandboxId })
      if (!error) return data === true
      if (!isMissingFunction(error)) {
        console.warn(`[sandbox-claims] set_instance_sandbox failed: ${error.message}`)
        return false
      }
    } catch (e) {
      console.warn(`[sandbox-claims] set_instance_sandbox threw: ${(e as Error).message}`)
      return false
    }
  }

  // Pre-migration compatibility only (RPC missing): the column is still
  // client-writable then, so a direct write adds no new exposure, and the id
  // comes from the provider, not the client. Refuse only a positive conflict;
  // refusing on 'unknown' would orphan a just-created paid machine.
  if ((await checkSandboxClaim(userClient, sandboxId, userId)) === 'disputed') return false
  const admin = serviceClient()
  const client = (admin ?? userClient) as {
    from: (t: string) => { update: (v: Record<string, unknown>) => { eq: (c: string, v: string) => PromiseLike<{ error: unknown }> } }
  }
  try {
    const { error } = await client.from('instances').update({ sandbox_id: sandboxId }).eq('user_id', userId)
    return !error
  } catch {
    return false
  }
}
