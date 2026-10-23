import { createClient } from '@supabase/supabase-js'

/**
 * Cookie-less anon Supabase client for PUBLIC pages.
 *
 * Unlike supabase-server.ts (which reads cookies() and therefore forces every
 * route that touches it into dynamic rendering), this client carries no auth
 * context at all — just the public URL + anon key. That keeps the public
 * library surface (/p/..., sitemap.ts) statically cacheable / ISR-friendly.
 *
 * SECURITY: only ever use this to read the `public_content` VIEW, which
 * exposes a safe, published-only column list (migration 007). Never read
 * `content_items` through this client.
 */
export function createSupabaseAnon() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  // Return null when env is absent (e.g. a build with no Supabase vars) instead
  // of throwing "supabaseUrl is required" and crashing the build. Callers treat
  // null as "no data" so pages fall back to on-demand ISR rather than failing.
  if (!url || !key) return null
  // Pin the `public` schema explicitly. This project's PostgREST exposes many
  // schemas with `storage` listed FIRST, so an unqualified request can default
  // to the wrong schema and fail with "relation storage.public_content does not
  // exist". Setting db.schema sends Accept-Profile: public on every request.
  return createClient(url, key, {
    db: { schema: 'public' },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** The canonical public base URL. metadataBase is set in layout; we still emit
 *  absolute canonicals explicitly everywhere. */
export const SITE_URL = 'https://www.voice-native.com'

/** Shape of a published row as exposed by the public_content view. */
export interface PublicContent {
  id: string
  type: string | null
  title: string | null
  hook: string | null
  body: string | null
  transcript: string | null
  slug: string | null
  poster_path: string | null
  published_at: string | null
  handle: string | null
}
