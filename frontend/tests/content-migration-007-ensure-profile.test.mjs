// Run: node frontend/tests/content-migration-007-ensure-profile.test.mjs
// Legacy-profiles invariants for 007. (Filename kept from the retired
// ensure_profile design so existing references still resolve.) Proves 007
// reuses the prod-like legacy public.profiles WITHOUT changing its rows,
// columns, indexes, constraints, policies, triggers, trigger functions or ACLs.
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
async function t(name, fn) { try { await fn(); results.push([name, true]) } catch (e) { results.push([name, false, String(e.message).slice(0, 300)]) } }
const ok = (c, m) => { if (!c) throw new Error(m || 'assert') }
const U = [1, 2, 3, 4].map(n => String(n).repeat(8) + '-' + String(n).repeat(4) + '-' + String(n).repeat(4) + '-' + String(n).repeat(4) + '-' + String(n).repeat(12))
const EMAILS = ['first.person@example.com', 'second@example.org', 'third@example.net', 'late.signup@example.com']
const TOK = ['a'.repeat(40), 'b'.repeat(40)]
await db.exec(`
 create role anon nologin; create role authenticated nologin;
 create schema auth; create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true),'')::uuid $$;
 grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
 grant usage on schema public to anon, authenticated;
 alter default privileges in schema public grant all on tables to anon, authenticated;
 alter default privileges in schema public grant execute on functions to anon, authenticated;
`)
await db.exec(m001)
await db.exec(legacy)
await db.exec(`grant all on all tables in schema public to anon, authenticated;`)
// Prod-like seed: users via auth (the trigger creates profiles with username = email).
for (let i = 0; i < 3; i++)
  await db.query(`insert into auth.users values ($1,$2,$3)`, [U[i], EMAILS[i], JSON.stringify({ full_name: 'Name ' + i, avatar_url: 'https://img/' + i })])
await db.query(`update profiles set website='https://site.example', updated_at='2026-01-02T03:04:05Z' where id=$1`, [U[0]])
// Prod already has instances.sync_token (text): one user without a token, one empty.
await db.exec(`alter table public.instances add column sync_token text`)
await db.query(`insert into instances (user_id, server_url, sync_token) values ($1,'http://x0',$2),($3,'http://x1',$4),($5,'http://x2',null)`, [U[0], TOK[0], U[1], TOK[1], U[2]])

const q = async (sql, p) => (await db.query(sql, p)).rows
const snap = async () => JSON.stringify({
  rows: await q(`select * from public.profiles order by id`),
  cols: await q(`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='profiles' order by ordinal_position`),
  idx: await q(`select indexname, indexdef from pg_indexes where schemaname='public' and tablename='profiles' order by indexname`),
  cons: await q(`select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid='public.profiles'::regclass order by conname`),
  pol: await q(`select policyname, cmd, roles::text roles, permissive, qual, with_check from pg_policies where schemaname='public' and tablename='profiles' order by policyname`),
  trg: await q(`select tgname, tgrelid::regclass::text rel, tgtype, tgenabled, tgfoid::regproc::text fn from pg_trigger where not tgisinternal and tgrelid in ('public.profiles'::regclass,'auth.users'::regclass) order by tgname`),
  fn: await q(`select proname, prosrc, prosecdef, proconfig, proacl::text acl from pg_proc where proname in ('set_username_default','handle_new_user') order by proname`),
  rel: await q(`select relrowsecurity, relforcerowsecurity, relacl::text acl from pg_class where oid='public.profiles'::regclass`),
})
const ingest = (tok, hash, extra = {}) => db.exec(`set role anon`).then(() => db.query(`select content_ingest($1,$2::jsonb) id`, [tok, JSON.stringify({ type: 'text_post', content_hash: hash, body: 'b', ...extra })])).finally(() => db.exec(`reset role`))

await t('0 precondition: prod-like legacy shape seeded', async () => {
  const r = await q(`select id, username, full_name from profiles order by id`)
  ok(r.length === 3 && r.every((x, i) => x.username === EMAILS[i] && x.full_name === 'Name ' + i), JSON.stringify(r))
  const s = JSON.parse(await snap())
  ok(s.pol.length === 3 && s.pol.some(p => p.cmd === 'SELECT' && p.qual === 'true'), 'policies ' + JSON.stringify(s.pol))
  ok(JSON.stringify(s.trg.map(x => x.tgname)) === '["on_auth_user_created","set_username_default_trigger"]', JSON.stringify(s.trg))
  ok(JSON.stringify(s.idx.map(x => x.indexname)) === '["profiles_pkey","profiles_username_key"]', JSON.stringify(s.idx)) })
const before = await snap()
await t('A legacy profiles fully unchanged after first 007 run', async () => { await db.exec(m007); ok(await snap() === before, 'legacy shape changed') })
await t('B 007 idempotent: second and third runs succeed, legacy still unchanged', async () => {
  await db.exec(m007); await db.exec(m007); ok(await snap() === before, 'legacy shape changed on rerun')
  const r = (await q(`select (select count(*)::int from pg_proc where proname='content_ingest') f, to_regclass('public.content_items') is not null t,
    to_regclass('public.public_content') is not null v, (select count(*)::int from pg_indexes where indexname='instances_sync_token_key') i`))[0]
  ok(r.f === 1 && r.t && r.v && r.i === 1, JSON.stringify(r)) })
await t('B no extra objects: no creator_profiles/public_profiles/ensure_* and no new profiles columns', async () => {
  const r = (await q(`select to_regclass('public.creator_profiles') a, to_regclass('public.public_profiles') b, (select count(*)::int from pg_proc where proname like 'ensure%profile') f`))[0]
  ok(!r.a && !r.b && r.f === 0, JSON.stringify(r))
  const cols = (await q(`select column_name from information_schema.columns where table_schema='public' and table_name='profiles' order by ordinal_position`)).map(x => x.column_name)
  ok(cols.join() === 'id,updated_at,username,full_name,avatar_url,website', cols.join()) })
await t('B existing sync_token values preserved; unique index created over prod-like data', async () => {
  const r = await q(`select user_id, sync_token from instances order by user_id`)
  ok(r[0].sync_token === TOK[0] && r[1].sync_token === TOK[1] && r[2].sync_token === null, 'tokens changed') })
await t('C ingest works for legacy users, forces draft, and never touches profiles', async () => {
  const id = (await ingest(TOK[0], 'c1', { status: 'published', owner_user_id: U[1] })).rows[0].id; ok(id, 'no id')
  await ingest(TOK[1], 'c2')
  const r = await q(`select owner_user_id, status from content_items order by content_hash`)
  ok(r.length === 2 && r[0].owner_user_id === U[0] && r.every(x => x.status === 'draft'), JSON.stringify(r))
  ok(await snap() === before, 'ingest changed legacy profiles') })
await t('C bad token rejected even after reruns', async () => {
  let f = false; try { await ingest('z'.repeat(40), 'c3') } catch (e) { f = /invalid token/.test(e.message) } ok(f, 'accepted bad token')
  f = false; try { await ingest('', 'c3') } catch (e) { f = /invalid token/.test(e.message) } ok(f, 'accepted empty token') })
await t('C public_content handle is the legacy username (email); drafts hidden', async () => {
  await db.exec(`set role anon; set test.uid=''`)
  try { ok((await q(`select * from public_content`)).length === 0, 'draft visible') } finally { await db.exec(`reset role`) }
  await db.query(`update content_items set status='published', slug='c1', published_at=now() where content_hash='c1'`)
  await db.exec(`set role anon; set test.uid=''`)
  try { const r = await q(`select slug, handle from public_content`); ok(r.length === 1 && r[0].handle === EMAILS[0], JSON.stringify(r)) } finally { await db.exec(`reset role`) } })
await t('C published item stays visible (null handle) if owner has no profile row', async () => {
  await db.exec(`begin`)
  try { await db.query(`delete from profiles where id=$1`, [U[0]]); const r = await q(`select handle from public_content where slug='c1'`); ok(r.length === 1 && r[0].handle === null, JSON.stringify(r)) }
  finally { await db.exec(`rollback`) } })
await t('D legacy open SELECT policy still lets anon read profiles', async () => {
  await db.exec(`set role anon; set test.uid=''`)
  try { ok((await q(`select username from profiles`)).length === 3) } finally { await db.exec(`reset role`) } })
await t('D legacy update policy: owner can update own row only', async () => {
  await db.exec(`begin`)
  try {
    await db.exec(`set role authenticated; set test.uid='${U[1]}'`)
    ok((await q(`update profiles set full_name='x' where id=$1 returning id`, [U[1]])).length === 1, 'own update blocked')
    ok((await q(`update profiles set full_name='x' where id=$1 returning id`, [U[0]])).length === 0, 'cross update allowed')
  } finally { await db.exec(`reset role`); await db.exec(`rollback`) } })
await t('E rerun 007 after data: content and legacy rows kept', async () => {
  const n = (await q(`select count(*)::int c from content_items`))[0].c
  await db.exec(m007)
  ok((await q(`select count(*)::int c from content_items`))[0].c === n, 'content rows changed')
  ok((await q(`select status from content_items where content_hash='c1'`))[0].status === 'published', 'publish state lost')
  ok(await snap() === before, 'legacy changed') })
await t('F new signup after 007: legacy triggers still create profile with username = email', async () => {
  await db.query(`insert into auth.users values ($1,$2,$3)`, [U[3], EMAILS[3], JSON.stringify({ full_name: 'Late' })])
  const r = await q(`select username, full_name from profiles where id=$1`, [U[3]])
  ok(r.length === 1 && r[0].username === EMAILS[3] && r[0].full_name === 'Late', JSON.stringify(r)) })
let fail = 0
for (const [n, p, e] of results) { console.log((p ? 'PASS ' : 'FAIL ') + n + (e ? '\n     ' + e : '')); if (!p) fail++ }
console.log(`${results.length - fail} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
