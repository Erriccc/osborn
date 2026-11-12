'use client'

import { useState } from 'react'

/**
 * Copy-to-clipboard button for the marketing routes.
 *
 * The only interactive bit of an otherwise static page, so it is its own client
 * component: MarketingShell is documented "pure server component — no client
 * JS", and a `'use client'` page would pull the shell and MarketingNavAuth into
 * that route's client bundle.
 */
export default function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        try { await navigator.clipboard.writeText(text) } catch { return }
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
      className={className}
    >
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  )
}
