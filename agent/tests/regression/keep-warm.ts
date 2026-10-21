/**
 * Keep-warm re-attach contract (sub-second reconnect, 0.9.258).
 *
 * The parked-subprocess path is the cost-critical "$123 bug" shape: a live
 * Claude subprocess kept alive across a disconnect. These checks are the
 * adversarial gates that must hold for it to ship — they encode the red-team's
 * invariants as source-anchored assertions (the helpers are closure-local in a
 * 6k-line file, so we assert structure, same style as steering-stop.ts).
 *
 *   K1  default-ON with an `=off` escape hatch — KEEP_WARM is `!== 'off'` so it
 *       ships live (user directive). Safety comes from the watchdog + teardown
 *       invariants (K6/K7/K8), NOT the flag, but a kill switch MUST still exist.
 *   K2  DisconnectReason imported from rtc-node (handoff detection).
 *   K3  one-owner / no-leak — the connect re-attach path frees a non-matching or
 *       expired warm brain (killWarm) instead of orphaning it.
 *   K4  LISTENER HYGIENE (the double-TTS guard) — every event wired by
 *       createDirectSession via directLLM.events.on/once is also in the
 *       DIRECT_SESSION_WIRED_EVENTS strip list. Catches drift: add a wired
 *       event, forget the strip list → double listener on re-attach.
 *   K5  handoff preserves the warm brain — the DUPLICATE_IDENTITY branch parks
 *       (not kills) and does NOT releaseAgents (incoming device continues).
 *   K6  teardown invariant on a network-drop park — STILL releaseAgents +
 *       armFastLeaveTimer so the empty room can't burn (parked brain is off the
 *       currentLLM/slots graph, so agentsActive() is false).
 *   K7  independent watchdog — armWarmTimers arms BOTH a grace timer and a
 *       watchdog, and BOTH tear down (killWarm + releaseAgents + armIdleExit).
 *   K8  killWarm clears BOTH timers (no double-fire) and aborts the subprocess.
 *   K9  parkWarm no-sessionId guard — aborts instead of parking an unkeyable brain.
 *   K10 claimWarm does NOT abort (it's the reuse path — abort would kill reuse).
 *   K11 re-attach awaits pendingSessionClose before createDirectSession (byte race).
 *   K12 cold path intact — the non-reattach branch still cold-starts (additive).
 */
import { readSource, anchoredSlice, balancedBlock, stripComments, check, finish } from './_shared.js'

const src = readSource('agent/src/index.ts')
const code = stripComments(src)

// ── K1: default-ON with an `=off` escape hatch ──────────────────────────────
const defaultOn = /const KEEP_WARM = process\.env\.OSBORN_KEEP_WARM !== 'off'/.test(code)
check('K1', defaultOn, 'KEEP_WARM defaults ON with an OSBORN_KEEP_WARM=off kill switch (safety = watchdog/teardown, not the flag)')

// ── K2: DisconnectReason imported ───────────────────────────────────────────
check('K2', /import\s*\{[^}]*\bDisconnectReason\b[^}]*\}\s*from\s*'@livekit\/rtc-node'/.test(code),
  'DisconnectReason imported from @livekit/rtc-node')

// ── K3: one-owner / no-leak on the connect re-attach path ───────────────────
const connectBranch = anchoredSlice(code, 'let reattached = false', { len: 1200 })
check('K3a', /warmSessionId === resumeSessionId && Date\.now\(\) < warmExpiry/.test(connectBranch),
  're-attach gated on exact session match AND unexpired grace')
check('K3b', /else if \(warmLLM\)\s*\{\s*killWarm\(/.test(connectBranch),
  'non-matching / expired warm brain is freed (killWarm) — no orphan')

// ── K4: LISTENER HYGIENE — strip list ⊇ wired events (double-TTS guard) ──────
// All events createDirectSession wires on directLLM.events.{on,once}('NAME').
const wiredRe = /directLLM\.events\.(?:on|once)\(\s*'([^']+)'/g
const wired = new Set<string>()
for (let m; (m = wiredRe.exec(code)); ) wired.add(m[1])
// The declared strip list literal.
const listLit = anchoredSlice(src, 'const DIRECT_SESSION_WIRED_EVENTS = [', { endAnchor: ']' })
const stripList = new Set([...listLit.matchAll(/'([^']+)'/g)].map(m => m[1]))
const missing = [...wired].filter(e => !stripList.has(e))
check('K4a', wired.size >= 10, `found ${wired.size} wired events on directLLM.events (sanity)`)
check('K4b', missing.length === 0,
  missing.length ? `strip list MISSING wired events: ${missing.join(', ')}` : 'strip list covers every wired event (no double-wire on re-attach)')
// And the strip actually runs before the first wiring.
const stripIdx = code.indexOf('for (const ev of DIRECT_SESSION_WIRED_EVENTS)')
const firstWireIdx = code.search(/directLLM\.events\.(?:on|once)\(/)
check('K4c', stripIdx > 0 && firstWireIdx > 0 && stripIdx < firstWireIdx,
  'listeners stripped BEFORE the first (re-)wire')

// ── K5: handoff preserves the warm brain ────────────────────────────────────
const dupBranch = anchoredSlice(code, 'DisconnectReason.DUPLICATE_IDENTITY',
  { endAnchor: 'else if (KEEP_WARM && currentLLM' })
check('K5a', /parkWarm\('duplicate_identity'\)/.test(dupBranch), 'DUPLICATE_IDENTITY branch PARKS the brain')
check('K5b', !/killCurrentLLM\(|releaseAgents\(\)/.test(dupBranch),
  'DUPLICATE_IDENTITY branch does NOT kill/releaseAgents (incoming device continues)')

// ── K6: teardown invariant on a network-drop park ───────────────────────────
// The keep-warm network branch: parks, then STILL releaseAgents + fast-leave.
const netBranch = anchoredSlice(code,
  "else if (KEEP_WARM && currentLLM && (currentLLM as any).sessionId)", { len: 500 })
check('K6a', /parkWarm\('participant_disconnected'\)/.test(netBranch), 'network-drop branch parks the brain')
check('K6b', /releaseAgents\(\)/.test(netBranch) && /armFastLeaveTimer\(\)/.test(netBranch),
  'network-drop branch STILL tears the room down (releaseAgents + fast-leave) — no empty-room burn')

// ── K7: independent watchdog ────────────────────────────────────────────────
const armTimers = balancedBlock(code, code.indexOf('const armWarmTimers'))
check('K7a', /warmGraceTimer = setTimeout/.test(armTimers) && /warmWatchdog = setTimeout/.test(armTimers),
  'armWarmTimers arms BOTH a grace timer and an independent watchdog')
const graceClause = armTimers.slice(armTimers.indexOf('warmGraceTimer = setTimeout'), armTimers.indexOf('warmWatchdog = setTimeout'))
const watchClause = armTimers.slice(armTimers.indexOf('warmWatchdog = setTimeout'))
const tearsDown = (s: string) => /killWarm\(/.test(s) && /releaseAgents\(\)/.test(s) && /armIdleExitTimer\(/.test(s)
check('K7b', tearsDown(graceClause), 'grace expiry → killWarm + releaseAgents + armIdleExit')
check('K7c', tearsDown(watchClause), 'watchdog ceiling → killWarm + releaseAgents + armIdleExit (independent backstop)')

// ── K8: killWarm clears both timers + aborts ────────────────────────────────
const killWarm = balancedBlock(code, code.indexOf('const killWarm = (reason: string)'))
check('K8a', /clearTimeout\(warmGraceTimer\)/.test(killWarm) && /clearTimeout\(warmWatchdog\)/.test(killWarm),
  'killWarm clears BOTH timers (no grace/watchdog double-fire)')
check('K8b', /abortQuery\(\)/.test(killWarm) && /abortAgent\(\)/.test(killWarm),
  'killWarm aborts the subprocess (duck-typed abortQuery/abortAgent)')
check('K8c', /warmLLM = null/.test(killWarm) && /warmSessionId = null/.test(killWarm),
  'killWarm nulls warm state (slot empty after)')

// ── K9: parkWarm no-sessionId guard ─────────────────────────────────────────
const parkWarm = balancedBlock(code, code.indexOf('const parkWarm = (reason: string)'))
check('K9', /if \(!sid\)/.test(parkWarm) && /killCurrentLLM\(reason \+ '_no_sessionid'\)/.test(parkWarm),
  'parkWarm aborts (not parks) when there is no sessionId to key re-attach on')
check('K9b', /warmExpiry = Date\.now\(\) \+ REATTACH_GRACE_MS/.test(parkWarm) && /currentLLM = null/.test(parkWarm),
  'parkWarm sets expiry and clears currentLLM (one-owner handoff into warm slot)')

// ── K10: claimWarm must NOT abort (reuse path) ──────────────────────────────
const claimWarm = balancedBlock(code, code.indexOf('const claimWarm ='))
check('K10', !/abortQuery\(|abortAgent\(/.test(claimWarm),
  'claimWarm does NOT abort the subprocess (it is the REUSE path)')
check('K10b', /clearTimeout\(warmGraceTimer\)/.test(claimWarm) && /clearTimeout\(warmWatchdog\)/.test(claimWarm),
  'claimWarm cancels both timers (reused brain is no longer on the teardown clock)')

// ── K11: re-attach awaits pendingSessionClose ───────────────────────────────
check('K11', /const reused = claimWarm\(\)\s*\n\s*if \(pendingSessionClose\) \{ try \{ await pendingSessionClose/.test(code.replace(/\r/g, '')),
  're-attach awaits pendingSessionClose before createDirectSession (byte-stream race)')

// ── K12: cold path intact (additive) ────────────────────────────────────────
check('K12', /if \(!reattached\) \{/.test(code) && /createPipelineDirectLLM\(\{/.test(code),
  'cold-start path preserved under `if (!reattached)` — keep-warm is purely additive')

finish('keep-warm')
