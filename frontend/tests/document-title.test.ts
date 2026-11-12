// Run: cd frontend && npx --yes tsx tests/document-title.test.ts
// Spec (bug ab31e017): every page gets its own tab title in the form
// '<Page> · Voice Native'. The root layout's metadata template provides the
// suffix for server pages; client pages use useDocumentTitle, which formats
// with formatDocumentTitle. A child title that already carries the brand must
// opt out of the template ({ absolute }) so the suffix is never doubled.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { formatDocumentTitle, SITE_NAME } from '../src/lib/document-title'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 600)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const APP = join(__dirname, '..', 'src', 'app')
const read = (p: string) => readFileSync(join(APP, p), 'utf8')
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) { if (n !== 'api') walk(p, out) }
    else if (n === 'page.tsx' || n === 'layout.tsx') out.push(relative(APP, p))
  }
  return out
}

t('formatDocumentTitle appends the site suffix', () => {
  eq(formatDocumentTitle('Dashboard'), 'Dashboard · Voice Native', 'basic')
  eq(formatDocumentTitle('  Settings \n'), 'Settings · Voice Native', 'trimmed')
  eq(formatDocumentTitle('My   long  title'), 'My long title · Voice Native', 'collapsed whitespace')
})

t('formatDocumentTitle falls back / does not double', () => {
  eq(formatDocumentTitle(''), SITE_NAME, 'empty')
  eq(formatDocumentTitle(null), SITE_NAME, 'null')
  eq(formatDocumentTitle(undefined), SITE_NAME, 'undefined')
  eq(formatDocumentTitle('   '), SITE_NAME, 'whitespace')
  eq(formatDocumentTitle('Voice Native'), SITE_NAME, 'bare brand')
  eq(formatDocumentTitle('Library · Voice Native'), 'Library · Voice Native', 'already suffixed')
})

t("root layout template is '%s · Voice Native'", () => {
  ok(/template:\s*'%s · Voice Native'/.test(read('layout.tsx')), 'template missing or different')
})

t('client pages set their own title', () => {
  const want: Record<string, string> = {
    'dashboard/page.tsx': 'Dashboard',
    'settings/page.tsx': 'Settings',
    // /library's page.tsx is a thin server wrapper since the shareable
    // /library/[id] split; the hook lives in the client view both routes render.
    'library/library-view.tsx': 'Library',
    'login/page.tsx': 'Sign in',
    'admin/page.tsx': 'Admin',
    'browser-screen-recorder/page.tsx': 'Browser Screen Recorder',
  }
  for (const [p, title] of Object.entries(want)) {
    ok(read(p).includes(`useDocumentTitle('${title}')`), `${p} should call useDocumentTitle('${title}')`)
  }
})

t('no child metadata title carries the brand unless it is absolute (no doubled suffix)', () => {
  const bad: string[] = []
  for (const p of walk(APP)) {
    if (p === 'layout.tsx' || p === 'page.tsx') continue // root segment: template does not apply
    const src = read(p)
    // Top-level metadata `title:` only (openGraph/twitter titles are not
    // templated): `export const metadata = {` keys sit at 2 spaces;
    // generateMetadata's `return { title: … }` is matched directly.
    const meta = src.match(/export const metadata[^=]*=\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const found = [
      ...Array.from(meta.matchAll(/^ {2}title:\s*([^\n]+)$/gm), m => m[1]),
      ...Array.from(src.matchAll(/return \{\s*title:\s*([^\n,]+)/g), m => m[1]),
    ]
    for (const v of found) {
      if (/Voice Native/.test(v) && !/absolute/.test(v)) bad.push(`${p}: ${v.trim()}`)
    }
  }
  ok(bad.length === 0, `brand in templated title:\n  ${bad.join('\n  ')}`)
})

let fail = 0
for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? `\n      ${m}` : ''}`); if (!p) fail++ }
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
