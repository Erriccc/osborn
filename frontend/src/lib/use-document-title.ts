'use client'

import { useEffect } from 'react'
import { formatDocumentTitle } from './document-title'

/** Set the tab title from a client page ('Dashboard' -> 'Dashboard · Voice
 *  Native'). Server pages should export `metadata.title` instead; the root
 *  layout's template formats those the same way. Pass null/'' to leave the
 *  title alone (e.g. while data loads). */
export function useDocumentTitle(page: string | null | undefined) {
  useEffect(() => {
    if (!page || typeof document === 'undefined') return
    document.title = formatDocumentTitle(page)
  }, [page])
}
