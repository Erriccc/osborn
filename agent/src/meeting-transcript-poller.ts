/**
 * MeetingTranscriptPoller — pulls Recall.ai meeting transcripts on a fixed
 * interval and forwards new turns to the LLM as tagged `[MEETING — <botId>]:`
 * messages.
 *
 * This replaces the older LiveKit/WebSocket audio pipeline that streamed raw
 * PCM from Recall into a LiveKit room. The polling architecture is simpler
 * (no parallel STT, no audio pipeline, no participant juggling), survives
 * agent restarts (Recall keeps the transcript on its side), and the LLM
 * never speaks in the meeting — it's a silent note-taker.
 *
 * Lifecycle:
 *   const poller = new MeetingTranscriptPoller({ botId, recall, onTurns, intervalMs })
 *   poller.start()
 *   ...
 *   poller.stop()  // on leave_meeting / disconnect / session switch
 *
 * Dedup strategy:
 *   Each turn carries a `start_timestamp.relative` on its first word (seconds
 *   since recording start). We track the highest cursor we've forwarded and
 *   only send turns with a strictly greater first-word timestamp. This means
 *   re-fetches don't double-deliver, and partial transcripts that get refined
 *   later don't re-trigger LLM processing of already-handled turns.
 *
 * Error handling:
 *   Transient fetch errors are logged + skipped (poll continues on next tick).
 *   No backoff — Recall's transcript endpoint is stable enough that a 30s
 *   cadence makes "slow start" non-issues self-recover within one cycle.
 */

import type { RecallClient, TranscriptTurn } from './recall-client.js'

export interface MeetingTranscriptPollerOptions {
  botId: string
  recall: RecallClient
  /** Called when new transcript turns arrive (de-duped). Get a fresh batch each tick. */
  onTurns: (chunk: { botId: string; turns: TranscriptTurn[]; formatted: string }) => void | Promise<void>
  /** Default 30s — matches the user's stated cadence. */
  intervalMs?: number
  /** Optional debug logger. */
  onError?: (err: Error) => void
  /**
   * Called ONCE when Recall reports the meeting is over (bot status reaches a
   * terminal code: call_ended / done / fatal). Rides the same 30s tick — no
   * extra webhook subscription needed. The meeting-copilot lifecycle uses this
   * as the authoritative "meeting ended" signal now that the bot is DECOUPLED
   * from the voice session (a voice disconnect no longer drops the bot, so
   * something must still end it — this is that something).
   */
  onMeetingEnd?: (statusCode: string) => void
}

/** Recall bot status codes that mean the meeting/bot is definitively over. */
const TERMINAL_STATUS_CODES = new Set(['call_ended', 'done', 'fatal'])

export class MeetingTranscriptPoller {
  #opts: MeetingTranscriptPollerOptions
  #timer: ReturnType<typeof setInterval> | null = null
  #cursor: number = -Infinity // highest first-word.start_timestamp.relative we've forwarded
  #inFlight: boolean = false  // prevent overlapping polls if one cycle runs long
  #stopped: boolean = false

  constructor(opts: MeetingTranscriptPollerOptions) {
    this.#opts = opts
  }

  start(): void {
    if (this.#timer) return
    const interval = this.#opts.intervalMs ?? 30_000
    console.log(`📓 MeetingTranscriptPoller starting for bot=${this.#opts.botId.substring(0, 8)} (every ${Math.round(interval / 1000)}s)`)
    // Fire once immediately so the LLM sees the meeting started, then on interval.
    void this.#tick()
    this.#timer = setInterval(() => void this.#tick(), interval)
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    console.log(`📓 MeetingTranscriptPoller stopped for bot=${this.#opts.botId.substring(0, 8)}`)
  }

  async #tick(): Promise<void> {
    if (this.#inFlight || this.#stopped) return
    this.#inFlight = true
    try {
      // Meeting-end detection first: if the bot has reached a terminal status,
      // fire onMeetingEnd (once — stop() sets #stopped so later ticks no-op)
      // AFTER one final transcript pull below, so the last turns aren't lost.
      let endedCode: string | null = null
      if (this.#opts.onMeetingEnd) {
        try {
          const code = await this.#opts.recall.getBotStatus(this.#opts.botId)
          if (TERMINAL_STATUS_CODES.has(code)) endedCode = code
        } catch { /* status probe is best-effort; transcript pull continues */ }
      }
      const all = await this.#opts.recall.getTranscript(this.#opts.botId)
      const fresh = all.filter(t => {
        const firstWordTs = t.words?.[0]?.start_timestamp?.relative
        return typeof firstWordTs === 'number' && firstWordTs > this.#cursor
      })
      if (fresh.length > 0) {
        // Advance cursor to highest seen first-word ts (across all returned turns,
        // not just the fresh ones — guards against Recall returning a paged subset).
        for (const t of all) {
          const ts = t.words?.[0]?.start_timestamp?.relative
          if (typeof ts === 'number' && ts > this.#cursor) this.#cursor = ts
        }

        const formatted = formatTurns(fresh)
        if (formatted) {
          console.log(`📓 MeetingTranscriptPoller: ${fresh.length} new turn(s), cursor=${this.#cursor.toFixed(1)}s, chars=${formatted.length}`)
          await this.#opts.onTurns({ botId: this.#opts.botId, turns: fresh, formatted })
        }
      }
      // Fire end-of-meeting AFTER the final transcript pull so the last turns land.
      if (endedCode) {
        console.log(`📓 MeetingTranscriptPoller: bot status '${endedCode}' — meeting ended`)
        this.stop()
        this.#opts.onMeetingEnd?.(endedCode)
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.#opts.onError?.(e)
      console.warn(`⚠️ MeetingTranscriptPoller tick failed: ${e.message}`)
    } finally {
      this.#inFlight = false
    }
  }
}

/**
 * Format an array of turns into a single string for LLM consumption.
 *
 * Each turn becomes:
 *   <Speaker>: <text>
 *
 * Whitespace-only words and zero-content turns are dropped. Returns empty
 * string if nothing meaningful is in the batch.
 */
export function formatTurns(turns: TranscriptTurn[]): string {
  const lines: string[] = []
  for (const t of turns) {
    const speaker = t.speaker || t.participant?.name || 'Unknown'
    const text = (t.words ?? []).map(w => w.text).join(' ').replace(/\s+/g, ' ').trim()
    if (!text) continue
    lines.push(`${speaker}: ${text}`)
  }
  return lines.join('\n')
}
