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

let lastEmbedWarn = 0
/** Throttled failure log (max ~1/30s) so a bulk re-embed can't spam, but embedded=0 is
 * never silent — every failure surfaces a reason (status/network) in the machine logs. */
function embedWarn(msg: string): void {
  const now = Date.now()
  if (now - lastEmbedWarn > 30_000) {
    lastEmbedWarn = now
    console.warn(`[embedder] ${msg}`)
  }
}

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
async function embedBatch(inputs: string[], key: string, timeoutMs: number): Promise<Int8Array[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
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
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      embedWarn(`OpenRouter ${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
      return null
    }
    const json: any = await res.json()
    const data = json?.data
    if (!Array.isArray(data) || !data.length) {
      embedWarn('empty/invalid embeddings response')
      return null
    }
    // OpenAI-compatible: each entry carries its input `index`; align by it.
    // Fall back to array order if `index` is absent so a missing field never voids the batch.
    const byIndex = new Array<Int8Array | null>(inputs.length).fill(null)
    data.forEach((d: any, pos: number) => {
      const idx = typeof d?.index === 'number' ? d.index : pos
      const emb = d?.embedding
      if (idx >= 0 && idx < inputs.length && Array.isArray(emb)) {
        byIndex[idx] = normalizeAndQuantize(emb as number[])
      }
    })
    if (byIndex.some((v) => v == null)) {
      embedWarn('response missing/misaligned embeddings')
      return null
    }
    return byIndex as Int8Array[]
  } catch (err: any) {
    embedWarn(`request failed: ${err?.name || ''} ${err?.message || err}`)
    return null // network error, timeout/abort, bad JSON — degrade to keyword-only
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Returns an Embedder, or null if embeddings are disabled or no key is configured.
 * The returned function degrades to null on any per-call failure (keyword-only recall).
 */
export async function getEmbedder(timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Embedder | null> {
  if (process.env.OSBORN_EMBED === '0') return null
  // Re-read the key EVERY call and never latch off on a missing key: the platform
  // OpenRouter key is hydrated into the env by the secrets layer, which can finish
  // AFTER the first (boot-time) warm call. A permanent latch there disabled embedding
  // for the whole session (embedded=0) even though fast-brain — which reads the key
  // fresh per request — kept working. Re-reading recovers as soon as the key lands.
  const key = apiKey()
  if (!key) {
    embedWarn('no OPENROUTER_API_KEY in env yet — keyword-only for this call')
    return null
  }

  const embed: Embedder = async (texts) => {
    if (!texts.length) return []
    const out: Int8Array[] = []
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const chunk = texts.slice(i, i + MAX_BATCH).map((t) => t || ' ')
      const vecs = await embedBatch(chunk, key, timeoutMs)
      if (!vecs) return null // any failure → keyword-only for this call
      out.push(...vecs)
    }
    return out
  }
  return embed
}
