#!/usr/bin/env node
// browser-apply secret filler. Reads candidate values from a mode-600 env file and types them into
// the browser in THIS process, so the values never appear in tool output or model context.
//
//   node fill.mjs check
//       Verifies the secret file exists and is chmod 600. Prints variable NAMES only.
//   node fill.mjs fill [--cdp http://127.0.0.1:9222] [--url-contains workday] NAME SELECTOR [NAME SELECTOR ...]
//       Connects to the already-open browser over CDP and fills each SELECTOR with the value of NAME.
//       Example: node fill.mjs fill CANDIDATE_EMAIL 'input[type="email"]'
//
// Secret file: $CANDIDATE_ENV_FILE, default ~/.osborn/candidate.env (KEY=VALUE lines, # comments).
// The helper never prints a value. It refuses to run if the file is readable by group or other.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
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
  try { st = statSync(path) } catch { throw new Error(`secret file not found: ${path} (copy candidate.example.env there and chmod 600)`) }
  if (!st.isFile()) throw new Error(`secret file is not a regular file: ${path}`)
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`refusing to read ${path}: mode ${(st.mode & 0o777).toString(8)} is too open, run: chmod 600 ${path}`)
  }
  return parseEnv(readFileSync(path, 'utf8'))
}

function mask(msg, env) {
  let s = String(msg)
  for (const v of Object.values(env)) if (v && v.length >= 3) s = s.split(v).join('***')
  return s
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
  let cdp = process.env.CANDIDATE_CDP_URL || 'http://127.0.0.1:9222'
  let urlContains = ''
  const pairs = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--cdp') cdp = args[++i]
    else if (a === '--url-contains') urlContains = args[++i]
    else {
      const selector = args[++i]
      if (!selector) throw new Error(`missing selector after ${a.slice(0, 40)} (want NAME SELECTOR pairs)`)
      pairs.push([a, selector])
    }
  }
  if (!pairs.length) throw new Error('nothing to fill: pass NAME SELECTOR pairs')
  for (const [name] of pairs) {
    if (!/^CANDIDATE_[A-Z0-9_]+$/.test(name)) throw new Error(`only CANDIDATE_* names may be filled: ${name}`)
    if (!env[name]) throw new Error(`${name} is not set in the secret file`)
  }
  const chromium = await loadChromium()
  let browser
  try { browser = await chromium.connectOverCDP(cdp) } catch {
    throw new Error(`no browser reachable over CDP at ${cdp}; ask the user to type the secret fields themselves`)
  }
  try {
    const pages = browser.contexts().flatMap(c => c.pages())
    const page = (urlContains ? pages.filter(p => p.url().includes(urlContains)) : pages).at(-1)
    if (!page) throw new Error(`no open page${urlContains ? ` matching "${urlContains}"` : ''}`)
    for (const [name, selector] of pairs) {
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
      console.log(`ok: ${path} is mode 600`)
      console.log(`set: ${set.join(', ') || '(none)'}`)
      if (missing.length) console.log(`missing: ${missing.join(', ')}`)
      return
    }
    if (cmd === 'fill') return await fill(rest, env)
    console.error('usage: node fill.mjs check | fill [--cdp URL] [--url-contains S] NAME SELECTOR [NAME SELECTOR ...]')
    process.exitCode = 2
  } catch (e) {
    console.error(`browser-apply fill: ${mask(e?.message ?? e, env)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
