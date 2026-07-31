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
  const key = optionalEnvKey('OPENAI_API_KEY')
  if (!key) throw new Error('OPENAI_API_KEY required for conversation generation')
  const userText =
    `GOAL: ${goal}\n\nCONVERSATION SO FAR (AGENT lines are what you HEARD, transcribed from audio):\n` +
    (history.map((t) => `${t.speaker.toUpperCase()}: ${t.text}`).join('\n') || '(none — you speak first)') +
    `\n\nCURRENT SCREEN TEXT (tail):\n${screenTail.slice(-1200)}`
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
        {
          role: 'system',
          content:
            'You are a QA tester having a NATURAL spoken conversation with a voice AI assistant, by phone-call style voice. ' +
            'You perceive the app through a bundle: audio you heard (transcribed), the current screenshot, and screen text. ' +
            'Compose the next thing to say out loud: conversational, 1-2 short sentences, no stage directions, no quotes. ' +
            'Vary your phrasing naturally — never repeat earlier wording. Pursue the GOAL; react to what the assistant actually said and what you see. ' +
            'When the goal is complete (or clearly stuck), end the conversation politely. ' +
            'Reply as JSON: {"say": "<utterance or null when done>", "reason": "<one line why>"}',
        },
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
