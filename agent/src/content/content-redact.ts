/**
 * content-redact.ts — the ONE redaction gate for everything Stage A sends out:
 * model prompts (OpenRouter), research queries (HN / GitHub), and the
 * content_ingest payload (Supabase).
 *
 * scrub(s) = redactSecrets(clientRedactor.redact(s), { assistant: true }),
 * i.e. the project denylist + default client patterns (lens-redact.ts), then
 * every secret shape incl. the high-entropy fallback (transcript-sanitizer.ts).
 * Idempotent: already-redacted text comes back unchanged.
 * Never throws. A broken denylist file falls back to the default patterns.
 */

import { loadClientRedactor, type ClientRedactor } from './lens-redact.js'
import { redactSecrets } from './transcript-sanitizer.js'

export interface ContentScrubber {
  /** Redact one string. */
  scrub: (s: string) => string
  /** Deep-redact every string inside a JSON-like value (objects, arrays). Returns a copy. */
  scrubDeep: <T>(v: T) => T
  /** True when the text would change under scrub(), i.e. a secret or client term is still in it. */
  isDirty: (s: string) => boolean
  /** Denylist terms loaded (for logs; never the terms themselves). */
  terms: number
}

const passthrough: ClientRedactor = { rules: [], terms: 0, source: null, redact: (s: string) => s }

export function makeScrubber(projectDir: string | null): ContentScrubber {
  let red: ClientRedactor = passthrough
  try {
    red = loadClientRedactor(projectDir)
  } catch {
    /* defaults only */
  }
  const scrub = (s: string): string => {
    if (typeof s !== 'string' || !s) return s
    try {
      return redactSecrets(red.redact(s), { assistant: true })
    } catch {
      // Fail CLOSED for outbound text: if redaction itself breaks, send nothing of it.
      return '[redacted]'
    }
  }
  const scrubDeep = <T>(v: T): T => deep(v, scrub) as T
  return { scrub, scrubDeep, isDirty: s => scrub(s) !== s, terms: red.terms }
}

function deep(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map(x => deep(x, f))
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = deep(x, f)
    return o
  }
  return v
}
