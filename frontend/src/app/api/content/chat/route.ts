import { NextRequest } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * POST /api/content/chat — a LIGHTWEIGHT, conversational "talk to this page"
 * endpoint. Unlike /api/content/refine (which rewrites a library item into a
 * persisted platform rendition and returns strict JSON), this is just a plain
 * text chat with the FAST BRAIN grounded in a piece of published content:
 * a text bar + streamed output, no session, no meeting, no persistence.
 *
 * Body: { messages: {role:'user'|'assistant', content:string}[],
 *         context?: { title?, hook?, body? } }
 *
 * Streams the model's reply back as a plain text/event-free chunk stream the
 * client reads incrementally (text/plain; charset=utf-8). We relay only the
 * delta text — no SSE framing — so the client can append response.body chunks
 * straight into the growing assistant message.
 *
 * Auth: signed-in only. The Fireworks key is paid, so we never expose an
 * anonymous LLM proxy. Anon callers get 401 and the UI nudges them to sign in.
 *
 * Fireworks: OpenAI-compatible streaming chat/completions, gpt-oss-120b,
 * keyed by FIREWORKS_API_KEY (set on Railway).
 */

const FIREWORKS_URL = 'https://api.fireworks.ai/inference/v1/chat/completions'
const FIREWORKS_MODEL = 'accounts/fireworks/models/gpt-oss-120b'
const CHAT_TIMEOUT_MS = 45_000
const MAX_TOKENS = 1024
const MAX_TURNS = 20          // cap history we forward (cost + context)
const MAX_MSG_CHARS = 4000    // per-message clamp
const MAX_BODY_CHARS = 8000   // grounding-context clamp

interface InMsg { role: 'user' | 'assistant'; content: string }

function systemPrompt(ctx: { title?: string | null; hook?: string | null; body?: string | null }): string {
  const parts: string[] = [
    `You are Voice Native's assistant, chatting with a reader about a specific published piece.`,
    `Answer conversationally and concisely — this is a quick back-and-forth, not an essay. Be concrete and grounded in the CONTENT below; if something isn't covered there, say so briefly rather than inventing it.`,
    `If the reader seems to want to create their own version or reproduce the work, encourage them to start a Voice Native session — but don't be pushy about it.`,
    `Never output raw logs, row numbers, or machine bookkeeping. Plain, confident, no hype, no emoji.`,
  ]
  const content: string[] = []
  if (ctx.title) content.push(`TITLE: ${ctx.title}`)
  if (ctx.hook) content.push(`HOOK: ${ctx.hook}`)
  if (ctx.body) content.push(`BODY:\n${ctx.body.slice(0, MAX_BODY_CHARS)}`)
  return `${parts.join('\n')}\n\n--- CONTENT ---\n${content.join('\n\n') || '(no content provided)'}`
}

export async function POST(req: NextRequest) {
  // ---- Auth (signed-in only) ----------------------------------------------
  try {
    const supabase = await createSupabaseServer()
    const { data: u } = await supabase.auth.getUser()
    if (!u.user) return json({ error: 'Sign in to chat about this page' }, 401)
  } catch {
    return json({ error: 'Auth not configured' }, 503)
  }

  // ---- Parse + clamp the body ---------------------------------------------
  let messages: InMsg[]
  let context: { title?: string | null; hook?: string | null; body?: string | null }
  try {
    const b = await req.json()
    const raw: unknown[] = Array.isArray(b?.messages) ? b.messages : []
    messages = raw
      .filter((m): m is InMsg =>
        !!m && typeof m === 'object' &&
        ((m as InMsg).role === 'user' || (m as InMsg).role === 'assistant') &&
        typeof (m as InMsg).content === 'string' && (m as InMsg).content.trim().length > 0)
      .slice(-MAX_TURNS)
      .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }))
    context = (b?.context && typeof b.context === 'object') ? b.context : {}
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    return json({ error: 'Last message must be from the user' }, 400)
  }

  const apiKey = process.env.FIREWORKS_API_KEY
  if (!apiKey) return json({ error: 'Chat is not configured (missing FIREWORKS_API_KEY)' }, 503)

  // ---- Call Fireworks (streaming) -----------------------------------------
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS)

  let upstream: Response
  try {
    upstream = await fetch(FIREWORKS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: FIREWORKS_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.7,
        stream: true,
        messages: [{ role: 'system', content: systemPrompt(context) }, ...messages],
      }),
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    if (e instanceof Error && e.name === 'AbortError') return json({ error: 'Chat timed out' }, 504)
    return json({ error: e instanceof Error ? e.message : 'Chat failed' }, 500)
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timer)
    const detail = await upstream.text().catch(() => '')
    return json({ error: `Fireworks error (${upstream.status})`, detail: detail.slice(0, 300) }, 502)
  }

  // Relay the SSE deltas as a plain text stream of just the content tokens.
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read()
        if (done) { clearTimeout(timer); ctrl.close(); return }
        buffer += decoder.decode(value, { stream: true })
        // SSE frames are separated by double newlines; each "data: {json}" line
        // carries an incremental delta. "[DONE]" ends the stream.
        let idx: number
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') { clearTimeout(timer); ctrl.close(); return }
          try {
            const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta.length) ctrl.enqueue(encoder.encode(delta))
          } catch { /* ignore keep-alives / partial frames */ }
        }
      } catch {
        clearTimeout(timer)
        try { ctrl.close() } catch { /* already closed */ }
      }
    },
    cancel() { clearTimeout(timer); reader.cancel().catch(() => {}) },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
