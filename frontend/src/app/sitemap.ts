import type { MetadataRoute } from 'next'
import { createSupabaseAnon, SITE_URL } from '@/lib/supabase-anon'

export const revalidate = 3600

/**
 * Sitemap. Lists the public landing + all PUBLISHED items (via the safe
 * public_content view). A DB hiccup must never 500 the sitemap, so the DB read
 * is wrapped in try/catch and we always return at least the static routes.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, priority: 1.0, changeFrequency: 'daily' },
    { url: `${SITE_URL}/login`, priority: 0.3, changeFrequency: 'monthly' },
  ]

  try {
    const supabase = createSupabaseAnon()
    if (!supabase) return staticRoutes
    const { data, error } = await supabase
      .from('public_content')
      .select('handle, slug, published_at')
    if (error || !data) return staticRoutes

    const itemRoutes: MetadataRoute.Sitemap = data
      .filter((r): r is { handle: string; slug: string; published_at: string | null } => !!r.handle && !!r.slug)
      .map(r => ({
        url: `${SITE_URL}/p/${encodeURIComponent(r.handle)}/${r.slug}`,
        lastModified: r.published_at ? new Date(r.published_at) : undefined,
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      }))

    return [...staticRoutes, ...itemRoutes]
  } catch {
    return staticRoutes
  }
}
