import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * SUPERVISOR CHANNEL — bidirectional agent↔agent communication, file-based.
 *
 * Outbound (tester → supervisor): flight() appends structured events to
 * results/live/flight.jsonl — "entered room", "about to click X", "heard Y",
 * "stalled". A supervising agent tails this file (Monitor) and always knows
 * where the run is; no one wastes time wondering.
 *
 * Inbound (supervisor → tester): when stuck, requestAssistance() writes
 * results/live/assist-request.json (context + diagnostics) and WAITS for the
 * supervisor to write assist-response.json. The supervisor — who has
 * privileged senses (backend logs, /health, its knowledge base) — writes
 * either { instruction: "<natural-language action for the brain>" } or
 * { command: "retry" | "reload" | "abort" }. The tester applies it and
 * continues. If no response arrives in time, the tester falls back to its
 * own end-game (fail loudly with evidence).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const LIVE_DIR = join(__dirname, '..', 'results', 'live')
const FLIGHT = join(LIVE_DIR, 'flight.jsonl')
const REQ = join(LIVE_DIR, 'assist-request.json')
const RES = join(LIVE_DIR, 'assist-response.json')

export function flight(event: Record<string, unknown>) {
  try {
    mkdirSync(LIVE_DIR, { recursive: true })
    appendFileSync(FLIGHT, JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n')
  } catch { /* telemetry is best-effort */ }
}

export async function requestAssistance(
  context: Record<string, unknown>,
  waitMs = 180_000,
): Promise<{ instruction?: string; command?: string } | null> {
  mkdirSync(LIVE_DIR, { recursive: true })
  rmSync(RES, { force: true })
  writeFileSync(REQ, JSON.stringify({ t: new Date().toISOString(), ...context }, null, 2))
  flight({ type: 'assistance-requested', ...context })
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (existsSync(RES)) {
      try {
        const res = JSON.parse(readFileSync(RES, 'utf8'))
        rmSync(REQ, { force: true })
        rmSync(RES, { force: true })
        flight({ type: 'assistance-received', res })
        return res
      } catch { /* partial write — retry */ }
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  rmSync(REQ, { force: true })
  flight({ type: 'assistance-timeout' })
  return null
}
