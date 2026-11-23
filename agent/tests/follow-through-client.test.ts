// Follow-through (#378) client: the sync-token POST to the frontend, read strictly.
// Run: npx tsx agent/tests/follow-through-client.test.ts
import assert from 'node:assert/strict'

const { outboundText, postFollowThrough, readFollowThroughReply } = await import('../src/follow-through-client.js')
const { loopKey } = await import('../src/loops-ledger.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) }
  catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}
const item = { key: 'abcdef012345', kind: 'ask', text: 'x', source: 'explicit' as const, origin: 'user_mic' as const }
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

await t('no sync token returns error without a request', async () => {
  let called = false
  const r = await postFollowThrough('https://f', undefined, 'o/r', [item], (async () => { called = true; return new Response('{}') }) as any)
  assert.equal(r, 'error')
  assert.equal(called, false)
})

await t('non-200 or malformed reply leaves items open', async () => {
  assert.equal(await postFollowThrough('https://f', 'tok-0123456789abcdef', 'o/r', [item], reply(503, { results: [] })), 'error')
  assert.equal(await postFollowThrough('https://f', 'tok-0123456789abcdef', 'o/r', [item], reply(200, { nope: 1 })), 'error')
  assert.equal(readFollowThroughReply(200, { results: [{ key: 'abcdef012345', action: 'created' }] }), 'error', 'created needs a github url')
  assert.equal(readFollowThroughReply(200, { results: [{ key: 'bad', action: 'held' }] }), 'error')
  assert.deepEqual(readFollowThroughReply(200, { results: [{ key: 'abcdef012345', action: 'held' }] }), [{ key: 'abcdef012345', action: 'held' }])
})

await t('bearer header carries the sync token', async () => {
  let seen: any
  const f = (async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ results: [] }), { status: 200 }) }) as any
  const r = await postFollowThrough('https://front.example', 'tok-0123456789abcdef', 'o/r', [item], f)
  assert.deepEqual(r, [])
  assert.equal(seen.url, 'https://front.example/api/follow-through')
  assert.equal(seen.init.headers.Authorization, 'Bearer tok-0123456789abcdef')
  assert.deepEqual(JSON.parse(seen.init.body), { repo: 'o/r', items: [item] })
})

await t('timeout is bounded', async () => {
  const hang = ((_: string, init: any) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))) as any
  const keepAlive = setInterval(() => {}, 1000) // AbortSignal.timeout's timer is unref'd
  const t0 = Date.now()
  try {
    assert.equal(await postFollowThrough('https://f', 'tok-0123456789abcdef', 'o/r', [item], hang, 100), 'error')
    assert.ok(Date.now() - t0 < 2000)
  } finally { clearInterval(keepAlive) }
})

await t('loopKey is stable under case and punctuation', () => {
  assert.equal(loopKey('todo', 'Fix the LOGIN bug!'), loopKey('todo', 'fix the login bug'))
})

await t('outboundText redacts secrets and caps the text', () => {
  const out = outboundText('use key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA please')
  assert.ok(!out.includes('AAAAAAAAAAAA'), out)
  assert.ok(outboundText('x'.repeat(500)).length <= 200)
})

await t('postFollowThrough redacts every item itself (no caller can bypass it)', async () => {
  let sent: any = null
  const fetchFn = (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ results: [] }), { status: 200 }) }) as any
  await postFollowThrough('https://f', 'tok-0123456789abcdef', 'o/r', [{ ...item, text: 'key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ' + 'y'.repeat(400) }], fetchFn)
  assert.ok(sent, 'request was sent')
  assert.ok(!JSON.stringify(sent).includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), JSON.stringify(sent))
  assert.ok(sent.items[0].text.length <= 200)
})

console.log(`\n${pass} passed`)
