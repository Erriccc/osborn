// Run: cd frontend && npx tsx tests/rooms-identity.test.ts
// #75 / #107: the collapsed Rooms rail must carry identity, not featureless
// dots. These are the pure helpers behind that: a project-derived label (with
// a title fallback for workspace-root sessions), a single avatar initial, a
// deterministic colour, and the project grouping — proven to surface EVERY
// distinct project folder's sessions. No React / browser needed.
// Folder names below are generic placeholders on purpose (no real user folder).
import assert from 'node:assert/strict'
import {
  buildRoomRows,
  groupRoomsByProject,
  roomAvatar,
  roomColor,
  roomIdentityLabel,
  roomInitial,
} from '../src/lib/rooms'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e.message).split('\n')[0].slice(0, 300)) }
}

// ── roomIdentityLabel ──────────────────────────────────────────────────────
t('identity label is the project folder for a normal session', () => {
  assert.equal(roomIdentityLabel({ project: 'alpha', title: 'Fix the login bug' }), 'alpha')
})

t('workspace-root session falls back to its own title (not generic "Workspace")', () => {
  // leaf === "workspace" would make every such row identical — use the title.
  assert.equal(roomIdentityLabel({ project: 'workspace', title: 'Plan the offsite' }), 'Plan the offsite')
  assert.equal(roomIdentityLabel({ project: 'Workspace', title: 'Plan the offsite' }), 'Plan the offsite')
})

t('a row with no project at all falls back to its title', () => {
  assert.equal(roomIdentityLabel({ title: 'Check the deploy logs' }), 'Check the deploy logs')
})

t('workspace-root with no title keeps the raw workspace label (last resort)', () => {
  assert.equal(roomIdentityLabel({ project: 'workspace' }), 'workspace')
  assert.equal(roomIdentityLabel({}), '')
})

t('two workspace-root sessions with different titles get DIFFERENT identities', () => {
  const a = roomIdentityLabel({ project: 'workspace', title: 'Draft the invoice' })
  const b = roomIdentityLabel({ project: 'workspace', title: 'Review the contract' })
  assert.notEqual(a, b)
})

// ── roomInitial ────────────────────────────────────────────────────────────
t('initial is the first letter/number of the identity label, uppercased', () => {
  assert.equal(roomInitial({ project: 'alpha' }), 'A')
  assert.equal(roomInitial({ project: 'workspace', title: 'draft the invoice' }), 'D')
  assert.equal(roomInitial({ project: '7-eleven-notes' }), '7')
})

t('initial skips leading punctuation/whitespace, falls back to # when empty', () => {
  assert.equal(roomInitial({ project: '  _beta' }), 'B')
  assert.equal(roomInitial({}), '#')
  assert.equal(roomInitial({ project: '***' }), '#')
})

t('initial still gives a glyph for a non-ASCII (non-English) project name', () => {
  assert.equal(roomInitial({ project: 'über-notes' }), 'Ü'.toUpperCase())
  assert.equal(roomInitial({ project: '日本語メモ' }), '日')
})

// ── roomColor ──────────────────────────────────────────────────────────────
t('colour is deterministic and case-insensitive for the same label', () => {
  assert.equal(roomColor('alpha').hue, roomColor('alpha').hue)
  assert.equal(roomColor('Alpha').hue, roomColor('alpha').hue)
  assert.equal(roomColor(' alpha ').hue, roomColor('alpha').hue)
})

t('hue is always a valid 0–359 integer', () => {
  for (const s of ['alpha', 'beta', 'gamma', 'workspace', '', 'x', 'a-very-long-project-name-here']) {
    const { hue } = roomColor(s)
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `${s} -> ${hue}`)
  }
})

t('distinct labels spread across different hues (not one colour for all)', () => {
  const labels = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
  const hues = new Set(labels.map((l) => roomColor(l).hue))
  assert.ok(hues.size >= 4, `expected spread, got ${hues.size} distinct hues`)
})

t('same project → same colour; so a folder reads as one colour across its rows', () => {
  assert.equal(roomColor(roomIdentityLabel({ project: 'alpha', title: 'one' })).hue,
    roomColor(roomIdentityLabel({ project: 'alpha', title: 'two' })).hue)
})

// ── roomAvatar (the one call the UI makes) ─────────────────────────────────
t('roomAvatar bundles label + initial + colour consistently', () => {
  const av = roomAvatar({ project: 'alpha', title: 'Fix the login bug' })
  assert.equal(av.label, 'alpha')
  assert.equal(av.initial, 'A')
  assert.equal(av.color.hue, roomColor('alpha').hue)
})

// ── groupRoomsByProject surfaces EVERY distinct project folder (#107) ───────
const NOW = Date.parse('2026-11-11T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60e3

t('grouping lists all distinct project folders, each with its own sessions', () => {
  // Three distinct project folders + the workspace root — generic names only.
  const sessions = [
    { sessionId: 's1', lastMessage: 'a1', timestamp: ago(1 * MIN), messageCount: 3, cwd: '/home/sprite/workspace/alpha' },
    { sessionId: 's2', lastMessage: 'a2', timestamp: ago(2 * MIN), messageCount: 3, cwd: '/home/sprite/workspace/alpha' },
    { sessionId: 's3', lastMessage: 'b1', timestamp: ago(3 * MIN), messageCount: 3, cwd: '/home/sprite/workspace/beta' },
    { sessionId: 's4', lastMessage: 'c1', timestamp: ago(4 * MIN), messageCount: 3, cwd: '/home/sprite/workspace/gamma' },
    { sessionId: 's5', lastMessage: 'root-level task', timestamp: ago(5 * MIN), messageCount: 3, cwd: '/home/sprite/workspace' },
  ]
  const rows = buildRoomRows(sessions, null, { now: NOW })
  const groups = groupRoomsByProject(rows)
  const projects = groups.map((g) => g.project)
  // every distinct folder present — not just the current one
  assert.deepEqual(new Set(projects), new Set(['alpha', 'beta', 'gamma', 'workspace']))
  const alpha = groups.find((g) => g.project === 'alpha')!
  assert.equal(alpha.rooms.length, 2, 'both alpha sessions grouped together')
  for (const g of groups) assert.ok(g.rooms.length >= 1)
  // no session is dropped
  assert.equal(groups.reduce((n, g) => n + g.rooms.length, 0), sessions.length)
})

t('rows with no project fall into an "Other" bucket shown last', () => {
  const rows = [
    { project: 'alpha' } as any,
    { project: undefined } as any,
    { project: 'beta' } as any,
  ]
  const groups = groupRoomsByProject(rows)
  assert.equal(groups[groups.length - 1].project, 'Other')
  assert.equal(groups.length, 3)
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
