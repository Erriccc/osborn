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
 * (capture-relative). Uses Deepgram word timestamps. Works on ANY app —
 * even ones with no text transcript in the UI.
 */
export async function hearSince(page: Page, sinceMs: number): Promise<string> {
  const { peekCapture } = await import('./audio-capture')
  const { envKey } = await import('./env')
  const { base64, anchorOffsetMs } = await peekCapture(page)
  const audio = Buffer.from(base64, 'base64')
  const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true', {
    method: 'POST',
    headers: { Authorization: `Token ${envKey('DEEPGRAM_API_KEY')}`, 'Content-Type': 'audio/webm' },
    body: audio,
  })
  if (!res.ok) throw new Error(`deepgram ${res.status}`)
  const j: any = await res.json()
  const words: Array<{ punctuated_word?: string; word: string; start: number }> =
    j?.results?.channels?.[0]?.alternatives?.[0]?.words ?? []
  // Deepgram's word.start is seconds into the FILE, whose timeline begins at
  // the first tapped source, NOT at capture start (verified 38.3s skew,
  // 2026-07-31). Convert the wall-clock window into file time via the anchor.
  const fileSinceMs = Math.max(0, sinceMs - anchorOffsetMs)
  return words
    .filter((w) => w.start * 1000 >= fileSinceMs)
    .map((w) => w.punctuated_word ?? w.word)
    .join(' ')
}
