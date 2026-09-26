/**
 * embedder.ts — Local text→vector embedder for the semantic (vec) layer of session-store.
 *
 * Uses all-MiniLM-L6-v2 (384-dim) via @xenova/transformers, running fully local (no API,
 * no per-write network cost). Output is L2-normalized float32, quantized to int8[384]
 * (×127) to match the sqlite-vec `int8[384]` column — 4× smaller than float32 with
 * ~98–99% recall.
 *
 * DESIGN FOR RELIABILITY:
 *   • Lazy — the model is loaded on first use, never at import (startup stays fast).
 *   • Best-effort — if the package or model can't load, getEmbedder() returns null and
 *     the store runs keyword-only. Embeddings never block the keyword write path.
 *   • Gated — set OSBORN_EMBED=0 to force keyword-only (e.g. on machines without the
 *     model cached, or to avoid the first-run model download).
 *
 * Model cache honors TRANSFORMERS_CACHE / HF_HOME so it can be baked into the image.
 */

import { EMBED_DIM, EMBED_MODEL, type Embedder } from './session-store.js'

const MODEL_ID = EMBED_MODEL

let pipelinePromise: Promise<any> | null = null
let disabled = false

/** Quantize a normalized float32 embedding to int8[dim] (×127, clamped). */
function quantizeInt8(floats: Float32Array | number[]): Int8Array {
  const out = new Int8Array(EMBED_DIM)
  const n = Math.min(EMBED_DIM, floats.length)
  for (let i = 0; i < n; i++) {
    let v = Math.round((floats[i] as number) * 127)
    if (v > 127) v = 127
    else if (v < -128) v = -128
    out[i] = v
  }
  return out
}

async function loadPipeline(): Promise<any | null> {
  if (disabled) return null
  if (process.env.OSBORN_EMBED === '0') { disabled = true; return null }
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      // Lazy import — @xenova/transformers is heavy and optional.
      const mod: any = await import('@xenova/transformers').catch(() => null)
      if (!mod) throw new Error('@xenova/transformers not installed')
      if (mod.env) {
        mod.env.allowLocalModels = true
        // Avoid noisy multi-thread wasm issues in the agent process.
        if (mod.env.backends?.onnx?.wasm) mod.env.backends.onnx.wasm.numThreads = 1
      }
      return mod.pipeline('feature-extraction', MODEL_ID)
    })().catch((err) => {
      disabled = true
      pipelinePromise = null
      throw err
    })
  }
  return pipelinePromise
}

/**
 * Returns an Embedder, or null if embeddings are unavailable/disabled.
 * The returned function itself also degrades to null on runtime failure.
 */
export async function getEmbedder(): Promise<Embedder | null> {
  if (process.env.OSBORN_EMBED === '0') return null
  let pipe: any
  try {
    pipe = await loadPipeline()
  } catch {
    return null
  }
  if (!pipe) return null

  const embed: Embedder = async (texts) => {
    try {
      if (!texts.length) return []
      const out: Int8Array[] = []
      // Transformers.js handles batching internally; do them one-by-one to keep
      // memory bounded on long tool outputs.
      for (const t of texts) {
        const res = await pipe(t || ' ', { pooling: 'mean', normalize: true })
        out.push(quantizeInt8(res.data as Float32Array))
      }
      return out
    } catch {
      return null
    }
  }
  return embed
}
