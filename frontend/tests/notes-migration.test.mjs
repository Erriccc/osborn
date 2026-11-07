// Run: node frontend/tests/notes-migration.test.mjs
// Static check of 013_notes.sql (lane L20, UI item 26 gap 1). The `notes`
// table already exists in production; this migration is a MIRROR so a fresh
// environment matches prod. It must be safe to re-run on prod as a no-op, so
// every CREATE is guarded (IF NOT EXISTS, or a pg_policies / pg_indexes check)
// and nothing drops, truncates, or rewrites existing objects.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '../supabase/migrations/013_notes.sql')
const raw = fs.readFileSync(file, 'utf8')
// Strip -- comments so the header's example SQL does not count as statements.
const sql = raw.split('\n').map(l => l.replace(/--.*$/, '')).join('\n').toLowerCase().replace(/\s+/g, ' ')

const results = []
function t(name, fn) { try { fn(); results.push([name, true]) } catch (e) { results.push([name, false, String(e.message).slice(0, 300)]) } }
const ok = (c, m) => { if (!c) throw new Error(m || 'assert') }

// Body of each `if not exists (...) then ... end if;` guard, for policy checks.
function guardedBlocks(s) {
  const out = []
  const re = /if not exists \(/g
  let m
  while ((m = re.exec(s))) {
    const end = s.indexOf('end if', m.index)
    out.push(s.slice(m.index, end < 0 ? s.length : end))
  }
  return out
}

t('file is numbered 013 (reserved for L20 in the build plan)', () => ok(fs.existsSync(file), 'missing 013_notes.sql'))

t('header tells the user to compare against prod with a read-only information_schema SELECT', () => {
  ok(/information_schema\.columns/i.test(raw), 'no information_schema.columns query in header')
  ok(/pg_policies/i.test(raw), 'no pg_policies query in header')
  ok(/no-op/i.test(raw), 'header does not state the migration must be a no-op on prod')
  ok(/read-only/i.test(raw), 'header does not say the check is read-only')
})

t('create table uses IF NOT EXISTS', () => {
  const creates = sql.match(/create table [^(]*/g) || []
  ok(creates.length === 1, `expected 1 create table, got ${creates.length}`)
  ok(creates.every(c => /create table if not exists public\.notes/.test(c)), creates.join(' | '))
})

t('every create index uses IF NOT EXISTS', () => {
  const idx = sql.match(/create (unique )?index [^ ]+ [^ ]+ [^ ]+/g) || []
  ok(idx.length >= 1, 'no index created')
  ok(idx.every(c => /create (unique )?index if not exists/.test(c)), idx.join(' | '))
})

t('every add column uses IF NOT EXISTS', () => {
  const adds = sql.match(/add column [^ ]+ [^ ]+ [^ ]+/g) || []
  ok(adds.every(c => /add column if not exists/.test(c)), adds.join(' | '))
})

t('every create policy is inside an IF NOT EXISTS (pg_policies) guard', () => {
  const policies = sql.match(/create policy/g) || []
  ok(policies.length >= 3, `expected >= 3 policies, got ${policies.length}`)
  const blocks = guardedBlocks(sql).filter(b => /pg_policies/.test(b))
  const guarded = blocks.reduce((n, b) => n + (b.match(/create policy/g) || []).length, 0)
  ok(guarded === policies.length, `${policies.length} create policy, only ${guarded} guarded by pg_policies`)
})

t('no destructive or rewriting statements', () => {
  for (const bad of [/drop table/, /drop policy/, /drop index/, /truncate/, /delete from/, /drop column/, /alter column/, /alter policy/, /create or replace/]) {
    ok(!bad.test(sql), `found ${bad}`)
  }
})

t('columns: id uuid pk, user_id -> auth.users on delete cascade, text, attachments jsonb default [], created_at timestamptz default now()', () => {
  ok(/id uuid primary key default gen_random_uuid\(\)/.test(sql), 'id')
  ok(/user_id uuid not null references auth\.users ?\(id\) on delete cascade/.test(sql), 'user_id')
  ok(/ text text not null/.test(sql), 'text')
  ok(/attachments jsonb not null default '\[\]'::jsonb,/.test(sql), 'attachments (create table) must be jsonb not null default [] to match prod')
  ok(/created_at timestamptz not null default now\(\)/.test(sql), 'created_at')
})

t('attachments is jsonb everywhere (prod is jsonb, not text[])', () => {
  ok(!/text\[\]/.test(sql), 'text[] still declared')
  ok(/add column if not exists attachments jsonb not null default '\[\]'::jsonb;/.test(sql), 'add column path must be jsonb not null default []')
})

t('RLS enabled', () => ok(/alter table public\.notes enable row level security/.test(sql), 'rls'))

t('owner-only select/insert/delete policies keyed on auth.uid() = user_id', () => {
  for (const cmd of ['select', 'insert', 'delete']) {
    const re = new RegExp(`create policy "[^"]+" on public\\.notes for ${cmd} to authenticated (using|with check) \\(\\s*auth\\.uid\\(\\) = user_id\\s*\\)`)
    ok(re.test(sql), `missing owner ${cmd} policy`)
  }
  ok(!/using \(\s*true\s*\)/.test(sql) && !/with check \(\s*true\s*\)/.test(sql), 'open policy found')
})

t('policy guards check by table + command, so differently-named prod policies are not duplicated', () => {
  const blocks = guardedBlocks(sql).filter(b => /pg_policies/.test(b))
  for (const cmd of ['select', 'insert', 'delete']) {
    ok(blocks.some(b => /tablename = 'notes'/.test(b) && new RegExp(`cmd\\)? in \\('${cmd}', ?'all'\\)`).test(b) && new RegExp(`for ${cmd}`).test(b)),
      `no pg_policies guard on cmd ${cmd}`)
  }
})

let fail = 0
for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? '\n      ' + m : ''}`); if (!p) fail++ }
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
