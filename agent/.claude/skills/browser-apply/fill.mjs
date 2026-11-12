#!/usr/bin/env node
// browser-apply secret filler. Reads candidate values from a mode-600 file and types them into
// the browser in THIS process, so the values never appear in tool output or model context.
//
//   node fill.mjs check
//       Verifies the secret file (regular file, not a symlink, owned by you, chmod 600), prints
//       variable NAMES only, and whether the loopback CDP browser is reachable.
//   node fill.mjs fill --confirm-host HOST NAME SELECTOR [NAME SELECTOR ...]
//       Attaches to the already-open browser over loopback CDP and fills each SELECTOR with the
//       value of NAME on the most recent https page whose host is EXACTLY HOST. HOST is the host the
//       user just confirmed out loud; it is visible in the command the user approves.
//       Example: node fill.mjs fill --confirm-host acme.wd1.myworkdayjobs.com CANDIDATE_EMAIL 'input[type="email"]'
//
// Config comes from ONE place the model cannot redirect: the fixed file
// <passwd home>/.osborn/candidate.env (home from the OS user database, not $HOME). The helper reads
// NO environment variables and has no path or URL options. Besides the CANDIDATE_* values, that file
// may set CANDIDATE_CDP_URL (loopback only, default http://127.0.0.1:9222), edited only by the user.
// Each value is written inside the page in one synchronous step that first checks the element type
// (password only into <input type=password>) and that the element's own frame is https on HOST.
// The helper never prints a value.
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const EXPECTED_VARS = [
  'CANDIDATE_EMAIL',
  'CANDIDATE_PASSWORD',
  'CANDIDATE_FIRST_NAME',
  'CANDIDATE_LAST_NAME',
  'CANDIDATE_PHONE',
  'CANDIDATE_ADDRESS_LINE1',
  'CANDIDATE_CITY',
  'CANDIDATE_STATE',
  'CANDIDATE_ZIP',
]
export const CONFIG_KEYS = ['CANDIDATE_CDP_URL']
export const DEFAULT_CDP_URL = 'http://127.0.0.1:9222'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Fixed secret-file path. Uses the passwd home directory so $HOME cannot redirect it. */
export function secretPath() {
  return join(userInfo().homedir, '.osborn', 'candidate.env')
}

export function parseEnv(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

/** Reads and validates a secret file. The CLI only ever calls this with secretPath(). */
export function loadCandidateEnv(path) {
  let st
  try { st = lstatSync(path) } catch { throw new Error(`secret file not found: ${path} (copy candidate.example.env there and chmod 600)`) }
  if (st.isSymbolicLink()) throw new Error(`refusing to read ${path}: it is a symlink; use a regular file`)
  if (!st.isFile()) throw new Error(`secret file is not a regular file: ${path}`)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`refusing to read ${path}: owned by uid ${st.uid}, not the current user`)
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`refusing to read ${path}: mode ${(st.mode & 0o777).toString(8)} is too open, run: chmod 600 ${path}`)
  }
  return parseEnv(readFileSync(path, 'utf8'))
}

/** Validates a CDP URL (from the secret file or the default). Throws unless loopback http(s)/ws(s). */
export function resolveCdpUrl(raw) {
  let u
  try { u = new URL(raw || DEFAULT_CDP_URL) } catch { throw new Error('CANDIDATE_CDP_URL is not a valid URL') }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) throw new Error('CANDIDATE_CDP_URL must be http(s) or ws(s)')
  if (u.username || u.password) throw new Error('CANDIDATE_CDP_URL must not carry credentials')
  if (!LOOPBACK_HOSTS.has(u.hostname)) throw new Error('refusing CDP URL: host is not loopback (127.0.0.1, localhost or ::1)')
  return u.href.replace(/\/$/, '')
}

/** CDP URL comes only from the validated secret file, falling back to the hardcoded default. */
export function cdpFrom(fileEnv) {
  return resolveCdpUrl(fileEnv.CANDIDATE_CDP_URL)
}

/** Validates the --confirm-host value: a bare hostname (no scheme, port, path or wildcard). */
export function normalizeConfirmHost(raw) {
  const h = String(raw ?? '').trim().toLowerCase()
  if (!h) throw new Error('missing --confirm-host HOST (ask the user to confirm the site first)')
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) {
    throw new Error('--confirm-host must be a bare hostname like acme.wd1.myworkdayjobs.com')
  }
  return h
}

/** True only for an https URL whose hostname is EXACTLY host. */
export function hostMatches(pageUrl, host) {
  let u
  try { u = new URL(pageUrl) } catch { return false }
  return u.protocol === 'https:' && u.hostname.toLowerCase() === host
}

/**
 * Decides whether value NAME may be written into an element, from facts gathered in the element's
 * own frame. Pure and self-contained (no outer references): it is also serialized into the page.
 * facts: { tagName, type, href } where href is el.ownerDocument.location.href.
 */
export function fieldVerdict(name, facts, host) {
  let u
  try { u = new URL(facts.href) } catch { return { ok: false, reason: 'frame has no valid URL' } }
  if (u.protocol !== 'https:') return { ok: false, reason: 'frame is not https' }
  if (u.hostname.toLowerCase() !== host) return { ok: false, reason: 'frame host is not the confirmed host' }
  const tag = String(facts.tagName || '').toUpperCase()
  const type = String(facts.type || '').toLowerCase()
  const allow = {
    CANDIDATE_PASSWORD: ['password'],
    CANDIDATE_EMAIL: ['email', 'text'],
    CANDIDATE_PHONE: ['tel', 'text'],
    CANDIDATE_ZIP: ['text', 'number'],
  }
  const types = allow[name] || ['text']
  if (tag === 'TEXTAREA' && name !== 'CANDIDATE_PASSWORD' && name !== 'CANDIDATE_EMAIL') return { ok: true }
  if (tag !== 'INPUT') return { ok: false, reason: `target is <${tag.toLowerCase() || '?'}>, not <input>` }
  if (!types.includes(type)) return { ok: false, reason: `${name} may only go into input type ${types.join('|')}, target is type ${type || '?'}` }
  return { ok: true }
}

// Runs inside the page via locator.evaluate: gathers facts from the element's own frame, applies
// fieldVerdict, and only then sets the value and fires input/change. One synchronous call, so the
// frame cannot navigate between the check and the write.
export const IN_PAGE_FILL = new Function('el', 'arg', `
  const fieldVerdict = ${fieldVerdict.toString()};
  const doc = el && el.ownerDocument;
  const view = doc && doc.defaultView;
  const facts = {
    tagName: el && el.tagName,
    type: el && el.tagName === 'INPUT' ? String(el.type || '').toLowerCase() : '',
    href: doc && doc.location ? String(doc.location.href) : '',
  };
  const v = fieldVerdict(arg.name, facts, arg.host);
  if (!v.ok) return { ok: false, reason: v.reason };
  const proto = el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  if (typeof el.focus === 'function') el.focus();
  setter.call(el, arg.value);
  el.dispatchEvent(new view.Event('input', { bubbles: true }));
  el.dispatchEvent(new view.Event('change', { bubbles: true }));
  return { ok: true };
`)

/** Picks the most recent https page whose host is exactly host. Throws otherwise. */
export function selectPage(pages, host) {
  if (!pages.length) throw new Error('no open page in the CDP browser')
  const ok = pages.filter(p => hostMatches(p.url(), host))
  if (!ok.length) throw new Error(`refusing to fill: no open https page on ${host}`)
  return ok.at(-1)
}

export function mask(msg, env) {
  let s = String(msg)
  for (const [k, v] of Object.entries(env)) {
    if (!v || CONFIG_KEYS.includes(k)) continue
    const forms = new Set([v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)])
    for (const f of forms) {
      if (!f || !s.includes(f)) continue
      // Values too short to mask without mangling the message: suppress the whole message.
      if (f.length < 4) return 'error (details suppressed to avoid echoing a value)'
      s = s.split(f).join('***')
    }
  }
  return s
}

/**
 * Resolves the browser WebSocket endpoint ourselves and requires it to be loopback too, so a
 * /json/version response cannot point Playwright at a remote host. Playwright's CDP-connected
 * Browser does not expose the endpoint it used, so this is checked before connecting, and the
 * validated ws:// URL is what we hand to connectOverCDP.
 */
export async function resolveWsEndpoint(cdp, fetchImpl = fetch, timeoutMs = 1500) {
  if (/^wss?:/.test(cdp)) return resolveCdpUrl(cdp)
  let ws
  try {
    const r = await fetchImpl(`${cdp}/json/version`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
    if (!r.ok) throw new Error('bad status')
    ws = (await r.json()).webSocketDebuggerUrl
  } catch {
    throw new Error(`no browser reachable over CDP at ${cdp}; ask the user to type the secret fields themselves`)
  }
  if (typeof ws !== 'string' || !/^wss?:/.test(ws)) throw new Error('CDP /json/version returned no WebSocket endpoint')
  return resolveCdpUrl(ws)
}

export async function probeCdp(cdp, fetchImpl = fetch) {
  try { await resolveWsEndpoint(cdp, fetchImpl); return true } catch { return false }
}

async function loadChromium() {
  // ESM import() ignores NODE_PATH, so also resolve from the cwd and the global npm root.
  const require = createRequire(import.meta.url)
  let globalRoot = ''
  try { globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* npm missing */ }
  for (const mod of ['playwright-core', 'playwright']) {
    try { const m = await import(mod); if (m.chromium) return m.chromium } catch { /* try next */ }
    try {
      const resolved = require.resolve(mod, { paths: [process.cwd(), globalRoot].filter(Boolean) })
      const m = await import(pathToFileURL(resolved).href)
      const chromium = m.chromium ?? m.default?.chromium
      if (chromium) return chromium
    } catch { /* try next */ }
  }
  throw new Error('playwright-core not installed: run `npm i -g playwright-core`')
}

export function parseFillArgs(args) {
  let confirmHost
  const pairs = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--confirm-host') { confirmHost = args[++i]; continue }
    if (a.startsWith('--')) throw new Error(`unknown option ${a.slice(0, 40)}`)
    const selector = args[++i]
    if (!selector) throw new Error(`missing selector after ${a.slice(0, 40)} (want NAME SELECTOR pairs)`)
    pairs.push([a, selector])
  }
  const host = normalizeConfirmHost(confirmHost)
  if (!pairs.length) throw new Error('nothing to fill: pass NAME SELECTOR pairs')
  return { host, pairs }
}

/** fill command. fileEnv is the parsed secret file; deps are injectable for tests only. */
export async function runFill(args, fileEnv, deps = {}) {
  const log = deps.log ?? console.log
  const { host, pairs } = parseFillArgs(args)
  for (const [name] of pairs) {
    if (!/^CANDIDATE_[A-Z0-9_]+$/.test(name) || CONFIG_KEYS.includes(name)) throw new Error(`only CANDIDATE_* values may be filled: ${name.slice(0, 40)}`)
    if (!fileEnv[name]) throw new Error(`${name} is not set in the secret file`)
  }
  // Validate the target before loading Playwright or opening any connection.
  const cdp = cdpFrom(fileEnv)
  const ws = await resolveWsEndpoint(cdp, deps.fetchImpl ?? fetch)
  const chromium = await (deps.loadChromium ?? loadChromium)()
  let browser
  try { browser = await chromium.connectOverCDP(ws) } catch {
    throw new Error(`no browser reachable over CDP at ${cdp}; ask the user to type the secret fields themselves`)
  }
  try {
    const page = selectPage(browser.contexts().flatMap(c => c.pages()), host)
    for (const [name, selector] of pairs) {
      log(`about to fill ${name} on ${host}`)
      const res = await page.locator(selector).first().evaluate(IN_PAGE_FILL, { name, value: fileEnv[name], host }, { timeout: 10_000 })
      if (!res || !res.ok) throw new Error(`refusing to fill ${name} -> ${selector}: ${res?.reason ?? 'no result'}`)
      log(`filled ${name} -> ${selector}`)
    }
  } finally {
    // connectOverCDP: close() detaches this client only; the user's browser stays open.
    await browser.close().catch(() => {})
  }
}

/** check command output lines (names and config only, never values). */
export async function checkReport(path, fileEnv, fetchImpl = fetch) {
  const set = EXPECTED_VARS.filter(k => fileEnv[k])
  const missing = EXPECTED_VARS.filter(k => !fileEnv[k])
  const cdp = cdpFrom(fileEnv)
  // Anything else the user put in the file: work history, education, and any
  // key a future form needs. Per-entry and open-ended, so deliberately not in
  // EXPECTED_VARS (one job and no degree must not read as "missing"); listed by
  // NAME so the model can see what it may fill and never invents an employer.
  const extra = Object.keys(fileEnv)
    .filter(k => k.startsWith('CANDIDATE_') && fileEnv[k] && !EXPECTED_VARS.includes(k) && !CONFIG_KEYS.includes(k))
    .sort()
  const lines = [`ok: ${path} is a regular file owned by you, mode 600`, `set: ${set.join(', ') || '(none)'}`]
  if (missing.length) lines.push(`missing: ${missing.join(', ')}`)
  lines.push(`extra: ${extra.join(', ') || '(none — ask the user for any work history, education or other field the form needs)'}`)
  lines.push(`cdp: ${(await probeCdp(cdp, fetchImpl)) ? 'reachable' : 'unreachable'} (${cdp})`)
  return lines
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const path = secretPath()
  let fileEnv = {}
  try {
    fileEnv = loadCandidateEnv(path)
    if (cmd === 'check') { for (const l of await checkReport(path, fileEnv)) console.log(l); return }
    if (cmd === 'fill') return await runFill(rest, fileEnv)
    console.error('usage: node fill.mjs check | fill --confirm-host HOST NAME SELECTOR [NAME SELECTOR ...]')
    process.exitCode = 2
  } catch (e) {
    console.error(`browser-apply fill: ${mask(e?.message ?? e, fileEnv)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
