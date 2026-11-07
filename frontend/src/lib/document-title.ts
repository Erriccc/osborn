// Tab-title formatting shared by the root metadata template ('%s · Voice
// Native', app/layout.tsx) and the client-side useDocumentTitle hook, so client
// pages (which can't export `metadata`) read the same as server pages.
// Bug ab31e017: every tab showed the same title.

export const SITE_NAME = 'Voice Native'
export const TITLE_SEPARATOR = ' · '

/** 'Dashboard' -> 'Dashboard · Voice Native'. Blank / whitespace-only input
 *  falls back to the bare site name; a title that already ends with the suffix
 *  is not doubled. Whitespace is collapsed. */
export function formatDocumentTitle(page: string | null | undefined): string {
  const clean = (page ?? '').replace(/\s+/g, ' ').trim()
  if (!clean || clean === SITE_NAME) return SITE_NAME
  const suffix = `${TITLE_SEPARATOR}${SITE_NAME}`
  if (clean.endsWith(suffix)) return clean
  return `${clean}${suffix}`
}
