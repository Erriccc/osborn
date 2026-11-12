import type { Page } from '@playwright/test'
import { optionalEnvKey } from './env'

/**
 * Dynamic conversation generation — no canned phrases. An LLM plays the role
 * of a human tester: given the goal, the conversation so far, and what's on
 * screen, it composes the next utterance. Paired with the on-the-fly TTS
 * mouth, every run is a different, natural conversation — which is exactly
 * how you surface issues scripted fixtures never hit.
 */

export type Turn = { speaker: 'tester' | 'agent'; text: string }

export async function nextUtterance(
  goal: string,
  history: Turn[],
  screenTail: string,
  screenshotB64?: string, // multimodal: what the screen looks like right now
): Promise<{ say: string | null; reason: string }> {
  const SYSTEM =
    'You are a QA tester having a NATURAL spoken conversation with a voice AI assistant, by phone-call style voice. ' +
    'You perceive the app through a bundle: audio you heard (transcribed), the current screenshot, and screen text. ' +
    'Compose the next thing to say out loud: conversational, 1-2 short sentences, no stage directions, no quotes. ' +
    'Vary your phrasing naturally — never repeat earlier wording. Pursue the GOAL; react to what the assistant actually said and what you see. ' +
    'When the goal is complete (or clearly stuck), end the conversation politely. ' +
    'Reply as JSON: {"say": "<utterance or null when done>", "reason": "<one line why>"}'
  const userText =
    `GOAL: ${goal}\n\nCONVERSATION SO FAR (AGENT lines are what you HEARD, transcribed from audio):\n` +
    (history.map((t) => `${t.speaker.toUpperCase()}: ${t.text}`).join('\n') || '(none — you speak first)') +
    `\n\nCURRENT SCREEN TEXT (tail):\n${screenTail.slice(-1200)}`

  // Composer LLM — Gemini preferred: GOOGLE_API_KEY is already on the engine for
  // the Stagehand brain, so the tester conversation needs no OpenAI key. Falls
  // back to OpenAI when its key is present. Both return {"say","reason"} JSON.
  const google = optionalEnvKey('GOOGLE_API_KEY') || optionalEnvKey('GOOGLE_GENERATIVE_AI_API_KEY')
  if (google) {
    const parts: any[] = [{ text: userText }]
    if (screenshotB64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: screenshotB64 } })
    const gres = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${google}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents: [{ parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.9 },
      }),
    })
    if (gres.ok) {
      const gj: any = await gres.json()
      const txt = gj?.candidates?.[0]?.content?.parts?.[0]?.text
      if (txt) {
        const parsed = JSON.parse(txt)
        return { say: parsed.say ?? null, reason: parsed.reason ?? '' }
      }
    }
    console.warn(`[converse] Gemini composer failed (${gres.status}) — trying OpenAI`)
  }

  const key = optionalEnvKey('OPENAI_API_KEY')
  if (!key) throw new Error('no composer LLM available — set GOOGLE_API_KEY or OPENAI_API_KEY')
  const userContent: any = screenshotB64
    ? [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotB64}`, detail: 'low' } },
      ]
    : userText
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userContent },
      ],
    }),
  })
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`)
  const j: any = await res.json()
  const parsed = JSON.parse(j.choices[0].message.content)
  return { say: parsed.say ?? null, reason: parsed.reason ?? '' }
}

/** Grab the visible text tail — the generic way to read "what the agent said". */
export async function screenTail(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText.slice(-2000))
}

/**
 * ALWAYS-LISTENING comprehension: transcribe the live recording (without
 * stopping it) and return only the words spoken AFTER `sinceMs`
 * (capture-relative). Uses the provider's word timestamps (Soniox, then Deepgram). Works on ANY app —
 * even ones with no text transcript in the UI.
 */
export async function hearSince(page: Page, sinceMs: number): Promise<string> {
  const { peekCapture } = await import('./audio-capture')
  const { base64, anchorOffsetMs } = await peekCapture(page)
  // word.start is file-relative (timeline begins at the first tapped source,
  // NOT capture start — verified 38.3s skew, 2026-07-31); convert the wall-clock
  // window into file time via the anchor.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'hear-'))
  try {
    const raw = Buffer.from(base64, 'base64'); writeFileSync(join(dir, 'in.webm'), raw)
    const cut = await cutTurn(join(dir, 'in.webm'), Math.max(0, sinceMs - anchorOffsetMs), false)
    return await transcribeTurn(cut ?? { audio: raw, fileSinceMs: Math.max(0, sinceMs - anchorOffsetMs), wav: false })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** hearSince for a recording the caller already decoded to a wav (`fileSinceMs` is relative to its start). */
export async function hearFromWav(wavPath: string, fileSinceMs: number): Promise<string> {
  const cut = await cutTurn(wavPath, Math.max(0, fileSinceMs), true)
  if (!cut) throw new Error('could not cut the turn from the decoded recording')
  return transcribeTurn(cut)
}

async function transcribeTurn({ audio, fileSinceMs, wav }: { audio: Buffer; fileSinceMs: number; wav: boolean }): Promise<string> {
  const { optionalEnvKey } = await import('./env')
  // Soniox async STT — upload the recorded clip, poll the job, keep tokens whose
  // start_ms falls after the window. Word timestamps come back by default; no
  // OpenAI/Deepgram key needed.
  // Name every provider that failed, not just the last one (#151).
  if (wav && audio.length < 3200) return ''  // the cut landed past the end: nothing new to hear
  const failures: string[] = []
  const soniox = optionalEnvKey('SONIOX_API_KEY')
  if (soniox) {
    try {
      return await sonioxTranscribeSince(audio, fileSinceMs, soniox, wav)
    } catch (e) {
      const msg = ((e as Error).message || String(e)).slice(0, 140)
      failures.push(`Soniox: ${msg}`)
      console.warn('[converse] Soniox STT error — trying Deepgram:', msg)
    }
  }

  const dg = optionalEnvKey('DEEPGRAM_API_KEY')
  if (!dg) {
    if (failures.length) throw new Error(failures.join('; '))
    return ''
  }
  try { return await deepgramTranscribeSince(audio, fileSinceMs, dg, wav) }
  catch (e) { failures.push(`Deepgram: ${((e as Error).message || String(e)).slice(0, 140)}`); throw new Error(failures.join('; ')) }
}

/**
 * Only the current turn goes to STT, as a 16 kHz mono wav cut from just before
 * `sinceMs`. A raw MediaRecorder webm can't be seeked, so it is decoded up to
 * the cut (-ss after -i); a decoded wav is seeked directly. null if ffmpeg fails.
 */
async function cutTurn(input: string, sinceMs: number, seekable: boolean): Promise<{ audio: Buffer; fileSinceMs: number; wav: true } | null> {
  const { execFile } = await import('node:child_process')
  const { readFileSync, rmSync } = await import('node:fs')
  const cut = Math.max(0, sinceMs - 1000)
  const out = `${input}.turn-${process.pid}-${Date.now()}.wav`
  const ss = ['-ss', String(cut / 1000)]
  try {
    await new Promise<void>((ok, fail) => execFile('ffmpeg', ['-y', '-loglevel', 'error', ...(seekable ? ss : []), '-i', input, ...(seekable ? [] : ss),
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], { timeout: 60000 }, (e) => (e ? fail(e) : ok())))
    return { audio: readFileSync(out), fileSinceMs: sinceMs - cut, wav: true }
  } catch (e) {
    console.warn('[converse] could not cut the turn:', String((e as Error).message ?? e).slice(0, 120))
    return null
  } finally { rmSync(out, { force: true }) }
}

async function deepgramTranscribeSince(audio: Buffer, fileSinceMs: number, dg: string, wav: boolean): Promise<string> {
  const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true', {
    method: 'POST',
    headers: { Authorization: `Token ${dg}`, 'Content-Type': wav ? 'audio/wav' : 'audio/webm' },
    body: audio,
  })
  if (!res.ok) throw new Error(`deepgram ${res.status}`)
  const j: any = await res.json()
  const words: Array<{ punctuated_word?: string; word: string; start: number }> =
    j?.results?.channels?.[0]?.alternatives?.[0]?.words ?? []
  return words
    .filter((w) => w.start * 1000 >= fileSinceMs)
    .map((w) => w.punctuated_word ?? w.word)
    .join(' ')
}

/** Soniox async file transcription: the text spoken after `sinceMs` (file time). */
async function sonioxTranscribeSince(audio: Buffer, sinceMs: number, apiKey: string, wav: boolean): Promise<string> {
  const H = { Authorization: `Bearer ${apiKey}` }
  const fd = new FormData()
  fd.append('file', new Blob([new Uint8Array(audio)], { type: wav ? 'audio/wav' : 'audio/webm' }), wav ? 'clip.wav' : 'clip.webm')
  const up = await fetch('https://api.soniox.com/v1/files', { method: 'POST', headers: H, body: fd as any, signal: AbortSignal.timeout(30000) })
  if (!up.ok) throw new Error(`upload HTTP ${up.status} ${(await up.text().catch(() => '')).slice(0, 80)} (${Math.round(audio.length / 1024)} KB)`)
  const fileId = (await up.json() as any).id
  try {
    const cr = await fetch('https://api.soniox.com/v1/transcriptions', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId, model: 'stt-async-v3' }),
    })
    if (!cr.ok) throw new Error(`create-transcription HTTP ${cr.status} ${(await cr.text().catch(() => '')).slice(0, 80)}`)
    const jobId = (await cr.json() as any).id
    try {
      // An unfinished job is an error, not silence.
      const deadline = Date.now() + 60000
      let done = false
      while (Date.now() < deadline) {
        const st: any = await (await fetch(`https://api.soniox.com/v1/transcriptions/${jobId}`, { headers: H })).json()
        if (st.status === 'completed') { done = true; break }
        if (st.status === 'error' || st.status === 'failed') throw new Error(`job ${st.status}: ${st.error_message ?? ''}`)
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!done) throw new Error('job did not finish within 60s')
      const tx: any = await (await fetch(`https://api.soniox.com/v1/transcriptions/${jobId}/transcript`, { headers: H })).json()
      const tokens: Array<{ text?: string; start_ms?: number }> = tx?.tokens ?? []
      // Only what was spoken inside the window. This used to fall back to the
      // WHOLE recording's text when nothing was new, so a silent turn reported
      // an earlier reply as freshly heard. With no token timings at all the
      // window can't be applied, and only then is the full text returned.
      if (!tokens.length) return (tx?.text || '').trim()
      return tokens.filter((t) => (t.start_ms ?? 0) >= sinceMs).map((t) => t.text ?? '').join('').trim()
    } finally {
      fetch(`https://api.soniox.com/v1/transcriptions/${jobId}`, { method: 'DELETE', headers: H }).catch(() => {})
    }
  } finally {
    fetch(`https://api.soniox.com/v1/files/${fileId}`, { method: 'DELETE', headers: H }).catch(() => {})
  }
}
