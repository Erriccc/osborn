import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/supabase-anon'

/**
 * Robots. Allow the public surface ('/' and the /p/... pages), disallow all
 * private/app routes. The public article pages live under /p and are not
 * disallowed.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/dashboard', '/chat', '/library', '/login', '/api/', '/auth/'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
