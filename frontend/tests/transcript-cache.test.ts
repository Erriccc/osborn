// Run: cd frontend && npx --yes tsx tests/transcript-cache.test.ts
// Spec (#136/#71): the optimistic transcript cache paints the resumed session's
// last-known history instantly on reload, then the authoritative replay drops
// and replaces it. These tests pin the pure behaviour: what gets serialized,
// round-trips, is bounded/evicted, is scoped to ONE account, and is cleared on
// sign-out.
import {
  TRANSCRIPT_CACHE_PREFIX,
  cacheTranscript,
  readCachedTranscript,
  clearSignOutLocalState,
  serializeTranscript,
  type CacheStorage,
} from '../src/lib/transcript-cache'
import type { ChatMessage } from '../src/components/voice/shared'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, String(e?.message || e).slice(0, 400)) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

// In-memory Storage fake (localStorage shape).
function fakeStorage(): CacheStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() { return map.size },
    key(i: number) { return Array.from(map.keys())[i] ?? null },
    getItem(k: string) { return map.has(k) ? map.get(k)! : null },
    setItem(k: string, v: string) { map.set(k, v) },
    removeItem(k: string) { map.delete(k) },
  }
}

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1', role: 'user', content: 'hello', timestamp: new Date('2026-11-11T19:00:00Z'), ...over,
})

t('serialize drops streaming, empty and local system rows; keeps cached history', () => {
  const items = serializeTranscript([
    msg({ id: 'u1', role: 'user', content: 'first question' }),
    msg({ id: 'a1', role: 'assistant', content: 'an answer' }),
    msg({ id: 's1', role: 'assistant', content: 'still typing', isStreaming: true }),
    msg({ id: 'e1', role: 'assistant', content: '' }),
    // Still the history on screen during a cold boot: re-serialized, or the
    // first live turn would overwrite the key and destroy it.
    msg({ id: 'r1', role: 'assistant', content: 'painted from cache', fromCache: true }),
    msg({ id: 'n1', role: 'system', content: '⚠️ local-only notice' }),
    msg({ id: 'c1', role: 'system', content: '', compaction: { skillNames: [], skillsWritten: 0, at: 1 } }),
  ])
  eq(items.map(i => i.id), ['u1', 'a1', 'r1', 'c1'], 'kept ids')
  eq(items[3].compaction, { skillNames: [], skillsWritten: 0, at: 1 }, 'compaction passed through')
})

t('a cold boot that speaks before the replay keeps its cached history', () => {
  const s = fakeStorage()
  cacheTranscript('u1', 'sess', [msg({ id: 'p1', role: 'user', content: 'yesterday' })], s)
  const painted = readCachedTranscript('u1', 'sess', s)
  eq(painted.map(m => m.content), ['yesterday'], 'painted from cache')
  // The paint effect re-adds those rows flagged fromCache; the user then speaks.
  cacheTranscript('u1', 'sess', [
    ...painted.map(m => msg({ id: m.id, role: m.role, content: m.content, fromCache: true })),
    msg({ id: 'live1', role: 'user', content: 'today' }),
  ], s)
  eq(readCachedTranscript('u1', 'sess', s).map(m => m.content), ['yesterday', 'today'], 'history survives')
})

t('serialize drops synthetic day/Today dividers, keeps real messages', () => {
  const items = serializeTranscript([
    msg({ id: 'prior-day-Nov 11-sess', role: 'assistant', content: '── Nov 11 ──' }),
    msg({ id: 'prior-0-sess', role: 'user', content: 'real question' }),
    msg({ id: 'prior-sep-sess', role: 'assistant', content: '── Today ──' }),
    msg({ id: 'live-1', role: 'assistant', content: 'live answer' }),
  ])
  eq(items.map(i => i.id), ['prior-0-sess', 'live-1'], 'dividers dropped, messages kept')
})

t('round-trips through storage keyed by session id', () => {
  const s = fakeStorage()
  cacheTranscript('u1', 'sessA', [msg({ id: 'u1', content: 'hi A' })], s)
  cacheTranscript('u1', 'sessB', [msg({ id: 'u1', content: 'hi B' })], s)
  eq(readCachedTranscript('u1', 'sessA', s).map(m => m.content), ['hi A'], 'A isolated')
  eq(readCachedTranscript('u1', 'sessB', s).map(m => m.content), ['hi B'], 'B isolated')
  eq(readCachedTranscript('u1', 'missing', s), [], 'unknown session → empty')
})

// ── The #57-class leak, now for transcript text ──
t('one account never reads the next account\'s cached transcript', () => {
  const s = fakeStorage()
  cacheTranscript('user-a', 'sess', [msg({ id: 'u1', content: 'account A transcript' })], s)
  eq(readCachedTranscript('user-b', 'sess', s), [], 'the next account reads nothing')
  eq(readCachedTranscript(null, 'sess', s), [], 'a guest reads nothing')
  eq(readCachedTranscript('user-a', 'sess', s).map(m => m.content), ['account A transcript'], 'A still reads its own')
})

t('never clobbers a good cache with an empty transcript', () => {
  const s = fakeStorage()
  cacheTranscript('u1', 'sess', [msg({ id: 'u1', content: 'real' })], s)
  cacheTranscript('u1', 'sess', [], s) // e.g. the setMessages([]) during a switch
  cacheTranscript('u1', 'sess', [msg({ id: 's1', isStreaming: true })], s) // only streaming
  eq(readCachedTranscript('u1', 'sess', s).map(m => m.content), ['real'], 'kept the real cache')
})

t('content and tail are bounded by what the replay can return', () => {
  const s = fakeStorage()
  const many: ChatMessage[] = []
  for (let i = 0; i < 200; i++) many.push(msg({ id: `m${i}`, content: `msg ${i}` }))
  many.push(msg({ id: 'big', content: 'x'.repeat(10000) }))
  cacheTranscript('u1', 'sess', many, s)
  const out = readCachedTranscript('u1', 'sess', s)
  ok(out.length <= 50, `bounded to <=50 (the /session-messages page), got ${out.length}`)
  ok(out[out.length - 1].content.length <= 1200, 'per-item content capped at the replay truncation')
  eq(out[out.length - 1].id, 'big', 'keeps the tail (most recent)')
})

t('evicts the longest-untouched sessions beyond the cap', () => {
  const s = fakeStorage()
  for (let i = 0; i < 12; i++) cacheTranscript('u1', `sess${i}`, [msg({ id: 'u', content: `c${i}` })], s)
  eq(readCachedTranscript('u1', 'sess11', s).map(m => m.content), ['c11'], 'newest retained')
  eq(readCachedTranscript('u1', 'sess0', s), [], 'oldest evicted')
  eq(readCachedTranscript('u1', 'sess3', s), [], 'oldest evicted (3)')
  eq(readCachedTranscript('u1', 'sess4', s).map(m => m.content), ['c4'], 'the last 8 are kept')
  ok(Array.from(s.map.keys()).every(k => k.startsWith(`${TRANSCRIPT_CACHE_PREFIX}:u:u1:`)), 'only this account\'s keys')
})

t('sign-out clears transcripts (incl. pre-namespacing residue) + live records', () => {
  const s = fakeStorage()
  cacheTranscript('user-a', 'sessA', [msg({ id: 'u', content: 'a' })], s)
  s.setItem('vn-chat-transcript:sessLegacy', '[{"id":"u","role":"user","content":"residue","ts":null}]')
  s.setItem('vn-chat-live-session:user-a', 'rec')
  s.setItem('osborn-agent-url', 'keep-me')
  clearSignOutLocalState(s)
  eq(readCachedTranscript('user-a', 'sessA', s), [], 'transcript gone')
  eq(Array.from(s.map.keys()), ['osborn-agent-url'], 'only unrelated app storage survives')
})

t('corrupt cache entry reads as empty, never throws', () => {
  const s = fakeStorage()
  s.setItem(`${TRANSCRIPT_CACHE_PREFIX}:u:u1:sess`, '{not json')
  eq(readCachedTranscript('u1', 'sess', s), [], 'graceful on garbage')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
