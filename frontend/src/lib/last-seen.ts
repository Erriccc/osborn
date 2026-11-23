import type { SupabaseClient } from '@supabase/supabase-js'

/** Record activity on the user's machine (the admin "Last active" reads instances.last_seen). Never awaited: a failed write must not slow or fail the request. */
export function touchLastSeen(client: SupabaseClient, userId: string): void {
  try {
    client.from('instances').update({ last_seen: new Date().toISOString() }).eq('user_id', userId).then(({ error }) => { if (error) console.warn(`[last-seen] write failed for ${userId}: ${error.message}`) }, () => {})
  } catch (e) {
    console.warn(`[last-seen] write failed for ${userId}: ${(e as Error).message}`)
  }
}
