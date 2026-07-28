import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { waitForMicOpen } from './reactive-mic'
import { startElementCapture } from './audio-capture'
import { appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Reusable steps — the "dictionary" of known procedures. A complex test in
 * natural language ("test interruption") decomposes into these + the
 * scenario-specific part. Specs call them directly; a brain (Stagehand /
 * MCP-connected agent) can call them as tools.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Agent must be IN its LiveKit room before the browser joins (join-race). */
export async function ensureAgentInRoom(agentUrl: string) {
  await fetch(`${agentUrl}/connect-room`, { method: 'POST' }).catch(() => {})
  await expect(async () => {
    const h: any = await fetch(`${agentUrl}/health`).then((r) => r.json())
    expect(h?.livekit?.status).toBe('connected')
  }).toPass({ timeout: 60_000, intervals: [1_000] })
}

/**
 * From a fresh page at the chat URL to an unmuted mic in a NEW conversation.
 * Handles both gate variants (page-level and in-room resume prompt, which
 * mutes the mic until answered). `act` is the brain's natural-language
 * executor — Stagehand's act(), or any function that can follow the prompt.
 */
export async function enterFreshRoom(
  page: Page,
  act: (instruction: string) => Promise<unknown>,
  chatUrl: string,
  opts?: { earsOn?: boolean; agentUrl?: string; entry?: 'fresh' | 'resume'; _retried?: boolean },
): Promise<{ captureStartedAt: number | null }> {
  // Chromium in containers intermittently throws net::ERR_TIMED_OUT on the
  // first navigation (curl from the same container succeeds — DNS/IPv6
  // preference quirk). Retry a few times before declaring failure.
  let lastNavErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(chatUrl, { timeout: 45_000 })
      lastNavErr = null
      break
    } catch (e) {
      lastNavErr = e
      await page.waitForTimeout(3_000)
    }
  }
  if (lastNavErr) throw lastNavErr
  let captureStartedAt: number | null = null
  if (opts?.earsOn) {
    // Ears from page-load: the greeting TTS fires the moment the session gate
    // completes — starting capture any later silently drops the first agent
    // message from replays (and hides real greeting-delivery bugs, which the
    // user has observed in production).
    await startElementCapture(page)
    captureStartedAt = Date.now()
  }
  const gateText = page.getByText(/previous sessions/i).first()
  const gateInstruction =
    opts?.entry === 'resume'
      ? 'A "Previous Sessions" panel asks whether to continue a previous conversation or start fresh. Click the option that CONTINUES/RESUMES the most recent previous conversation.'
      : 'A "Previous Sessions" panel asks whether to continue a previous conversation or start fresh. Click the option that STARTS A FRESH/NEW conversation.'
  const dismiss = async () => {
    if (await gateText.isVisible().catch(() => false)) {
      await act(gateInstruction)
    }
  }
  await Promise.race([
    gateText.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {}),
    page.waitForFunction(() => (window as any).__mic?.ready === true, undefined, { timeout: 45_000 }).catch(() => {}),
  ])
  await dismiss()
  await waitForMicOpen(page, 90_000)
  await gateText.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {})
  await dismiss()
  await page.waitForTimeout(8_000) // unmute + greeting settles

  // Alone-timer race: the agent leaves the room ~3min after the previous user
  // departs — which can happen WHILE we're entering (slow container run,
  // 2026-07-28 02:10). We'd then speak into an agent-less room. Verify the
  // agent is still in the room; if not, rejoin it and reload once so the join
  // ORDER is agent-first (required on agents <0.9.76 which don't adopt
  // pre-existing participants).
  if (opts?.agentUrl && !opts._retried) {
    const h: any = await fetch(`${opts.agentUrl}/health`).then((r) => r.json()).catch(() => null)
    if (h?.livekit?.status !== 'connected') {
      await ensureAgentInRoom(opts.agentUrl)
      return enterFreshRoom(page, act, chatUrl, { ...opts, _retried: true })
    }
  }
  return { captureStartedAt }
}

/**
 * Drain speech events from the ears (see startElementCapture's analyser).
 * Events: { type: 'speech-start' | 'speech-stop', t: epoch-ms }
 */
export async function drainSpeechEvents(page: Page): Promise<Array<{ type: string; t: number }>> {
  return page.evaluate(() => ((window as any).__osbornEars ?? []).splice(0))
}

/** Wait until an event of `type` arrives; returns its timestamp. */
export async function waitForSpeechEvent(
  page: Page,
  type: 'speech-start' | 'speech-stop',
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const evs = await drainSpeechEvents(page)
    const hit = evs.find((e) => e.type === type)
    if (hit) return hit.t
    await page.waitForTimeout(100)
  }
  throw new Error(`timed out waiting for ${type} after ${timeoutMs}ms`)
}

/**
 * STALL WATCHDOG + ESCALATION LADDER. The app can wedge on "Connecting..."
 * (room-code rotation race, agent absent, network blip). Instead of hanging
 * until the test timeout, this: (1) lets the BRAIN look at the screen and
 * click any visible recovery control, (2) hard-recovers — re-seats the agent
 * in its room and reloads so the page binds to a FRESH room code, (3) if all
 * fails, exits loudly with evidence (screenshot + agent /health), never hangs.
 * Returns { reloaded } — callers must restart in-page capture after a reload.
 */
export async function ensureSessionLive(
  page: Page,
  act: (instruction: string) => Promise<unknown>,
  chatUrl: string,
  opts?: { agentUrl?: string; attempts?: number; diagnostics?: () => string },
): Promise<{ reloaded: boolean }> {
  let reloaded = false
  const maxAttempts = opts?.attempts ?? 2
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 45s: cold session init (Claude subprocess spawn) legitimately shows
    // "Connecting..." for 20-30s — don't treat warmup as a stall.
    if (!(await stuckOnConnecting(page, 45_000))) return { reloaded }
    console.log(`[recover] stuck on "Connecting..." — attempt ${attempt + 1}/${maxAttempts}`)
    // Rung 1: the brain looks for a RECOVERY control only. Never Cancel/
    // Leave/Back — the Connecting screen's Cancel fully disconnects the
    // session (observed: the brain obediently clicked it and bailed).
    // Give the brain its DevTools sense: console/network signals, exactly
    // what a human would check before deciding what's wrong.
    const devtools = opts?.diagnostics?.() ?? ''
    await act(
      'The app appears stuck on a "Connecting..." screen. If there is a RETRY or RECONNECT button, click it. Do NOT click Cancel, Leave, Back, or anything that exits. If no retry control exists, do nothing.' +
        (devtools ? `\n\nDEVTOOLS VIEW (judge whether something is broken):\n${devtools.slice(0, 1500)}` : ''),
    ).catch(() => {})
    await page.waitForTimeout(8_000)
    if (!(await stuckOnConnecting(page, 5_000))) return { reloaded }
    // Rung 2: hard recovery — agent back in its room, fresh page = fresh
    // room-code binding (heals stale-room splits on agents <0.9.77).
    if (opts?.agentUrl) await ensureAgentInRoom(opts.agentUrl)
    await page.reload().catch(() => {})
    reloaded = true
    await enterFreshRoom(page, act, chatUrl, { agentUrl: opts?.agentUrl, _retried: true })
  }
  if (!(await stuckOnConnecting(page, 10_000))) return { reloaded }
  // Rung 3: ESCALATE TO THE SUPERVISOR — a main agent with privileged senses
  // (backend logs, knowledge base) may be watching the flight log. Hand it
  // the frontend view and wait for guidance before giving up.
  {
    const { requestAssistance } = await import('./flightlog')
    const res = await requestAssistance({
      problem: 'stuck on "Connecting..." after self-recovery attempts',
      url: page.url(),
      screenText: await page.evaluate(() => document.body.innerText.slice(-800)).catch(() => ''),
      devtools: opts?.diagnostics?.().slice(0, 2000) ?? '',
      agentUrl: opts?.agentUrl,
    })
    if (res?.instruction) {
      console.log(`[recover] supervisor instruction: ${res.instruction.slice(0, 120)}`)
      await act(res.instruction).catch(() => {})
      if (!(await stuckOnConnecting(page, 15_000))) return { reloaded }
    } else if (res?.command === 'retry' || res?.command === 'reload') {
      if (opts?.agentUrl) await ensureAgentInRoom(opts.agentUrl)
      await page.reload().catch(() => {})
      reloaded = true
      await enterFreshRoom(page, act, chatUrl, { agentUrl: opts?.agentUrl, _retried: true })
      if (!(await stuckOnConnecting(page, 30_000))) return { reloaded }
    }
  }
  // Rung 4: end-game — fail with evidence, never hang.
  const { tmpdir } = await import('os')
  const shot = join(tmpdir(), `stuck-connecting-${Date.now()}.jpeg`)
  await page.screenshot({ path: shot, type: 'jpeg', quality: 70 }).catch(() => {})
  const health = opts?.agentUrl
    ? await fetch(`${opts.agentUrl}/health`).then((r) => r.text()).catch(() => 'unreachable')
    : 'n/a'
  throw new Error(
    `Stuck on "Connecting..." after ${maxAttempts} recovery attempts. Screenshot: ${shot} — agent /health: ${health.slice(0, 250)}` +
      (opts?.diagnostics ? `\n\n${opts.diagnostics().slice(0, 1200)}` : ''),
  )
}

async function stuckOnConnecting(page: Page, forMs: number): Promise<boolean> {
  const deadline = Date.now() + forMs
  while (Date.now() < deadline) {
    const visible = await page.getByText(/^connecting/i).first().isVisible().catch(() => false)
    if (!visible) return false
    await page.waitForTimeout(2_500)
  }
  return true
}

/**
 * ALWAYS call on test exit (afterEach): tells the agent to leave its LiveKit
 * room immediately so the machine starts its idle countdown from a clean
 * state instead of sitting in an empty room until the alone-timer/watchdog
 * races kick in (the 0.9.73 wedge breeding ground).
 */
export async function leaveRoom(agentUrl: string) {
  await fetch(`${agentUrl}/leave-room`, { method: 'POST' }).catch(() => {})
}

/** Append a structured run record — the raw material for trend analysis. */
export function logResult(scenario: string, data: Record<string, unknown>) {
  const dir = join(__dirname, '..', 'results')
  mkdirSync(dir, { recursive: true })
  appendFileSync(
    join(dir, 'runs.jsonl'),
    JSON.stringify({ scenario, at: new Date().toISOString(), ...data }) + '\n',
  )
}
