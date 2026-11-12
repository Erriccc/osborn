// Run: cd frontend && npx --yes tsx tests/transcript-cache.test.ts
// Spec (#136/#71): the optimistic transcript cache paints the resumed session's
// last-known history instantly on reload, then the authoritative replay drops
// and replaces it. These tests pin the pure behaviour: what gets serialized,
// round-trips, is bounded/evicted, and is cleared on sign-out.
import {
  TRANSCRIPT_CACHE_PREFIX,
  cacheTranscript,
  readCachedTranscript,
  clearCachedTranscripts,
  serializeTranscript,
  type CacheStorage,
  type TranscriptInput,
} from '../src/lib/transcript-cache'

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

const msg = (over: Partial<TranscriptInput>): TranscriptInput => ({
  id: 'm1', role: 'user', content: 'hello', timestamp: new Date('2026-11-11T19:00:00Z'), ...over,
})

t('serialize drops streaming + empty, keeps compaction markers', () => {
  const items = serializeTranscript([
    msg({ id: 'u1', role: 'user', content: 'first question' }),
    msg({ id: 'a1', role: 'assistant', content: 'an answer' }),
    msg({ id: 's1', role: 'assistant', content: 'still typing', isStreaming: true }),
    msg({ id: 'e1', role: 'assistant', content: '' }),
    msg({ id: 'c1', role: 'system', content: '', compaction: { trigger: 'auto' } }),
  ])
  eq(items.map(i => i.id), ['u1', 'a1', 'c1'], 'kept ids')
  eq((items[2] as any).compaction, { trigger: 'auto' }, 'compaction passed through')
})

t('serialize drops synthetic day/Today dividers, keeps real messages', () => {
  const items = serializeTranscript([
    msg({ id: 'prior-day-Nov 11-sess', role: 'system', content: '── Nov 11 ──' }),
    msg({ id: 'prior-0-sess', role: 'user', content: 'real question' }),
    msg({ id: 'prior-sep-sess', role: 'system', content: '── Today ──' }),
    msg({ id: 'live-1', role: 'assistant', content: 'live answer' }),
  ])
  eq(items.map(i => i.id), ['prior-0-sess', 'live-1'], 'dividers dropped, messages kept')
})

t('round-trips through storage keyed by session id', () => {
  const s = fakeStorage()
  cacheTranscript('sessA', [msg({ id: 'u1', content: 'hi A' })], s)
  cacheTranscript('sessB', [msg({ id: 'u1', content: 'hi B' })], s)
  eq(readCachedTranscript('sessA', s).map(m => m.content), ['hi A'], 'A isolated')
  eq(readCachedTranscript('sessB', s).map(m => m.content), ['hi B'], 'B isolated')
  eq(readCachedTranscript('missing', s), [], 'unknown session → empty')
})

t('never clobbers a good cache with an empty transcript', () => {
  const s = fakeStorage()
  cacheTranscript('sess', [msg({ id: 'u1', content: 'real' })], s)
  cacheTranscript('sess', [], s) // e.g. the setMessages([]) during a switch
  cacheTranscript('sess', [msg({ id: 's1', isStreaming: true })], s) // only streaming
  eq(readCachedTranscript('sess', s).map(m => m.content), ['real'], 'kept the real cache')
})

t('content is capped and tail is bounded', () => {
  const s = fakeStorage()
  const many: TranscriptInput[] = []
  for (let i = 0; i < 200; i++) many.push(msg({ id: `m${i}`, content: `msg ${i}` }))
  many.push(msg({ id: 'big', content: 'x'.repeat(10000) }))
  cacheTranscript('sess', many, s)
  const out = readCachedTranscript('sess', s)
  ok(out.length <= 60, `bounded to <=60, got ${out.length}`)
  ok(out[out.length - 1].content.length <= 4000, 'per-item content capped')
  eq(out[out.length - 1].id, 'big', 'keeps the tail (most recent)')
})

t('evicts oldest sessions beyond the cap', () => {
  const s = fakeStorage()
  for (let i = 0; i < 12; i++) cacheTranscript(`sess${i}`, [msg({ id: 'u', content: `c${i}` })], s)
  const keys = Array.from(s.map.keys()).filter(k => k.startsWith(`${TRANSCRIPT_CACHE_PREFIX}:`))
  ok(keys.length <= 8, `kept <=8 sessions, got ${keys.length}`)
  eq(readCachedTranscript('sess11', s).map(m => m.content), ['c11'], 'newest retained')
  eq(readCachedTranscript('sess0', s), [], 'oldest evicted')
})

t('clear removes only transcript keys, not other app storage', () => {
  const s = fakeStorage()
  cacheTranscript('sessA', [msg({ id: 'u', content: 'a' })], s)
  s.setItem('vn-chat-live-session:user1', 'keep-me')
  clearCachedTranscripts(s)
  eq(readCachedTranscript('sessA', s), [], 'transcript gone')
  eq(s.getItem('vn-chat-live-session:user1'), 'keep-me', 'unrelated key untouched')
})

t('corrupt cache entry reads as empty, never throws', () => {
  const s = fakeStorage()
  s.setItem(`${TRANSCRIPT_CACHE_PREFIX}:sess`, '{not json')
  eq(readCachedTranscript('sess', s), [], 'graceful on garbage')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
