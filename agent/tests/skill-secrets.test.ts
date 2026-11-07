// Skill secret scanner. Fails if any shipped skill markdown carries a literal password or a
// candidate email literal, and checks the browser-apply helper's guards (fixed secret file, no env
// overrides, loopback CDP, confirmed host, field types). On failure it prints only file:line and a masked reason, never the matching text.
// Run from repo root: npx --yes tsx agent/tests/skill-secrets.test.ts  (no npm test script exists)
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const HELPER = join(ROOT, 'agent/.claude/skills/browser-apply/fill.mjs')

// ---- scanner -------------------------------------------------------------------------------
// Key (optionally quoted), then `:`, `=` or a table pipe, then an optionally quoted value of 6+ chars.
// Covers `password: x`, `"password": "x"`, `PASSWORD='x'`, `pwd = x`, `| Password | x |`.
const PASSWORD_RE = /(password|passwd|pwd)["'`]?\s*(?:[:=]|\|)\s*["'`]?([^\s"'`|]{6,})/i
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
// Anchored: the WHOLE value (trailing , ; stripped) must be a placeholder or an env reference.
const PLACEHOLDER_RE = /^(<[^<>]*>|\$[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\}|process\.env\.[A-Za-z_]\w*|YOUR_[A-Z0-9_]*|(example|placeholder|changeme)[\w.-]*)$/i
const isPlaceholder = (v: string): boolean => PLACEHOLDER_RE.test(v.replace(/[,;]+$/, ''))
const SCAN_EXT = /\.(md|env|mjs)$/i

export const lineHash = (line: string): string => createHash('sha256').update(line.trim()).digest('hex').slice(0, 16)

// Known false positives, keyed by file + hash of the trimmed line (never by value).
// agent/.claude/skills/shadcn/SKILL.md: zod schema `password: z.string().min(8, ...)` and the
// form `defaultValues: { email: "", password: "" }` example. Only the zod line currently trips the
// pattern (the empty-string default is too short to match); it is listed by hash.
// agent/.claude/skills/browser-apply/SKILL.md: the Workday selector-table row whose value cell is the
// CSS selector `input[type="password"]` (matches the pipe form; it is a selector, not a secret).
const ALLOWLIST: Record<string, Set<string>> = {
  'agent/.claude/skills/shadcn/SKILL.md': new Set<string>([
    '4912c70f1070647d', // password: z.string().min(8, "Password must be at least 8 characters"),
  ]),
  'agent/.claude/skills/browser-apply/SKILL.md': new Set<string>([
    '3506b78dee8bfa17', // | Password | `input[type="password"]` | `CANDIDATE_PASSWORD` (helper) |
  ]),
}

export interface Finding { file: string; line: number; reason: string; hash: string }

export function scanText(file: string, text: string, allow: Record<string, Set<string>> = ALLOWLIST): Finding[] {
  const out: Finding[] = []
  // .env files are treated as one Candidate Data block (any non-example email is flagged).
  let inCandidate = /\.env$/i.test(file)
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,6}\s/.test(line)) inCandidate = /candidate data/i.test(line)
    const hash = lineHash(line)
    if (allow[file]?.has(hash)) continue
    const pm = PASSWORD_RE.exec(line)
    if (pm && !isPlaceholder(pm[2])) out.push({ file, line: i + 1, reason: 'password-like literal (value masked)', hash })
    if (inCandidate) {
      const em = EMAIL_RE.exec(line)
      if (em && !/example\.(com|org|net)$/i.test(em[0])) out.push({ file, line: i + 1, reason: 'email literal in Candidate Data block (value masked)', hash })
    }
  }
  return out
}

function walkSkills(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walkSkills(p, acc)
    else if (SCAN_EXT.test(name)) acc.push(p)
  }
  return acc
}

export function skillFiles(): string[] {
  const files = [...walkSkills(join(ROOT, 'agent/.claude/skills')), ...walkSkills(join(ROOT, '.claude/skills'))]
  const pub = join(ROOT, 'frontend/public')
  if (existsSync(pub)) for (const n of readdirSync(pub)) if (/skill.*\.md$/i.test(n)) files.push(join(pub, n))
  return files
}

// ---- tiny runner ---------------------------------------------------------------------------
let passed = 0, failed = 0
async function t(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ok   ${name}`) }
  catch (e: any) { failed++; console.log(`  FAIL ${name}\n       ${String(e?.message ?? e).split('\n').join('\n       ')}`) }
}

// Synthetic values only.
const SYN = {
  email: 'synthetic.candidate@test-fixture.invalid',
  password: 'Synth3tic-Fixture-Pw!',
  phone: '555-0100-SYNTH',
}

console.log('skill-secrets')

await t('scanner flags a synthetic password literal and a candidate email literal', () => {
  const doc = `# x\n## Candidate Data\n- Email: ${SYN.email}\n- Password: ${SYN.password}\n## Other\ncontact ${SYN.email}\n`
  const f = scanText('synthetic.md', doc, {})
  assert.deepEqual(f.map(x => [x.line, x.reason.split(' ')[0]]), [[3, 'email'], [4, 'password-like']])
  for (const x of f) assert.ok(!x.reason.includes(SYN.password) && !x.reason.includes(SYN.email))
})

await t('scanner flags quoted, assignment and table forms', () => {
  const doc = [
    `"password": "${SYN.password}"`,
    `PASSWORD='${SYN.password}'`,
    `pwd = ${SYN.password}`,
    `| Password | ${SYN.password} |`,
    `password: \`${SYN.password}\``,
  ].join('\n')
  assert.deepEqual(scanText('synthetic.md', doc, {}).map(x => x.line), [1, 2, 3, 4, 5])
})

await t('placeholder check is anchored (a placeholder prefix does not excuse a real value)', () => {
  const doc = [
    `password: <x>${SYN.password}`,
    `password: $X${SYN.password}`,
    `password: YOUR_${SYN.password}`,
    `password: process.env.X+${SYN.password}`,
    `password: ${SYN.password}example`,
  ].join('\n')
  assert.deepEqual(scanText('synthetic.md', doc, {}).map(x => x.line), [1, 2, 3, 4, 5])
})

await t('.env files are scanned as a candidate block', () => {
  const f = scanText('x/candidate.example.env', `CANDIDATE_EMAIL=${SYN.email}\nCANDIDATE_PASSWORD=${SYN.password}\nOK=you@example.com\nCANDIDATE_PASSWORD=YOUR_PASSWORD\n`, {})
  assert.deepEqual(f.map(x => x.line), [1, 2])
})

await t('scanner accepts placeholders and env references', () => {
  const doc = [
    '## Candidate Data',
    '- Email: `$CANDIDATE_EMAIL`',
    '- Password: ${CANDIDATE_PASSWORD}',
    '- password: <your password>',
    'password = process.env.CANDIDATE_PASSWORD',
    'PASSWORD=YOUR_PASSWORD_HERE',
    'pwd: example-password',
    '"password": "${CANDIDATE_PASSWORD}",',
    '| Password | `$CANDIDATE_PASSWORD` |',
    '- Email: someone@example.com',
  ].join('\n')
  assert.deepEqual(scanText('synthetic.md', doc, {}), [])
})

await t('allowlist suppresses by file + line hash only', () => {
  const line = `password: ${SYN.password}`
  assert.equal(scanText('a.md', line, {}).length, 1)
  assert.equal(scanText('a.md', line, { 'a.md': new Set([lineHash(line)]) }).length, 0)
  assert.equal(scanText('b.md', line, { 'a.md': new Set([lineHash(line)]) }).length, 1)
})

await t('no shipped skill markdown contains a password literal or candidate email literal', () => {
  const files = skillFiles()
  for (const want of ['browser-apply/SKILL.md', 'browser-apply/fill.mjs', 'browser-apply/candidate.example.env'])
    assert.ok(files.some(f => f.endsWith(want)), `${want} not found in scan set`)
  const findings = files.flatMap(f => scanText(relative(ROOT, f), readFileSync(f, 'utf8')))
  assert.equal(findings.length, 0, findings.map(x => `${x.file}:${x.line} ${x.reason} [hash ${x.hash}]`).join('\n'))
})

await t('every allowlist entry still matches a real line (no stale entries)', () => {
  for (const [file, hashes] of Object.entries(ALLOWLIST)) {
    const p = join(ROOT, file)
    assert.ok(existsSync(p), `${file} missing`)
    const have = new Set(readFileSync(p, 'utf8').split('\n').map(lineHash))
    for (const h of hashes) assert.ok(have.has(h), `${file}: allowlist hash ${h} matches no line`)
  }
})

// ---- helper: fixed secret file, no env overrides, loopback CDP, confirmed host, field types -----
await t('browser-apply helper exists', () => {
  assert.ok(existsSync(HELPER), 'agent/.claude/skills/browser-apply/fill.mjs missing')
})

if (existsSync(HELPER)) {
  const helper: any = await import(HELPER)
  const dir = mkdtempSync(join(tmpdir(), 'skill-secrets-'))
  const envFile = join(dir, 'candidate.env')
  writeFileSync(envFile, `# synthetic\nCANDIDATE_EMAIL=${SYN.email}\nCANDIDATE_PASSWORD="${SYN.password}"\nCANDIDATE_PHONE=${SYN.phone}\n`)
  const noLeak = (out: string) => { for (const v of Object.values(SYN)) assert.ok(!out.includes(v), 'output leaked a value') }
  const HOST = 'acme.wd1.myworkdayjobs.com'
  const fileEnv = { CANDIDATE_EMAIL: SYN.email, CANDIDATE_PASSWORD: SYN.password, CANDIDATE_PHONE: SYN.phone }
  try {
    await t('helper source reads no environment variables', () => {
      const src = readFileSync(HELPER, 'utf8')
      assert.equal((src.match(/process\.env/g) ?? []).length, 0, 'fill.mjs must not read process.env')
      assert.ok(!/CANDIDATE_ALLOWED_HOSTS|CANDIDATE_ENV_FILE/.test(src), 'removed override names still present')
    })

    await t('secret path is fixed under the passwd home, not $HOME', () => {
      assert.equal(helper.secretPath(), join(userInfo().homedir, '.osborn', 'candidate.env'))
    })

    await t('inline env overrides are ignored by the CLI (file path, CDP URL, hosts, HOME)', () => {
      chmodSync(envFile, 0o600)
      const env = {
        ...process.env,
        HOME: dir,
        CANDIDATE_ENV_FILE: envFile,
        CANDIDATE_CDP_URL: 'http://203.0.113.5:9222',
        CANDIDATE_ALLOWED_HOSTS: 'evil.test',
      }
      for (const args of [['check'], ['fill', '--confirm-host', 'evil.test', 'CANDIDATE_PASSWORD', 'input']]) {
        const r = spawnSync(process.execPath, [HELPER, ...args], { env, encoding: 'utf8', timeout: 20_000 })
        const out = r.stdout + r.stderr
        noLeak(out)
        assert.ok(out.includes(helper.secretPath()), `${args[0]}: expected the fixed secret path in output`)
        assert.ok(!out.includes(envFile) && !out.includes(dir), `${args[0]}: honoured CANDIDATE_ENV_FILE or HOME`)
        assert.ok(!out.includes('203.0.113.5') && !out.includes('evil.test'), `${args[0]}: honoured an env override`)
      }
    })

    await t('loadCandidateEnv refuses 0644, loads 0600, refuses a symlink', () => {
      chmodSync(envFile, 0o644)
      assert.throws(() => helper.loadCandidateEnv(envFile), /600/)
      chmodSync(envFile, 0o600)
      const env = helper.loadCandidateEnv(envFile)
      assert.equal(env.CANDIDATE_EMAIL, SYN.email)
      assert.equal(env.CANDIDATE_PASSWORD, SYN.password)
      const link = join(dir, 'link.env')
      symlinkSync(envFile, link)
      assert.throws(() => helper.loadCandidateEnv(link), /symlink/)
    })

    await t('CDP URL: loopback only, from the file or the default', () => {
      for (const ok of ['http://127.0.0.1:9222', 'http://localhost:9222', 'http://[::1]:9222', 'ws://127.0.0.1:9222/devtools/browser/x'])
        assert.doesNotThrow(() => helper.resolveCdpUrl(ok), ok)
      for (const bad of ['http://203.0.113.5:9222', 'http://localhost.evil.test:9222', 'http://127.0.0.1.evil.test:9222', 'http://user:pw@127.0.0.1:9222', 'file:///tmp/x', 'not a url'])
        assert.throws(() => helper.resolveCdpUrl(bad), undefined, bad)
      assert.equal(helper.cdpFrom({}), 'http://127.0.0.1:9222')
      assert.equal(helper.cdpFrom({ CANDIDATE_CDP_URL: 'http://localhost:9333' }), 'http://localhost:9333')
      assert.throws(() => helper.cdpFrom({ CANDIDATE_CDP_URL: 'http://203.0.113.5:9222' }), /loopback/)
    })

    await t('ws endpoint from /json/version must also be loopback', async () => {
      const fake = (ws: string) => async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: ws }) })
      assert.equal(await helper.resolveWsEndpoint('http://127.0.0.1:9222', fake('ws://127.0.0.1:9222/devtools/browser/abc')), 'ws://127.0.0.1:9222/devtools/browser/abc')
      await assert.rejects(helper.resolveWsEndpoint('http://127.0.0.1:9222', fake('ws://203.0.113.5:9222/devtools/browser/abc')), /loopback/)
      await assert.rejects(helper.resolveWsEndpoint('http://127.0.0.1:9222', async () => { throw new Error('ECONNREFUSED') }), /no browser reachable/)
    })

    await t('check report: names and cdp status only, unreachable when the probe fails', async () => {
      const down = async () => { throw new Error('ECONNREFUSED') }
      const lines: string[] = await helper.checkReport('/x/candidate.env', fileEnv, down)
      const out = lines.join('\n')
      noLeak(out)
      assert.match(out, /set: CANDIDATE_EMAIL, CANDIDATE_PASSWORD, CANDIDATE_PHONE/)
      assert.match(out, /cdp: unreachable/)
      const up = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }) })
      assert.match((await helper.checkReport('/x', fileEnv, up)).join('\n'), /cdp: reachable/)
      await assert.rejects(helper.checkReport('/x', { ...fileEnv, CANDIDATE_CDP_URL: 'http://203.0.113.5:9222' }, up), /loopback/)
    })

    await t('--confirm-host is required, must be a bare hostname, and other options are refused', () => {
      assert.throws(() => helper.parseFillArgs(['CANDIDATE_PASSWORD', 'input']), /missing --confirm-host/)
      for (const bad of ['https://acme.wd1.myworkdayjobs.com', 'acme.wd1.myworkdayjobs.com:443', '*.myworkdayjobs.com', 'acme.wd1.myworkdayjobs.com/x', 'localhost', ''])
        assert.throws(() => helper.parseFillArgs(['--confirm-host', bad, 'CANDIDATE_PASSWORD', 'input']), undefined, bad)
      assert.equal(helper.parseFillArgs(['--confirm-host', 'ACME.wd1.MyWorkdayJobs.com', 'CANDIDATE_EMAIL', 'input']).host, HOST)
      for (const opt of ['--cdp', '--allowed-hosts', '--url-contains'])
        assert.throws(() => helper.parseFillArgs(['--confirm-host', HOST, opt, 'x', 'CANDIDATE_EMAIL', 'input']), /unknown option/)
    })

    await t('fieldVerdict: password only into input[type=password]; exact https host from the element frame', () => {
      const href = `https://${HOST}/en-US/apply`
      const v = (name: string, tagName: string, type: string, h = href) => helper.fieldVerdict(name, { tagName, type, href: h }, HOST).ok
      assert.equal(v('CANDIDATE_PASSWORD', 'INPUT', 'password'), true)
      for (const [tag, type] of [['INPUT', 'text'], ['INPUT', 'email'], ['INPUT', 'search'], ['INPUT', 'hidden'], ['TEXTAREA', ''], ['DIV', '']])
        assert.equal(v('CANDIDATE_PASSWORD', tag, type), false, `password into ${tag}/${type}`)
      assert.equal(v('CANDIDATE_EMAIL', 'INPUT', 'email'), true)
      assert.equal(v('CANDIDATE_EMAIL', 'INPUT', 'text'), true)
      for (const [tag, type] of [['INPUT', 'password'], ['INPUT', 'hidden'], ['TEXTAREA', ''], ['INPUT', 'url']])
        assert.equal(v('CANDIDATE_EMAIL', tag, type), false, `email into ${tag}/${type}`)
      assert.equal(v('CANDIDATE_PHONE', 'INPUT', 'tel'), true)
      assert.equal(v('CANDIDATE_PHONE', 'INPUT', 'hidden'), false)
      assert.equal(v('CANDIDATE_ADDRESS_LINE1', 'TEXTAREA', ''), true)
      // frame checks (cross-origin iframe, http, parent/sub/lookalike host)
      for (const bad of [`http://${HOST}/`, 'https://evil.test/', 'https://myworkdayjobs.com/', `https://x.${HOST}/`, `https://${HOST}.evil.test/`, 'about:blank', ''])
        assert.equal(v('CANDIDATE_PASSWORD', 'INPUT', 'password', bad), false, `frame ${bad}`)
    })

    // Fake Playwright: elements expose the same DOM surface IN_PAGE_FILL uses.
    const fakeEl = (tagName: string, type: string, href: string) => {
      const proto: any = {}
      Object.defineProperty(proto, 'value', { set(this: any, x: string) { this._value = x }, get(this: any) { return this._value } })
      class Ev { type: string; constructor(t: string) { this.type = t } }
      const el: any = { tagName, type, _value: undefined, events: [] as string[], focus() {}, dispatchEvent(e: any) { el.events.push(e.type) } }
      el.ownerDocument = { location: { href }, defaultView: { HTMLInputElement: { prototype: proto }, HTMLTextAreaElement: { prototype: proto }, Event: Ev } }
      return el
    }
    const fakeDeps = (pages: { url: string, el: any }[]) => {
      const calls = { fetch: 0, load: 0, connect: [] as string[], logs: [] as string[] }
      const deps = {
        log: (s: string) => calls.logs.push(s),
        fetchImpl: async () => { calls.fetch++; return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }) } },
        loadChromium: async () => {
          calls.load++
          return {
            connectOverCDP: async (ws: string) => {
              calls.connect.push(ws)
              return {
                contexts: () => [{ pages: () => pages.map(p => ({ url: () => p.url, locator: () => ({ first: () => ({ evaluate: async (fn: any, arg: any) => fn(p.el, arg) }) }) })) }],
                close: async () => {},
              }
            },
          }
        },
      }
      return { deps, calls }
    }
    const ARGS = ['--confirm-host', HOST, 'CANDIDATE_PASSWORD', 'input[type="password"]']

    await t('runFill: non-loopback CDP URL in the file refuses before fetching, loading Playwright or connecting', async () => {
      const { deps, calls } = fakeDeps([])
      await assert.rejects(helper.runFill(ARGS, { ...fileEnv, CANDIDATE_CDP_URL: 'http://203.0.113.5:9222' }, deps), /loopback/)
      assert.deepEqual([calls.fetch, calls.load, calls.connect.length], [0, 0, 0])
    })

    await t('runFill: missing or mismatched --confirm-host refuses', async () => {
      const el = fakeEl('INPUT', 'password', `https://${HOST}/apply`)
      for (const args of [
        ['CANDIDATE_PASSWORD', 'input'],
        ['--confirm-host', 'other.wd1.myworkdayjobs.com', 'CANDIDATE_PASSWORD', 'input'],
        ['--confirm-host', 'myworkdayjobs.com', 'CANDIDATE_PASSWORD', 'input'],
        ['--confirm-host', 'evil.test', 'CANDIDATE_PASSWORD', 'input'],
      ]) {
        const { deps } = fakeDeps([{ url: `https://${HOST}/apply`, el }])
        await assert.rejects(helper.runFill(args, fileEnv, deps), /confirm-host|refusing to fill/, args.join(' '))
      }
      assert.equal(el._value, undefined, 'value was written despite refusal')
    })

    await t('runFill: prints "about to fill" before filling, uses the loopback ws endpoint, writes via input/change', async () => {
      const el = fakeEl('INPUT', 'password', `https://${HOST}/apply`)
      const { deps, calls } = fakeDeps([{ url: 'https://evil.test/', el: fakeEl('INPUT', 'password', 'https://evil.test/') }, { url: `https://${HOST}/apply`, el }])
      await helper.runFill(ARGS, fileEnv, deps)
      assert.deepEqual(calls.logs, [`about to fill CANDIDATE_PASSWORD on ${HOST}`, 'filled CANDIDATE_PASSWORD -> input[type="password"]'])
      assert.deepEqual(calls.connect, ['ws://127.0.0.1:9222/devtools/browser/abc'])
      assert.ok(el._value === SYN.password, 'value not written')
      assert.deepEqual(el.events, ['input', 'change'])
      noLeak(calls.logs.join('\n'))
    })

    await t('runFill: element in a frame on another origin is refused in-page (TOCTOU / iframe)', async () => {
      const el = fakeEl('INPUT', 'password', 'https://evil.test/frame')
      const { deps } = fakeDeps([{ url: `https://${HOST}/apply`, el }])
      await assert.rejects(helper.runFill(ARGS, fileEnv, deps), /frame host is not the confirmed host/)
      assert.equal(el._value, undefined)
    })

    await t('runFill: password into a text input is refused in-page', async () => {
      const el = fakeEl('INPUT', 'text', `https://${HOST}/apply`)
      const { deps } = fakeDeps([{ url: `https://${HOST}/apply`, el }])
      await assert.rejects(helper.runFill(ARGS, fileEnv, deps), /input type password/)
      assert.equal(el._value, undefined)
    })

    await t('mask hides raw, JSON-escaped and URL-encoded forms, and suppresses short values', () => {
      const v = 'Sy"n\\th-Pw/1'
      const msg = `a ${v} b ${JSON.stringify(v).slice(1, -1)} c ${encodeURIComponent(v)}`
      const m = helper.mask(msg, { CANDIDATE_PASSWORD: v })
      assert.ok(!m.includes(v) && !m.includes(JSON.stringify(v).slice(1, -1)) && !m.includes(encodeURIComponent(v)))
      assert.match(helper.mask('field 42 failed', { CANDIDATE_ZIP: '42' }), /suppressed/)
      assert.equal(helper.mask('nothing here', { CANDIDATE_ZIP: '42' }), 'nothing here')
      assert.equal(helper.mask('cdp http://127.0.0.1:9222', { CANDIDATE_CDP_URL: 'http://127.0.0.1:9222' }), 'cdp http://127.0.0.1:9222')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
