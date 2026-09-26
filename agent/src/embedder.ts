/**
 * embedder.ts — Text→vector embedder for the semantic (vec) layer of session-store.
 *
 * CLOUD-FIRST (OpenRouter, OpenAI-compatible embeddings endpoint).
 * Previously this ran all-MiniLM-L6-v2 locally via @xenova/transformers. That model
 * inference is CPU-bound and SYNCHRONOUS on the single Node thread — during a large
 * backfill it monopolized the event loop and starved voice, the SDK's time-boxed
 * UserPromptSubmit hook, and fast-brain. Embedding over the network is async I/O:
 * `await fetch(...)` frees the thread while the request is in flight, so the whole
 * class of event-loop starvation from embedding is gone.
 *
 * DESIGN FOR RELIABILITY:
 *   • Best-effort — if the key is missing or a request fails/times out, the returned
 *     embedder yields null and the store runs keyword-only. Embeddings never block
 *     (or break) the keyword write/read path.
 *   • Gated — OSBORN_EMBED=0 forces keyword-only.
 *   • Consistent vectors — output is L2-normalized float→int8[EMBED_DIM] (×127) to
 *     match the sqlite-vec `int8[EMBED_DIM]` column. Qwen3-Embedding is Matryoshka
 *     (MRL) trained, so we ask for `dimensions: EMBED_DIM` AND defensively truncate
 *     the returned vector to EMBED_DIM and re-normalize — correct whether or not the
 *     API honors the `dimensions` passthrough.
 */

import { EMBED_DIM, EMBED_MODEL, type Embedder } from './session-store.js'

const OPENROUTER_URL =
  process.env.OPENROUTER_EMBED_URL || 'https://openrouter.ai/api/v1/embeddings'
const MODEL_ID = EMBED_MODEL
const MAX_BATCH = 64 // inputs per request (OpenAI-compatible arrays)
const REQUEST_TIMEOUT_MS = Number(process.env.OSBORN_EMBED_TIMEOUT_MS || 20_000)

let disabled = false

function apiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_WORKSPACE_API_KEY
}

/**
 * L2-normalize the first EMBED_DIM components of a float embedding, then quantize to
 * int8[EMBED_DIM] (×127, clamped). Truncating a Matryoshka vector to a prefix and
 * re-normalizing is a valid lower-dim embedding in the same space.
 */
function normalizeAndQuantize(floats: number[]): Int8Array {
  const n = Math.min(EMBED_DIM, floats.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += floats[i] * floats[i]
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0
  const out = new Int8Array(EMBED_DIM)
  for (let i = 0; i < n; i++) {
    let v = Math.round(floats[i] * inv * 127)
    if (v > 127) v = 127
    else if (v < -128) v = -128
    out[i] = v
  }
  return out
}

/** Embed one batch (≤ MAX_BATCH inputs). Returns aligned int8 vectors, or null on any failure. */
async function embedBatch(inputs: string[], key: string): Promise<Int8Array[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://voice-native.com',
        'X-Title': 'osborn',
      },
      body: JSON.stringify({
        model: MODEL_ID,
        input: inputs,
        dimensions: EMBED_DIM, // MRL reduce; defensively truncated below if ignored
        encoding_format: 'float',
      }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const json: any = await res.json()
    const data = json?.data
    if (!Array.isArray(data) || !data.length) return null
    // OpenAI-compatible: each entry carries its input `index`; align by it.
    const byIndex = new Array<Int8Array | null>(inputs.length).fill(null)
    for (const d of data) {
      const idx = typeof d?.index === 'number' ? d.index : -1
      const emb = d?.embedding
      if (idx >= 0 && idx < inputs.length && Array.isArray(emb)) {
        byIndex[idx] = normalizeAndQuantize(emb as number[])
      }
    }
    if (byIndex.some((v) => v == null)) return null // malformed / partial response
    return byIndex as Int8Array[]
  } catch {
    return null // network error, timeout/abort, bad JSON — degrade to keyword-only
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Returns an Embedder, or null if embeddings are disabled or no key is configured.
 * The returned function degrades to null on any per-call failure (keyword-only recall).
 */
export async function getEmbedder(): Promise<Embedder | null> {
  if (process.env.OSBORN_EMBED === '0' || disabled) return null
  const key = apiKey()
  if (!key) {
    disabled = true // no key on this machine — don't retry every turn
    return null
  }

  const embed: Embedder = async (texts) => {
    if (!texts.length) return []
    const out: Int8Array[] = []
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const chunk = texts.slice(i, i + MAX_BATCH).map((t) => t || ' ')
      const vecs = await embedBatch(chunk, key)
      if (!vecs) return null // any failure → keyword-only for this call
      out.push(...vecs)
    }
    return out
  }
  return embed
}
