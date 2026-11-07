#!/usr/bin/env node
// browser-apply secret filler. Reads candidate values from a mode-600 env file and types them into
// the browser in THIS process, so the values never appear in tool output or model context.
//
//   node fill.mjs check
//       Verifies the secret file (regular file, not a symlink, owned by you, chmod 600), prints
//       variable NAMES only, and reports whether the loopback CDP browser is reachable.
//   node fill.mjs fill [--url-contains S] NAME SELECTOR [NAME SELECTOR ...]
//       Connects to the already-open browser over CDP and fills each SELECTOR with the value of NAME,
//       on the most recent page whose host is allowlisted (and whose URL contains S, if given).
//       Example: node fill.mjs fill CANDIDATE_EMAIL 'input[type="email"]'
//
// Environment (no CLI overrides, so the target cannot be redirected from a command line):
//   CANDIDATE_ENV_FILE      secret file, default ~/.osborn/candidate.env (KEY=VALUE lines, # comments)
//   CANDIDATE_CDP_URL       CDP endpoint, default http://127.0.0.1:9222; must be loopback
//   CANDIDATE_ALLOWED_HOSTS comma-separated page hosts that may receive values, default myworkdayjobs.com
//                           (a host matches itself and its subdomains); pages must be https
// The helper never prints a value.
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
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

export const DEFAULT_CDP_URL = 'http://127.0.0.1:9222'
export const DEFAULT_ALLOWED_HOSTS = ['myworkdayjobs.com']
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function defaultEnvPath() {
  return process.env.CANDIDATE_ENV_FILE || join(homedir(), '.osborn', 'candidate.env')
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

export function loadCandidateEnv(path = defaultEnvPath()) {
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

/** Returns the CDP URL from the environment, or throws if it is not a loopback http(s)/ws(s) URL. */
export function resolveCdpUrl(raw = process.env.CANDIDATE_CDP_URL || DEFAULT_CDP_URL) {
  let u
  try { u = new URL(raw) } catch { throw new Error('CANDIDATE_CDP_URL is not a valid URL') }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) throw new Error('CANDIDATE_CDP_URL must be http(s) or ws(s)')
  if (u.username || u.password) throw new Error('CANDIDATE_CDP_URL must not carry credentials')
  if (!LOOPBACK_HOSTS.has(u.hostname)) throw new Error('refusing CANDIDATE_CDP_URL: host is not loopback (127.0.0.1, localhost or ::1)')
  return u.href.replace(/\/$/, '')
}

export function allowedHosts(raw = process.env.CANDIDATE_ALLOWED_HOSTS) {
  const list = (raw ?? '').split(',').map(s => s.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean)
  return list.length ? list : DEFAULT_ALLOWED_HOSTS
}

export function hostAllowed(pageUrl, hosts = allowedHosts()) {
  let u
  try { u = new URL(pageUrl) } catch { return false }
  if (u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  return hosts.some(a => h === a || h.endsWith('.' + a))
}

/** Picks the most recent page whose host is allowlisted (and URL contains urlContains, if set). Throws otherwise. */
export function selectPage(pages, hosts = allowedHosts(), urlContains = '') {
  if (!pages.length) throw new Error('no open page in the CDP browser')
  const ok = pages.filter(p => hostAllowed(p.url(), hosts) && (!urlContains || p.url().includes(urlContains)))
  if (!ok.length) throw new Error(`refusing to fill: no open https page on an allowed host (${hosts.join(', ')})${urlContains ? ` containing "${urlContains}"` : ''}`)
  return ok.at(-1)
}

export function mask(msg, env) {
  let s = String(msg)
  for (const v of Object.values(env)) {
    if (!v) continue
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

export async function probeCdp(cdp, timeoutMs = 1500) {
  const httpBase = cdp.replace(/^ws(s?):/, 'http$1:')
  try {
    const r = await fetch(`${httpBase}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok
  } catch { return false }
}

async function loadChromium() {
  // ESM import() ignores NODE_PATH, so also resolve from the cwd and the global npm root.
  const require = createRequire(import.meta.url)
  let globalRoot = ''
  try { globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* npm missing */ }
  for (const mod of ['playwright', 'playwright-core']) {
    try { const m = await import(mod); if (m.chromium) return m.chromium } catch { /* try next */ }
    try {
      const resolved = require.resolve(mod, { paths: [process.cwd(), globalRoot].filter(Boolean) })
      const m = await import(pathToFileURL(resolved).href)
      const chromium = m.chromium ?? m.default?.chromium
      if (chromium) return chromium
    } catch { /* try next */ }
  }
  throw new Error('playwright not installed: run `npm i -g playwright` (or install it in the current directory)')
}

async function fill(args, env) {
  let urlContains = ''
  const pairs = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--url-contains') { urlContains = args[++i] ?? ''; continue }
    if (a.startsWith('--')) throw new Error(`unknown option ${a.slice(0, 40)} (the CDP URL comes only from CANDIDATE_CDP_URL)`)
    const selector = args[++i]
    if (!selector) throw new Error(`missing selector after ${a.slice(0, 40)} (want NAME SELECTOR pairs)`)
    pairs.push([a, selector])
  }
  if (!pairs.length) throw new Error('nothing to fill: pass NAME SELECTOR pairs')
  for (const [name] of pairs) {
    if (!/^CANDIDATE_[A-Z0-9_]+$/.test(name)) throw new Error(`only CANDIDATE_* names may be filled: ${name.slice(0, 40)}`)
    if (!env[name]) throw new Error(`${name} is not set in the secret file`)
  }
  // Validate the target before loading Playwright or opening any connection.
  const cdp = resolveCdpUrl()
  const hosts = allowedHosts()
  const chromium = await loadChromium()
  let browser
  try { browser = await chromium.connectOverCDP(cdp) } catch {
    throw new Error(`no browser reachable over CDP at ${cdp}; ask the user to type the secret fields themselves`)
  }
  try {
    const page = selectPage(browser.contexts().flatMap(c => c.pages()), hosts, urlContains)
    for (const [name, selector] of pairs) {
      // Re-check right before each fill in case the page navigated away.
      if (!hostAllowed(page.url(), hosts)) throw new Error('refusing to fill: page navigated off the allowed host')
      await page.locator(selector).first().fill(env[name], { timeout: 10_000 })
      console.log(`filled ${name} -> ${selector}`)
    }
  } finally {
    // connectOverCDP: close() detaches this client only; the user's browser stays open.
    await browser.close().catch(() => {})
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const path = defaultEnvPath()
  let env = {}
  try {
    env = loadCandidateEnv(path)
    if (cmd === 'check') {
      const set = EXPECTED_VARS.filter(k => env[k])
      const missing = EXPECTED_VARS.filter(k => !env[k])
      console.log(`ok: ${path} is a regular file owned by you, mode 600`)
      console.log(`set: ${set.join(', ') || '(none)'}`)
      if (missing.length) console.log(`missing: ${missing.join(', ')}`)
      console.log(`allowed hosts: ${allowedHosts().join(', ')}`)
      const cdp = resolveCdpUrl()
      console.log(`cdp: ${(await probeCdp(cdp)) ? 'reachable' : 'unreachable'} (${cdp})`)
      return
    }
    if (cmd === 'fill') return await fill(rest, env)
    console.error('usage: node fill.mjs check | fill [--url-contains S] NAME SELECTOR [NAME SELECTOR ...]')
    process.exitCode = 2
  } catch (e) {
    console.error(`browser-apply fill: ${mask(e?.message ?? e, env)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
