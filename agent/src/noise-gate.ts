/**
 * Noise gate ("noise cancellation" mode) — transcript triage BEFORE the main agent.
 *
 * Design (docs/noise-gate-research-2026-10.md + locked decisions):
 * - Scope v1: competing CONVERSATIONS (classroom, taxi, multi-conversation rooms).
 *   Music/TV are out of scope — the user mutes manually for those.
 * - The gate is a tiny LABEL-ONLY classifier call: no tools, no memory search,
 *   static system prompt (cache-friendly), ~1 word out. It never rewrites —
 *   a forwarded utterance is always the user's verbatim transcript.
 * - FAIL-OPEN: any error/timeout forwards the utterance. A broken gate must
 *   degrade to today's behavior, never to a deaf agent. 'ambiguous' also
 *   forwards in v1 (false-reject costs more than false-accept; the ask-the-user
 *   UX is a later phase).
 * - Drops are TOMBSTONED, never deleted: kept in a ring buffer and emitted to
 *   the frontend so a false drop costs one tap ("send anyway"), not lost words.
 * - Toggles: UI button ('ui') and meeting-mode auto-engage ('meeting').
 * - Silence auto-exit: after SILENCE_EXIT_MS with no gate activity, the gate
 *   turns itself off and emits 'auto_exit' — index.ts then tells the agent to
 *   resume the conversation (non-interrupting [SYSTEM note, never priority
 *   'now') and notifies the frontend.
 *
 * Latency budget: the gate sits IN-LINE in front of the agent, and the fast
 * brain's own loop has an 8s wall-clock deadline downstream — so the gate's
 * deadline is short (default 2s) and strictly fail-open.
 */
import { EventEmitter } from 'node:events'

export type GateVerdict = 'directed' | 'side_talk' | 'ambiguous'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const GATE_MODEL = process.env.OSBORN_GATE_MODEL || process.env.OSBORN_FAST_BRAIN_MODEL || 'deepseek/deepseek-chat'
const GATE_TIMEOUT_MS = Number(process.env.OSBORN_GATE_TIMEOUT_MS || 2000)
const SILENCE_EXIT_MS = Number(process.env.OSBORN_GATE_SILENCE_EXIT_MS || 5 * 60_000)
const DROP_RING_MAX = 50

// Static system prompt — keep byte-stable (prompt caching is prefix-matched).
const GATE_SYSTEM_PROMPT = [
  'You are a transcript gate for a voice AI assistant worn as an earpiece in public.',
  'Everything the microphone hears is transcribed and shown to you one utterance at a time.',
  'The environment contains other people talking: teachers, taxi drivers, nearby conversations.',
  'Your ONLY job: decide whether the utterance is directed at the assistant.',
  '',
  'Reply with EXACTLY one word:',
  '- directed   → the user is talking to the assistant (continues the current work/conversation, addresses it, asks it something, gives it instructions, or reacts to what it said)',
  '- side_talk  → clearly someone else talking, or the user talking to another person (greetings to others, classroom lecture content unrelated to the work, transactional talk like addresses/payments, conversational replies that make no sense addressed to an AI assistant)',
  '- ambiguous  → genuinely unclear',
  '',
  'Bias: when the utterance plausibly relates to the current work context, prefer directed.',
  'Short backchannels ("yeah", "okay", "mhm") during active assistant work are directed.',
  'Never reply with anything except one of the three labels.',
].join('\n')

export interface GateContext {
  recentTurns: Array<{ role: string; content: string }>
  activeWork: string
}

export interface GateDrop {
  text: string
  verdict: GateVerdict
  ts: number
}

class NoiseGate extends EventEmitter {
  enabled = false
  reason: 'ui' | 'meeting' | null = null
  #lastActivityAt = 0
  #timer: NodeJS.Timeout | null = null
  #dropped: GateDrop[] = []

  /** Kill switch (read lazily so tests/ops can flip it at runtime):
   * OSBORN_NOISE_GATE=off disables the gate entirely — no triage, no
   * meeting auto-engage — restoring pre-gate behavior without a republish. */
  #killed(): boolean {
    return process.env.OSBORN_NOISE_GATE === 'off'
  }

  /** Turn the gate on/off. reason 'ui' = button, 'meeting' = meeting-mode auto-engage. */
  setEnabled(on: boolean, reason: 'ui' | 'meeting' | 'silence' = 'ui'): void {
    if (on && this.#killed()) {
      console.log('🚪 [gate] enable ignored — OSBORN_NOISE_GATE=off')
      return
    }
    const was = this.enabled
    this.enabled = on
    this.reason = on ? (reason === 'silence' ? this.reason : reason) : null
    if (on) {
      this.#lastActivityAt = Date.now()
      if (!this.#timer) {
        this.#timer = setInterval(() => this.#tick(), 30_000)
        this.#timer.unref?.()
      }
    } else if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    if (was !== on) {
      console.log(`🚪 [gate] ${on ? 'ENABLED' : 'DISABLED'} (${reason})`)
      this.emit('state', { enabled: on, reason: on ? this.reason : reason })
    }
  }

  // One-shot allowlist for tombstone recovery ("send anyway"): the resent text
  // must pass the gate exactly once without re-triage.
  #allowOnce = new Set<string>()

  allowOnce(text: string): void {
    this.#allowOnce.add(text)
  }

  /** True when this utterance should be triaged. Bracket-prefixed texts are
   * synthetic ([MEETING/[SYSTEM/[INTERRUPTED templates), never raw user voice. */
  shouldGate(text: string): boolean {
    if (this.#killed() || !this.enabled || !text?.trim() || text.startsWith('[')) return false
    if (this.#allowOnce.has(text)) {
      this.#allowOnce.delete(text)
      return false
    }
    return true
  }

  /** Any pass-through / meeting chunk counts as activity for the silence timer. */
  noteActivity(): void {
    this.#lastActivityAt = Date.now()
  }

  recordDrop(text: string, verdict: GateVerdict): void {
    const drop: GateDrop = { text, verdict, ts: Date.now() }
    this.#dropped.push(drop)
    if (this.#dropped.length > DROP_RING_MAX) this.#dropped.shift()
    this.emit('drop', drop)
  }

  getDropped(): GateDrop[] {
    return [...this.#dropped]
  }

  #tick(): void {
    if (!this.enabled) return
    if (Date.now() - this.#lastActivityAt >= SILENCE_EXIT_MS) {
      console.log(`🚪 [gate] ${Math.round(SILENCE_EXIT_MS / 60000)} min of quiet — auto-exiting noise-cancellation`)
      this.setEnabled(false, 'silence')
      this.emit('auto_exit', { quietMs: Date.now() - this.#lastActivityAt })
    }
  }

  /**
   * Label-only classification. Fail-open: ANY failure (no key, HTTP error,
   * timeout, unparseable label) returns 'directed' so the gate can never
   * silence the user.
   */
  async classify(text: string, ctx: GateContext): Promise<GateVerdict> {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) return 'directed'
    const started = Date.now()
    try {
      const recent = ctx.recentTurns
        .slice(-8)
        .map(t => `${t.role === 'user' ? 'USER' : 'ASSISTANT'}: ${String(t.content).slice(0, 200)}`)
        .join('\n')
      const controller = new AbortController()
      const to = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS)
      const resp = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: GATE_MODEL,
          max_tokens: 5,
          temperature: 0,
          messages: [
            { role: 'system', content: GATE_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                `Current work with the assistant:\n${ctx.activeWork || '(none known)'}`,
                ``,
                `Recent conversation:\n${recent || '(none)'}`,
                ``,
                `New utterance heard by the microphone:\n"${text}"`,
                ``,
                `Label:`,
              ].join('\n'),
            },
          ],
        }),
      })
      clearTimeout(to)
      if (!resp.ok) return 'directed'
      const data: any = await resp.json()
      const raw = String(data?.choices?.[0]?.message?.content || '').toLowerCase()
      const verdict: GateVerdict = raw.includes('side_talk') || raw.includes('side talk')
        ? 'side_talk'
        : raw.includes('ambiguous') ? 'ambiguous' : 'directed'
      console.log(`🚪 [gate] verdict=${verdict} (${Date.now() - started}ms) "${text.slice(0, 60)}"`)
      return verdict
    } catch (err: any) {
      console.log(`🚪 [gate] classify failed (${Date.now() - started}ms, ${err?.name || err?.message}) — fail-open → directed`)
      return 'directed'
    }
  }
}

/** Singleton — one gate per agent process (one voice session per machine). */
export const noiseGate = new NoiseGate()
