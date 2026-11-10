// Run: cd frontend && npx --yes tsx tests/outputs-cross-account.test.ts
// Spec (#57): the favorites localStorage cache must be namespaced by signed-in
// user id so one account's pinned files can never seed — or be shown to — the
// next account that signs in on the same browser. The Outputs "Pinned" section
// is driven by this cache (favoriteFiles -> pinnedPaths -> groupOutputs), so if
// the key is global, a brand-new account inherits a prior account's pins.
import {
  favoritesStorageKey, LEGACY_FAVORITES_KEY, groupOutputs, type OutputFile,
} from '../src/lib/outputs-model'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const A = 'aaaaaaaa-1111-2222-3333-444444444444'
const B = 'bbbbbbbb-5555-6666-7777-888888888888'

t('two accounts get distinct cache keys', () => {
  ok(favoritesStorageKey(A) !== favoritesStorageKey(B), 'account A and B must not share a key')
})

t('guest key is distinct from any account key', () => {
  ok(favoritesStorageKey(null) !== favoritesStorageKey(A), 'guest vs account A')
  eq(favoritesStorageKey(null), favoritesStorageKey(undefined), 'null and undefined both map to guest')
})

t('the per-account key never equals the pre-#57 global key', () => {
  // Legacy residue must never be read back as an account cache.
  for (const u of [A, B, null, '']) ok(favoritesStorageKey(u as any) !== LEGACY_FAVORITES_KEY, `key for ${u} must not equal legacy global key`)
})

t('key is stable for the same account', () => {
  eq(favoritesStorageKey(A), favoritesStorageKey(A), 'same account, same key')
})

// Integration: a fresh account whose cache is empty must show an EMPTY Pinned
// section even when another account's files are around in the (shared) list.
t('fresh account with empty favorites shows no pinned files', () => {
  const file = (name: string): OutputFile => ({
    filePath: `/root/.claude/projects/-other/osb/${A}/${name}`,
    fileName: name, type: 'notes', updatedAt: new Date('2025-08-10T00:00:00Z'),
  })
  const otherWorkspaceFiles = [file('plan.md'), file('notes.md')]
  // pinnedPaths come from the signed-in account's (empty) favorites cache.
  const groups = groupOutputs(otherWorkspaceFiles, {
    now: Date.now(), sessionId: null, joinedAt: 0, pinnedPaths: new Set<string>(),
  })
  eq(groups.pinned.length, 0, 'no files may land in Pinned for a fresh account')
})

// ── report ───────────────────────────────────────────────────────────────────
let failed = 0
for (const [name, pass, err] of results) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${err ? `  — ${err}` : ''}`)
  if (!pass) failed++
}
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed) process.exit(1)
