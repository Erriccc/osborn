import type { Page } from '@playwright/test'
import { waitForSpeechEvent } from './steps'
import { hearSince, screenTail } from './converse'

/**
 * PERCEPTION BUNDLE — the generic sensory pipeline the user described:
 *
 *   sound detected (speech-start event, default RMS threshold)
 *     → we're already recording (always-on)
 *     → sound stops (speech-stop)
 *     → package the CLIP as one bundle: audio transcript of exactly that
 *       window + screenshot + visible text
 *     → hand the whole bundle to the brain in one shot
 *
 * Nothing here references Osborn/voice-native selectors or behaviors — it's
 * media-element energy + pixels + text, so it works on any app that makes
 * sound (or with video: any app at all). One system, not two: the brain's
 * decision input is audio + visuals together.
 */

export type Perception = {
  heard: string // words spoken during the event window (audio, not captions)
  screenshotB64: string // what the screen looked like as the sound ended
  screenText: string // visible text tail (cheap context)
  startedAt: number // capture-relative ms
  endedAt: number
}

/**
 * Wait for the next audio event and return its full perception bundle.
 * `tCaptureStart` = epoch ms when startElementCapture began (for
 * capture-relative word timestamps).
 */
export async function perceiveNextUtterance(
  page: Page,
  tCaptureStart: number,
  opts?: { startTimeoutMs?: number; stopTimeoutMs?: number; settleMs?: number },
): Promise<Perception> {
  const sinceMs = Date.now() - tCaptureStart
  const startT = await waitForSpeechEvent(page, 'speech-start', opts?.startTimeoutMs ?? 90_000)
  const stopT = await waitForSpeechEvent(page, 'speech-stop', opts?.stopTimeoutMs ?? 120_000).catch(() => Date.now())
  await page.waitForTimeout(opts?.settleMs ?? 800) // let captions/UI catch up
  const [heard, shot, text] = await Promise.all([
    hearSince(page, sinceMs).catch(() => ''),
    page.screenshot({ type: 'jpeg', quality: 60 }).then((b) => b.toString('base64')),
    screenTail(page),
  ])
  return {
    heard,
    screenshotB64: shot,
    screenText: text,
    startedAt: startT - tCaptureStart,
    endedAt: stopT - tCaptureStart,
  }
}
