// Run: PGLITE=/tmp/pgl/node_modules/@electric-sql/pglite/dist/index.js node frontend/tests/content-migration-007.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const { PGlite } = await import(pathToFileURL(process.env.PGLITE || '/tmp/pgl/node_modules/@electric-sql/pglite/dist/index.js').href)
const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '../supabase/migrations')
const m001 = fs.readFileSync(path.join(dir, '001_initial_schema.sql'), 'utf8')
const m007 = fs.readFileSync(path.join(dir, '007_content_library.sql'), 'utf8')
const legacy = fs.readFileSync(path.join(here, 'fixtures/legacy-profiles.sql'), 'utf8')
const db = new PGlite()
const results = []
async function t(name, fn) { try { await fn(); results.push([name, true]) } catch (e) { results.push([name, false, String(e.message).slice(0, 200)]) } }
const ok = (c, m) => { if (!c) throw new Error(m || 'assert') }
async function rejects(sql, params, re) {
  try { await db.query(sql, params) } catch (e) { if (re && !re.test(e.message)) throw new Error('wrong error: ' + e.message); return }
  throw new Error('expected failure: ' + sql)
}
const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222'
const E1 = 'alice@example.com', E2 = 'bob@example.com'
const TOK1 = 'a'.repeat(40), TOK2 = 'b'.repeat(40)
await db.exec(`
 create role anon nologin; create role authenticated nologin;
 create schema auth; create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true),'')::uuid $$;
 grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
 grant usage on schema public to anon, authenticated;
 alter default privileges in schema public grant all on tables to anon, authenticated;
`)
await db.exec(m001)
await db.exec(legacy) // prod-like legacy profiles: email usernames, triggers, open select policy
await db.exec(`grant all on all tables in schema public to anon, authenticated;`)
await db.query(`insert into auth.users(id,email) values ($1,$2),($3,$4)`, [U1, E1, U2, E2]) // fires on_auth_user_created
await db.exec(`insert into public.instances (user_id, server_url) values ('${U1}','http://a'),('${U2}','http://b')`)
const instColsBefore = (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name='instances' order by column_name`)).rows.map(r => r.column_name)
await t('0 precondition: legacy profiles seeded with email usernames', async () => {
  const r = (await db.query(`select id, username from profiles order by id`)).rows
  ok(r.length === 2 && r[0].username === E1 && r[1].username === E2, JSON.stringify(r)) })
await db.exec(m007)
await t('idempotent: second run of 007', async () => { await db.exec(m007) })
await db.exec(`grant all on all tables in schema public to anon, authenticated;`)
await t('0 legacy usernames unchanged after 007 (still emails)', async () => {
  const r = (await db.query(`select username from profiles order by id`)).rows.map(x => x.username)
  ok(JSON.stringify(r) === JSON.stringify([E1, E2]), JSON.stringify(r)) })
await t('1 sync_token column exists', async () => {
  const r = await db.query(`select 1 from information_schema.columns where table_name='instances' and column_name='sync_token'`); ok(r.rows.length === 1) })
await db.exec(`update instances set sync_token='${TOK1}' where user_id='${U1}'; update instances set sync_token='${TOK2}' where user_id='${U2}'`)
await t('1 unique sync_token enforced', async () => { await rejects(`update instances set sync_token=$1 where user_id=$2`, [TOK1, U2], /unique|duplicate/i) })
await t('1 multiple NULL tokens allowed (partial index)', async () => {
  await db.exec(`update instances set sync_token=null`); await db.exec(`update instances set sync_token='${TOK1}' where user_id='${U1}'; update instances set sync_token='${TOK2}' where user_id='${U2}'`)
  const r = await db.query(`select indexdef from pg_indexes where tablename='instances' and indexdef ilike '%sync_token%'`)
  ok(r.rows.some(x => /unique/i.test(x.indexdef) && /where/i.test(x.indexdef) && /not null/i.test(x.indexdef) && /<>\s*''/.test(x.indexdef)), JSON.stringify(r.rows)) })
await t('1 multiple empty-string tokens allowed (excluded by index predicate)', async () => {
  await db.exec(`update instances set sync_token=''`)
  await db.exec(`update instances set sync_token='${TOK1}' where user_id='${U1}'; update instances set sync_token='${TOK2}' where user_id='${U2}'`) })
await t('2 no creator_profiles / public_profiles / ensure_*profile objects exist', async () => {
  const r = (await db.query(`select to_regclass('public.creator_profiles') a, to_regclass('public.public_creator_profiles') b, to_regclass('public.public_profiles') c,
    (select count(*)::int from pg_proc where proname in ('ensure_profile','ensure_creator_profile')) f`)).rows[0]
  ok(!r.a && !r.b && !r.c && r.f === 0, JSON.stringify(r)) })
await t('2 007 source has no creator_profiles and never writes/alters public.profiles', async () => {
  ok(!/creator_profiles|ensure_(creator_)?profile|public_profiles/i.test(m007), 'stale reference')
  const sql = m007.replace(/--[^\n]*/g, '')
  ok(!/(alter|drop|truncate)\s+table\s+(if\s+exists\s+)?public\.profiles\b/i.test(sql), 'alters profiles')
  ok(!/(insert\s+into|update|delete\s+from)\s+public\.profiles\b/i.test(sql), 'writes profiles')
  ok(!/\bon\s+public\.profiles\b/i.test(sql), 'policy/trigger on profiles')
  ok(!/(set_username_default|handle_new_user|on_auth_user_created)/i.test(sql), 'touches legacy triggers') })
await t('3 content_items columns: no visibility/indexable; status default draft', async () => {
  const c = await db.query(`select column_name,column_default from information_schema.columns where table_name='content_items'`)
  const names = c.rows.map(r => r.column_name)
  ok(!names.includes('visibility') && !names.includes('indexable'), names.join())
  ok(names.includes('status') && names.includes('content_hash') && names.includes('slug') && names.includes('published_at') && names.includes('owner_user_id') && names.includes('type'), names.join())
  ok(/draft/.test(c.rows.find(r => r.column_name === 'status').column_default)) })
const ins = (o) => db.query(`insert into content_items(owner_user_id,type,content_hash,status,slug,published_at) values ($1,$2,$3,$4,$5,$6)`, [U1, o.type || 'text_post', o.hash || 'h' + Math.random(), o.status ?? 'draft', o.slug ?? null, o.pub ?? null])
await t('3 type check accepts all five', async () => { for (const ty of ['short', 'compilation', 'text_post', 'transcript', 'audio_video']) await ins({ type: ty }) })
await t('3 type check rejects other', async () => { await rejects(`insert into content_items(owner_user_id,type,content_hash) values ($1,'video','x1')`, [U1], /check|violates/i) })
await t('3 status rejects other', async () => { await rejects(`insert into content_items(owner_user_id,type,content_hash,status) values ($1,'short','x2','archived')`, [U1], /check|violates/i) })
await t('3 published requires published_at and slug', async () => {
  await rejects(`insert into content_items(owner_user_id,type,content_hash,status,slug) values ($1,'short','p1','published','s1')`, [U1], /check|violates/i)
  await rejects(`insert into content_items(owner_user_id,type,content_hash,status,published_at) values ($1,'short','p2','published',now())`, [U1], /check|violates/i)
  await ins({ status: 'published', slug: 'pub-ok', pub: new Date().toISOString(), hash: 'p3' }) })
await t('3 unique (owner,slug)', async () => { await rejects(`insert into content_items(owner_user_id,type,content_hash,slug) values ($1,'short','q1','pub-ok')`, [U1], /unique|duplicate/i) })
await t('3 unique (owner,content_hash)', async () => { await rejects(`insert into content_items(owner_user_id,type,content_hash) values ($1,'short','p3')`, [U1], /unique|duplicate/i) })
await t('3 same slug/hash different owner allowed', async () => { await db.query(`insert into content_items(owner_user_id,type,content_hash,slug) values ($1,'short','p3','pub-ok')`, [U2]) })
// RLS
await t('4 RLS enabled', async () => { const r = await db.query(`select relrowsecurity from pg_class where relname='content_items'`); ok(r.rows[0].relrowsecurity) })
await t('4 owner select only own', async () => {
  await db.exec(`set role authenticated; set test.uid='${U2}'`)
  try { const r = await db.query(`select owner_user_id from content_items where status='draft'`); ok(r.rows.length >= 1 && r.rows.every(x => x.owner_user_id === U2), 'rows ' + r.rows.length) } finally { await db.exec(`reset role`) } })
await t('4 no client INSERT (authenticated, own row)', async () => {
  await db.exec(`set role authenticated; set test.uid='${U1}'`)
  try { await rejects(`insert into content_items(owner_user_id,type,content_hash) values ($1,'short','cli1')`, [U1], /row-level|policy|permission/i) } finally { await db.exec(`reset role`) } })
await t('4 no client INSERT (anon), not even a draft', async () => {
  await db.exec(`set role anon; set test.uid=''`)
  try { await rejects(`insert into content_items(owner_user_id,type,content_hash) values ($1,'short','cli2')`, [U1], /row-level|policy|permission/i) } finally { await db.exec(`reset role`) } })
await t('4 client cannot publish (update)', async () => {
  const id = (await db.query(`select id from content_items where owner_user_id=$1 and status='draft' limit 1`, [U1])).rows[0].id
  await db.exec(`set role authenticated; set test.uid='${U1}'`)
  try {
    let published = false
    try { const r = await db.query(`update content_items set status='published', published_at=now(), slug='hax' where id=$1 returning status`, [id]); published = r.rows.length > 0 } catch { published = false }
    ok(!published, 'client published a row') } finally { await db.exec(`reset role`) }
  ok((await db.query(`select status from content_items where id=$1`, [id])).rows[0].status === 'draft') })
await t('4 owner delete own, not others', async () => {
  await db.exec(`set role authenticated; set test.uid='${U1}'`)
  try {
    const o = await db.query(`delete from content_items where owner_user_id=$1 and content_hash='p3' returning id`, [U2]); ok(o.rows.length === 0)
    const mine = await db.query(`delete from content_items where owner_user_id=$1 and content_hash='p3' returning id`, [U1]); ok(mine.rows.length === 1) } finally { await db.exec(`reset role`) } })
await t('4 anon selects only published (via public_content)', async () => {
  await ins({ status: 'published', slug: 'anon-vis', pub: new Date().toISOString(), hash: 'anonpub' })
  const pub = (await db.query(`select id from content_items where status='published'`)).rows.map(x => x.id).sort()
  await db.exec(`set role anon; set test.uid=''`)
  try { const r = await db.query(`select id from public_content`); ok(r.rows.length >= 1 && JSON.stringify(r.rows.map(x => x.id).sort()) === JSON.stringify(pub), JSON.stringify(r.rows)) } finally { await db.exec(`reset role`) } })
await t('4 public_content exposes exactly the safe columns + handle (= legacy username/email)', async () => {
  const r = await db.query(`select column_name from information_schema.columns where table_name='public_content' order by column_name`)
  const want = ['body', 'handle', 'hook', 'id', 'poster_path', 'published_at', 'slug', 'title', 'transcript', 'transcript_segments', 'type']
  ok(JSON.stringify(r.rows.map(x => x.column_name)) === JSON.stringify(want), r.rows.map(x => x.column_name).join())
  await db.exec(`set role anon; set test.uid=''`)
  try { const v = await db.query(`select handle from public_content where slug='anon-vis'`); ok(v.rows.length === 1 && v.rows[0].handle === E1, JSON.stringify(v.rows)) } finally { await db.exec(`reset role`) } })
await t('4 anon cannot read source_session_id from content_items', async () => {
  await db.query(`update content_items set source_session_id='sess-secret-1' where content_hash='anonpub'`)
  await db.exec(`set role anon; set test.uid=''`)
  try {
    let rows = []
    try { rows = (await db.query(`select source_session_id from content_items`)).rows } catch (e) { if (!/permission|denied/i.test(e.message)) throw e }
    ok(rows.length === 0, 'anon read ' + JSON.stringify(rows))
    await rejects(`select source_session_id from public_content`, [], /column|does not exist/i) } finally { await db.exec(`reset role`) } })
await t('4 authenticated non-owner gets no published rows from the table', async () => {
  await db.exec(`set role authenticated; set test.uid='${U2}'`)
  try { const r = await db.query(`select id from content_items where status='published' and owner_user_id=$1`, [U1]); ok(r.rows.length === 0, 'saw U1 published: ' + JSON.stringify(r.rows)) } finally { await db.exec(`reset role`) } })
await t('4 no public select policy on content_items', async () => {
  const r = await db.query(`select policyname from pg_policies where tablename='content_items'`)
  ok(!r.rows.some(x => x.policyname === 'content_items_public_select_published'), JSON.stringify(r.rows)) })
await t('4 public_content: SELECT only for anon+authenticated', async () => {
  await db.exec(m007) // re-apply revoke/grant (the harness re-grants ALL on tables above)
  for (const role of ['anon', 'authenticated']) {
    const r = (await db.query(`select has_table_privilege($1,'public.public_content','select') s, has_table_privilege($1,'public.public_content','insert') i, has_table_privilege($1,'public.public_content','update') u, has_table_privilege($1,'public.public_content','delete') d`, [role])).rows[0]
    ok(r.s && !r.i && !r.u && !r.d, role + ' ' + JSON.stringify(r)) } })
// ingest
const call = (tok, p, role = 'anon') => db.exec(`set role ${role}`).then(() => db.query(`select content_ingest($1, $2::jsonb) as r`, [tok, JSON.stringify(p)])).finally(() => db.exec(`reset role`))
const base = { type: 'text_post', content_hash: 'ing-1', title: 't', body: 'hello' }
await t('5 null token rejected', async () => { await db.exec(`set role anon`); try { await rejects(`select content_ingest(null, '{}'::jsonb)`, [], /invalid token/) } finally { await db.exec(`reset role`) } })
await t('5 short token (31) rejected', async () => { let f = false; try { await call('a'.repeat(31), base) } catch (e) { f = /invalid token/.test(e.message) } ok(f) })
await t('5 unknown 32+ token rejected, nothing written', async () => {
  const n0 = (await db.query(`select count(*)::int c from content_items`)).rows[0].c
  let f = false; try { await call('z'.repeat(40), { ...base, content_hash: 'badtok' }) } catch (e) { f = /invalid token/.test(e.message) } ok(f)
  ok((await db.query(`select count(*)::int c from content_items`)).rows[0].c === n0) })
await t('5 valid token inserts as draft for token owner', async () => {
  await call(TOK1, base)
  const r = await db.query(`select owner_user_id,status,published_at from content_items where content_hash='ing-1'`)
  ok(r.rows.length === 1 && r.rows[0].owner_user_id === U1 && r.rows[0].status === 'draft' && !r.rows[0].published_at, JSON.stringify(r.rows)) })
await t('5 ignores owner/user_id/status/published_at in payload', async () => {
  await call(TOK1, { ...base, content_hash: 'ing-2', owner_user_id: U2, user_id: U2, status: 'published', published_at: new Date().toISOString(), slug: 'evil' })
  const r = await db.query(`select owner_user_id,status,published_at,slug from content_items where content_hash='ing-2'`)
  ok(r.rows.length === 1 && r.rows[0].owner_user_id === U1 && r.rows[0].status === 'draft' && !r.rows[0].published_at && !r.rows[0].slug, JSON.stringify(r.rows)) })
await t('5 duplicate hash upserts (one row, latest title)', async () => {
  await call(TOK1, { ...base, title: 'new title' }); await call(TOK1, { ...base, title: 'newer' })
  const r = (await db.query(`select count(*)::int c, max(title) t from content_items where owner_user_id=$1 and content_hash='ing-1'`, [U1])).rows[0]; ok(r.c === 1 && r.t === 'newer', JSON.stringify(r)) })
await t('5 upsert never overwrites or demotes a published item', async () => {
  await db.query(`update content_items set status='published', slug='ing-1-pub', published_at=now(), title='final' where owner_user_id=$1 and content_hash='ing-1'`, [U1])
  await call(TOK1, { ...base, title: 'machine retry' })
  const r = (await db.query(`select status, title from content_items where owner_user_id=$1 and content_hash='ing-1'`, [U1])).rows[0]
  ok(r.status === 'published' && r.title === 'final', JSON.stringify(r)) })
await t('5 same hash for another user is a separate row', async () => {
  await call(TOK2, base); const r = await db.query(`select count(*)::int c from content_items where content_hash='ing-1'`); ok(r.rows[0].c === 2) })
await t('5 requires content_hash', async () => { const { content_hash, ...p } = base; let f = false; try { await call(TOK1, p) } catch { f = true } ok(f) })
await t('5 payload cap 256KB (300KB rejected, 100KB accepted)', async () => {
  let f = false; try { await call(TOK1, { ...base, content_hash: 'big', body: 'x'.repeat(300 * 1024) }) } catch (e) { f = /too large/.test(e.message) } ok(f, 'oversize accepted')
  ok((await db.query(`select count(*)::int c from content_items where content_hash='big'`)).rows[0].c === 0)
  await call(TOK1, { ...base, content_hash: 'mid', body: 'x'.repeat(100 * 1024) }) })
await t('5 security definer + fixed search_path', async () => {
  const r = await db.query(`select prosecdef, proconfig from pg_proc where proname='content_ingest'`)
  ok(r.rows.length === 1 && r.rows[0].prosecdef && (r.rows[0].proconfig || []).some(c => /^search_path=public, pg_temp$/.test(c)), JSON.stringify(r.rows)) })
await t('5 execute: anon+authenticated yes, public no', async () => {
  const r = await db.query(`select has_function_privilege('anon','content_ingest(text,jsonb)','execute') a, has_function_privilege('authenticated','content_ingest(text,jsonb)','execute') b, (select proacl::text from pg_proc where proname='content_ingest') acl`)
  ok(r.rows[0].a && r.rows[0].b, 'grants'); ok(!/(^\{|,)=X/.test(r.rows[0].acl), 'PUBLIC still has execute: ' + r.rows[0].acl) })
await t('6 instances only gains sync_token', async () => {
  const after = (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name='instances' order by column_name`)).rows.map(r => r.column_name)
  const want = [...new Set([...instColsBefore, 'sync_token'])].sort()
  ok(JSON.stringify(after) === JSON.stringify(want), after.join()) })
await t('6 no destructive statements in 007', async () => { ok(!/\bdrop\s+(table|column)\b|\btruncate\b|delete\s+from\s+public\.(instances|agent_sessions|profiles)/i.test(m007), 'destructive') })
let fail = 0
for (const [n, p, e] of results) { console.log((p ? 'PASS ' : 'FAIL ') + n + (e ? '\n     ' + e : '')); if (!p) fail++ }
console.log(`${results.length - fail} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
