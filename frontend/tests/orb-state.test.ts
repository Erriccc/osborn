// Run: cd frontend && npx --yes tsx tests/orb-state.test.ts
// Spec (build plan L6a): error -> "Error" (never "Ready"); only idle -> "Ready";
// micOff && listening -> "Mic off"; precedence
// error > reconnecting > blocked > micOff > (muted) > agentState; muted badge independent.
import { resolveOrbState, baseOrbKey, ORB_VIEWS, type OrbInput } from '../src/lib/orb-state'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const AGENT_STATES: (string | null | undefined)[] = [
  'idle', 'listening', 'thinking', 'speaking', 'error',
  'connecting', 'initializing', 'pre-connect-buffering', 'disconnected',
  'bogus', '', null, undefined,
]
const FLAGS = ['micOff', 'muted', 'reconnecting', 'blocked', 'error'] as const

function allInputs(): OrbInput[] {
  const out: OrbInput[] = []
  for (const agentState of AGENT_STATES) {
    for (let mask = 0; mask < 1 << FLAGS.length; mask++) {
      const input: OrbInput = { agentState }
      FLAGS.forEach((f, i) => { (input as any)[f] = !!(mask & (1 << i)) })
      out.push(input)
    }
  }
  return out
}

// Independent oracle for the spec, written without reference to the impl.
function expectedKey(i: OrbInput): string {
  const s = i.agentState
  if (i.error || s === 'error') return 'error'
  if (i.reconnecting) return 'reconnecting'
  if (i.blocked) return 'blocked'
  if (s === 'listening' && i.micOff) return 'micOff'
  if (s === 'listening' && i.muted) return 'muted'
  if (s === 'idle') return 'idle'
  if (s === 'listening' || s === 'thinking' || s === 'speaking') return s
  if (s === 'connecting' || s === 'initializing' || s === 'pre-connect-buffering') return 'connecting'
  if (s === 'disconnected') return 'disconnected'
  return 'unknown'
}

// ── Named spec cases ──
t('agent_state error -> "Error", never "Ready"', () => {
  const v = resolveOrbState({ agentState: 'error' })
  eq(v.key, 'error', 'key'); eq(v.label, 'Error', 'label'); eq(v.colorVar, 'var(--voice-error)', 'color')
})
t('error prop with idle state -> "Error"', () => eq(resolveOrbState({ agentState: 'idle', error: true }).label, 'Error', 'label'))
t('idle -> "Ready"', () => eq(resolveOrbState({ agentState: 'idle' }).label, 'Ready', 'label'))
t('unknown / empty / null state -> not "Ready"', () => {
  for (const s of ['bogus', '', null, undefined]) ok(resolveOrbState({ agentState: s }).label !== 'Ready', `state ${JSON.stringify(s)} showed Ready`)
})
t('connecting/initializing -> "Connecting"', () => {
  for (const s of ['connecting', 'initializing']) eq(resolveOrbState({ agentState: s }).label, 'Connecting', s)
})
t('micOff && listening -> "Mic off"', () => eq(resolveOrbState({ agentState: 'listening', micOff: true }).label, 'Mic off', 'label'))
t('blocked && listening -> "Mic blocked", not "Listening"', () => eq(resolveOrbState({ agentState: 'listening', blocked: true }).label, 'Mic blocked', 'label'))
t('muted && listening -> "Muted", not "Listening"', () => eq(resolveOrbState({ agentState: 'listening', muted: true }).label, 'Muted', 'label'))
t('muted while speaking keeps "Speaking" + badge', () => {
  const v = resolveOrbState({ agentState: 'speaking', muted: true }); eq(v.label, 'Speaking', 'label'); eq(v.mutedBadge, true, 'badge')
})
t('reconnecting -> "Reconnecting"', () => eq(resolveOrbState({ agentState: 'listening', reconnecting: true }).label, 'Reconnecting', 'label'))
t('precedence: error > reconnecting > blocked > micOff > agentState', () => {
  eq(resolveOrbState({ agentState: 'listening', error: true, reconnecting: true, blocked: true, micOff: true }).key, 'error', 'error top')
  eq(resolveOrbState({ agentState: 'listening', reconnecting: true, blocked: true, micOff: true }).key, 'reconnecting', 'reconnecting 2nd')
  eq(resolveOrbState({ agentState: 'listening', blocked: true, micOff: true, muted: true }).key, 'blocked', 'blocked 3rd')
  eq(resolveOrbState({ agentState: 'listening', micOff: true, muted: true }).key, 'micOff', 'micOff 4th')
})
t('micOff does not override non-listening states', () => {
  for (const s of ['thinking', 'speaking', 'idle']) eq(resolveOrbState({ agentState: s, micOff: true }).key, s, s)
})
t('every view has distinct label and non-empty colour/anim', () => {
  const labels = Object.values(ORB_VIEWS).map(v => v.label)
  eq(new Set(labels).size, labels.length, 'distinct labels')
  for (const [k, v] of Object.entries(ORB_VIEWS)) { eq(v.key, k, 'key matches'); ok(v.colorVar && v.anim, `${k} colour/anim`) }
})
t('required visible states all exist', () => {
  for (const k of ['connecting', 'listening', 'thinking', 'speaking', 'muted', 'blocked', 'reconnecting', 'error']) ok(k in ORB_VIEWS, k)
})
t('baseOrbKey: only "idle" maps to idle', () => {
  for (const s of AGENT_STATES) if (s !== 'idle') ok(baseOrbKey(s) !== 'idle', `${String(s)} -> idle`)
})

// ── Exhaustive: every agentState x 2^5 flag combinations ──
let combos = 0
t('exhaustive combinations match spec oracle + invariants', () => {
  for (const i of allInputs()) {
    combos++
    const v = resolveOrbState(i)
    const tag = JSON.stringify(i)
    eq(v.key, expectedKey(i), `key for ${tag}`)
    eq(v.label, ORB_VIEWS[v.key].label, `label for ${tag}`)
    eq(v.mutedBadge, !!i.muted, `badge independent for ${tag}`)
    if (v.label === 'Ready') ok(i.agentState === 'idle' && !i.error && !i.reconnecting && !i.blocked, `Ready leaked for ${tag}`)
    if (v.label === 'Listening') ok(!i.muted && !i.micOff && !i.blocked && !i.reconnecting && !i.error, `Listening while not hearing for ${tag}`)
    if (i.error || i.agentState === 'error') eq(v.label, 'Error', `error for ${tag}`)
  }
})

const failed = results.filter(r => !r[1])
for (const [n, p, m] of results) console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? `\n      ${m}` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} passed (${combos} exhaustive combinations)`)
if (failed.length) process.exit(1)
