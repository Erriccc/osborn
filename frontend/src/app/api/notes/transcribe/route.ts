import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * POST /api/notes/transcribe — audio blob → plain text, for the dashboard
 * quick-note recorder. SPEECH-TO-TEXT ONLY: no model reply, no TTS — a note
 * is a transcription of what the user said, nothing more.
 *
 * Body: raw audio bytes (audio/webm;opus from MediaRecorder, or audio/mp4 on
 * Safari/iOS) with the Content-Type header set by the browser.
 *
 * Provider: Deepgram /v1/listen (synchronous REST, `nova-2` + smart_format).
 * DEEPGRAM_API_KEY is a required platform key (env-keys.ts), already on
 * Railway. Soniox (the live-session STT) is async-job-shaped and a poor fit
 * for a one-shot recording; Deepgram is the pre-existing key this path rides.
 *
 * Auth: signed-in only (key is paid). Caps: 15 MB body, 30s timeout.
 */

const MAX_BYTES = 15 * 1024 * 1024
const TIMEOUT_MS = 30_000

export async function POST(req: NextRequest) {
  try {
    const supabase = await createSupabaseServer()
    const { data: u } = await supabase.auth.getUser()
    if (!u.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  } catch {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
  }

  const key = process.env.DEEPGRAM_API_KEY
  if (!key) return NextResponse.json({ error: 'Transcription is not configured' }, { status: 503 })

  const contentType = req.headers.get('content-type') || 'audio/webm'
  const buf = Buffer.from(await req.arrayBuffer())
  if (!buf.length) return NextResponse.json({ error: 'Empty audio' }, { status: 400 })
  if (buf.length > MAX_BYTES) return NextResponse.json({ error: 'Recording too long' }, { status: 413 })

  try {
    const res = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&paragraphs=false',
      {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': contentType },
        body: buf,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return NextResponse.json({ error: `Transcription failed (${res.status})`, detail: detail.slice(0, 200) }, { status: 502 })
    }
    const json = await res.json()
    const text: string | undefined = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript
    if (!text || !text.trim()) return NextResponse.json({ error: 'Nothing was heard — try again' }, { status: 422 })
    return NextResponse.json({ text: text.trim() })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return NextResponse.json({ error: 'Transcription timed out' }, { status: 504 })
    }
    return NextResponse.json({ error: 'Transcription failed' }, { status: 500 })
  }
}
