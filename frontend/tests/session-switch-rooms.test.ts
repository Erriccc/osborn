// Run: cd frontend && npx tsx tests/session-switch-rooms.test.ts
// Spec (#75, #74, #71) BLIND from the issues; public helper signatures only.
//  #75: every Rooms row has a clean non-empty title (never starts with [ or <,
//       never "Untitled session" when the session has any user text), a relative
//       time, and exactly one LIVE marker -- on the running session.
//  #74: after switch, UI shows B's history; failures are not appended to old transcript.
//  #71: /chat?session=X resumes X (does not start new).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { sessionDisplayTitle, deriveSessionTitle, sessionActivityTime, formatTime, UNTITLED_SESSION } from '../src/lib/sessions'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, '-', String(e.message).split('\n')[0].slice(0, 300)) }
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const rows = [
  { id: 'a1', lastMessage: '[time: 2026-11-06 16:14 local] fix the login bug', timestamp: ago(3600e3) },
  { id: 'a2', lastMessage: '<session_tail>\n2026-09-10 User: hi\n</session_tail> deploy the site', timestamp: ago(86400e3) },
  { id: 'a3', title: '[CONTEXT] leaked', lastMessage: 'plan the offsite trip', timestamp: ago(60e3) },
  { id: 'a4', title: '', lastMessage: 'write release notes', lastActivityAt: ago(5 * 60e3) },
  { id: 'a5', title: '<task-notification>', lastMessage: '[INTERRUPTED] x\n\nUser\'s message: "rename the repo"', timestamp: ago(2 * 86400e3) },
]

t('#75 titles non-empty, no [ or < prefix', () => {
  for (const r of rows) {
    const x = sessionDisplayTitle(r as any)
    assert.ok(x.length > 0 && !/^[\[<]/.test(x), `${r.id}: ${JSON.stringify(x)}`)
  }
})
t('#75 sessions with user text are not "Untitled session"', () => {
  for (const r of rows) assert.notEqual(sessionDisplayTitle(r as any), UNTITLED_SESSION, r.id)
})
t('#75 deriveSessionTitle(row) agrees: clean & not untitled', () => {
  for (const r of rows) {
    const x = deriveSessionTitle(r as any)
    assert.ok(!/^[\[<]/.test(x) && x !== UNTITLED_SESSION, `${r.id}: ${x}`)
  }
})
t('#75 truly empty session -> Untitled (not blank)', () => {
  assert.equal(sessionDisplayTitle({} as any), UNTITLED_SESSION)
})
t('#75 relative time present for every row', () => {
  for (const r of rows) {
    const s = formatTime(sessionActivityTime(r as any))
    assert.ok(s && /(ago|now|yesterday|today|\d)/i.test(s), `${r.id}: ${JSON.stringify(s)}`)
  }
})

// --- LIVE marker: pure helper contract. Rooms rows must expose exactly one live row.
// The Rooms list lives in a component; the test looks for the extracted pure model
// under src/lib (any file exporting a function whose name matches /room.*row|live/i).
const libDir = path.join(__dirname, '../src/lib')
function findLiveHelper(): ((rows: any[], liveId: string | null) => any[]) | null {
  for (const f of fs.readdirSync(libDir).filter((x) => /room|switch/i.test(x) && x.endsWith('.ts'))) {
    const mod: any = require(path.join(libDir, f))
    for (const k of Object.keys(mod)) if (/rows?|rooms?list/i.test(k) && typeof mod[k] === 'function') return mod[k]
  }
  return null
}
const helper = findLiveHelper()
t('#75 LIVE: exactly one row marked live, the running one (needs pure rooms-row helper in src/lib/*room*|*switch*)', () => {
  assert.ok(helper, 'no pure Rooms row model found in src/lib (room*/switch* exporting *rows*)')
  const out = helper!(rows.map((r) => ({ ...r, sessionId: r.id })), 'a3')
  const live = out.filter((r: any) => r.live === true || r.isLive === true)
  assert.equal(live.length, 1)
  assert.ok((live[0].id ?? live[0].sessionId) === 'a3')
})

// --- #74 / #71 wiring guards on the existing handlers
const vr = fs.readFileSync(path.join(__dirname, '../src/components/VoiceRoom.tsx'), 'utf8')
t('#74 failure for a switch is not appended to the old transcript as a bare system line', () => {
  const i = vr.indexOf("data.type === 'session_resume_failed'")
  assert.ok(i > 0)
  const body = vr.slice(i, i + 1200)
  assert.ok(!/Could not restore previous session\. Starting fresh conversation/.test(body.split("data.type === 'session_switched'")[0]) ,
    'session_resume_failed still dumps "Could not restore previous session" into current transcript')
})
t('#74 session_switched handler replaces messages with the new session history', () => {
  const i = vr.indexOf("data.type === 'session_switched'")
  assert.ok(i > 0)
  assert.ok(/setMessages\(/.test(vr.slice(i, i + 2500)))
})
t('#71 /chat?session=X is read from the URL and passed to the resume path', () => {
  const prov = fs.readFileSync(path.join(__dirname, '../src/components/ChatSessionProvider.tsx'), 'utf8')
  assert.ok(/searchParams|URLSearchParams|[?&]session=/.test(prov + vr), 'no ?session= handling')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
