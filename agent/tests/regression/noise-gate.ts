/**
 * Noise-gate contract — pins the v1 gate behaviors:
 *   G1  shouldGate rules: off by default; kill switch; '['-prefixed synthetic
 *       texts never gated; allowOnce is one-shot
 *   G2  setEnabled respects the kill switch; state events fire on change
 *   G3  classify is FAIL-OPEN: no OPENROUTER_API_KEY → 'directed' (no network)
 *   G4  drops are tombstoned: ring buffer + 'drop' event, never silently lost
 *   G5  (anchored) pipeline gate block sits BEFORE session-tail/interrupt-ctx
 *       enrichment, re-enters chat() with the gateApproved bypass, and the
 *       deferred stream catches its own errors
 *   G6  (anchored) meeting chunks auto-engage the gate and count as activity
 *   G7  (anchored) index.ts wires noise_cancel / gate_send_anyway / auto_exit
 *       (resume note is [SYSTEM-prefixed so it can never carry priority 'now')
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, anchoredSlice, AGENT_DIR, sandboxHome } from './_shared.js'

sandboxHome()

delete process.env.OSBORN_NOISE_GATE
delete process.env.OPENROUTER_API_KEY

const { noiseGate } = await import('../../src/noise-gate.js')

// G1/G2 — shouldGate + kill switch + allowOnce
check('G1a', noiseGate.shouldGate('hello there') === false, 'gate is OFF by default — nothing gated')
noiseGate.setEnabled(true, 'ui')
check('G1b', noiseGate.enabled === true && noiseGate.shouldGate('hello there') === true, 'enabled → raw text gated')
check('G1c', noiseGate.shouldGate('[MEETING — main] x') === false, '[MEETING synthetic text never gated')
check('G1d', noiseGate.shouldGate('[SYSTEM note] x') === false, '[SYSTEM synthetic text never gated')
check('G1e', noiseGate.shouldGate('   ') === false, 'whitespace never gated')
noiseGate.allowOnce('send this anyway')
check('G1f', noiseGate.shouldGate('send this anyway') === false, 'allowOnce bypasses the gate once')
check('G1g', noiseGate.shouldGate('send this anyway') === true, 'allowOnce is ONE-shot — second pass gated again')
noiseGate.setEnabled(false, 'ui')

process.env.OSBORN_NOISE_GATE = 'off'
noiseGate.setEnabled(true, 'ui')
check('G2a', noiseGate.enabled === false, 'kill switch: setEnabled(true) is a no-op under OSBORN_NOISE_GATE=off')
delete process.env.OSBORN_NOISE_GATE

let stateEvents = 0
const onState = () => { stateEvents++ }
noiseGate.on('state', onState)
noiseGate.setEnabled(true, 'meeting')
noiseGate.setEnabled(true, 'meeting') // no change → no event
noiseGate.setEnabled(false, 'ui')
noiseGate.removeListener('state', onState)
check('G2b', stateEvents === 2, `state event fires only on CHANGE (got ${stateEvents}, want 2)`)

// G3 — fail-open without API key (no network possible)
const verdict = await noiseGate.classify('anything at all', { recentTurns: [], activeWork: '' })
check('G3a', verdict === 'directed', `no OPENROUTER_API_KEY → fail-open 'directed' (got ${verdict})`)

// G4 — tombstones
let dropEvent: any = null
noiseGate.once('drop', (d: any) => { dropEvent = d })
noiseGate.recordDrop('stranger talk', 'side_talk')
check('G4a', dropEvent?.text === 'stranger talk' && dropEvent?.verdict === 'side_talk', "'drop' event carries text+verdict")
check('G4b', noiseGate.getDropped().some((d: any) => d.text === 'stranger talk'), 'dropped ring retains the utterance')

// G5 — pipeline anchors
const pipeSrc = readFileSync(join(AGENT_DIR, 'src/pipeline-direct-llm.ts'), 'utf8')
const chatIdx = pipeSrc.indexOf('chat({')
const gateIdx = pipeSrc.indexOf('noiseGate.shouldGate(userText)', chatIdx)
const tailIdx = pipeSrc.indexOf('postCompactionTailPending', chatIdx)
const ctxIdx = pipeSrc.indexOf('getAndConsumeInterruptionContext', chatIdx)
check('G5a', gateIdx > 0 && tailIdx > 0 && gateIdx < tailIdx, 'gate check precedes session-tail enrichment in chat()')
check('G5b', gateIdx > 0 && ctxIdx > 0 && gateIdx < ctxIdx, 'gate check precedes interruption-context consumption in chat()')
check('G5c', /gateApproved\.add\(chatCtx\)[\s\S]{0,120}this\.chat\(\{/.test(pipeSrc), 'forward verdict re-enters chat() with the bypass marker')
check('G5d', /!gateApproved\.has\(chatCtx\)/.test(pipeSrc), 'bypass marker checked at the gate entry')
const gsSlice = anchoredSlice(pipeSrc, 'class NoiseGateStream', { len: 1200 })
check('G5e', /protected async run\(\)[\s\S]*?catch/.test(gsSlice), 'NoiseGateStream.run catches its own errors')

// G6 — meeting coupling anchors
check('G6a', /isMeetingChunk[\s\S]{0,400}noiseGate\.setEnabled\(true, 'meeting'\)/.test(pipeSrc), 'meeting chunks auto-engage the gate')
check('G6b', /isMeetingChunk[\s\S]{0,500}noiseGate\.noteActivity\(\)/.test(pipeSrc), 'meeting chunks count as activity (no mid-meeting silence exit)')

// G7 — index wiring anchors
const idxSrc = readFileSync(join(AGENT_DIR, 'src/index.ts'), 'utf8')
check('G7a', /data\.type === 'noise_cancel'/.test(idxSrc), "index handles the UI 'noise_cancel' toggle")
check('G7b', /data\.type === 'gate_send_anyway'/.test(idxSrc) && /noiseGate\.allowOnce\(text\)/.test(idxSrc), 'send-anyway allow-lists the text one-shot')
const autoExit = anchoredSlice(idxSrc, "noiseGate.on('auto_exit'", { len: 700 })
check('G7c', /\[SYSTEM note/.test(autoExit) && /sendPrompt/.test(autoExit), "auto_exit pushes a [SYSTEM-prefixed resume note (never priority 'now')")
check('G7d', /noiseGate\.on\('drop'/.test(idxSrc) && /gate_dropped/.test(idxSrc), 'drops are forwarded to the frontend (tombstones)')

finish('noise-gate')
