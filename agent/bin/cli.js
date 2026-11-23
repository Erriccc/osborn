#!/usr/bin/env node

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, existsSync, lstatSync, symlinkSync } from 'fs'
import os from 'os'
import { superviseChild } from './child-exit.js'

// On Fly machines, home is /root (ephemeral) but sessions live on /workspace/.claude.
// Recreate the symlink on every startup so sessions survive image updates.
try {
  const home = os.homedir()
  const target = '/workspace/.claude'
  const link = join(home, '.claude')
  if (existsSync(target) && home !== '/workspace') {
    let needsLink = true
    try {
      const stat = lstatSync(link)
      needsLink = !stat.isSymbolicLink()
    } catch {}
    if (needsLink) symlinkSync(target, link)
  }
} catch {}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Pass all args to the actual agent
const args = process.argv.slice(2)

// Check for version flag — read from package.json relative to this binary.
// Used by the Sprite bootstrap to verify install via marker file. Must exit
// before any env-var checks since `osborn --version` should work without
// LiveKit/etc credentials configured.
if (args.includes('--version') || args.includes('-v')) {
  try {
    const pkgPath = join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    console.log(pkg.version)
    process.exit(0)
  } catch (err) {
    console.error('Could not read package.json:', err.message)
    process.exit(1)
  }
}

// Check for help
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Osborn Agent - Voice AI Coding Assistant

Usage:
  osborn-agent --room <code>     Connect to a specific room
  osborn-agent dev               Run in development mode
  osborn-agent start             Run in production mode

Options:
  --room <code>    Room code from the Osborn web interface
  --version, -v    Print version and exit
  --help, -h       Show this help message

Environment Variables:
  LIVEKIT_URL          LiveKit server URL
  LIVEKIT_API_KEY      LiveKit API key
  LIVEKIT_API_SECRET   LiveKit API secret
  OPENAI_API_KEY       OpenAI API key (for voice)
  ANTHROPIC_API_KEY    Anthropic API key (for Claude Code)
  GOOGLE_API_KEY       Google API key (for Gemini)

Config File:
  ~/.osborn/config.yaml    MCP servers and settings

Example:
  osborn-agent --room abc123
`)
  process.exit(0)
}

// Determine mode (default to 'dev' if no mode specified)
let mode = 'dev'
if (args.includes('start')) {
  mode = 'start'
  args.splice(args.indexOf('start'), 1)
} else if (args.includes('dev')) {
  args.splice(args.indexOf('dev'), 1)
}

const tsxPath = join(__dirname, '..', 'node_modules', '.bin', 'tsx')

/** An agent entry: src/<rel>.ts (dev, run via tsx) if available, otherwise dist/<rel>.js (npm install), else null. */
function agentEntry(rel) {
  const src = join(__dirname, '..', 'src', `${rel}.ts`)
  if (existsSync(src)) return { src }
  const dist = join(__dirname, '..', 'dist', `${rel}.js`)
  return existsSync(dist) ? { dist } : null
}

const entry = agentEntry('index')
let child
if (entry?.src) {
  // Dev mode: run via tsx
  child = spawn(tsxPath, [entry.src, mode, ...args], {
    stdio: 'inherit',
    cwd: join(__dirname, '..'),
    env: process.env,
  })
} else if (entry?.dist) {
  // Production: run compiled JS directly.
  // HEAP-OOM CRASH FIX (0.9.261): long heavy sessions (big context + many
  // sub-agents) grew the MAIN process past its default V8 old-space limit
  // (~2GB), and a barge-in interrupt tipped it over → "FATAL ERROR: Reached
  // heap limit" → process crash → Fly restart → session lost. Observed 3x in
  // one day, always `🔇 Speech interrupted` → heap OOM. Give the main process a
  // heap limit scaled to the machine's RAM (~half), so it has real headroom and
  // AUTO-SCALES if the machine's memory is bumped. Passed as a node ARGV flag —
  // NOT NODE_OPTIONS — so it applies ONLY to the main process and is NOT
  // inherited by the Claude SDK sub-agent subprocesses (which would multiply
  // memory use and cause a system OOM instead).
  const heapMB = Math.max(3072, Math.floor((os.totalmem() / (1024 * 1024)) * 0.5))
  console.log(`[cli] main agent --max-old-space-size=${heapMB}MB (machine RAM ${Math.round(os.totalmem() / (1024 * 1024))}MB)`)
  child = spawn('node', [`--max-old-space-size=${heapMB}`, entry.dist, mode, ...args], {
    stdio: 'inherit',
    cwd: join(__dirname, '..'),
    env: process.env,
  })
} else {
  console.error('Error: Neither src/index.ts nor dist/index.js found')
  process.exit(1)
}

/**
 * The agent died without filing its open follow-through items (heap-OOM abort, kill,
 * crash; #378): file the last foreground session's items from a detached worker.
 * A stop signal reaches the agent, which files them itself and exits 0. Resolves once
 * the worker has spawned (or failed, or 2s passed); never throws.
 */
function spawnLoopsFlush() {
  return new Promise((resolve) => {
    const worker = agentEntry('content/loops-flush-worker')
    let w
    try {
      if (worker?.src) w = spawn(tsxPath, [worker.src, '--last'], { detached: true, stdio: 'ignore', env: process.env })
      else if (worker?.dist) w = spawn('node', [worker.dist, '--last'], { detached: true, stdio: 'ignore', env: process.env })
      else return resolve(false)
    } catch { return resolve(false) }
    const timer = setTimeout(() => resolve(false), 2000)
    w.once('spawn', () => { clearTimeout(timer); w.unref(); resolve(true) })
    w.once('error', () => { clearTimeout(timer); resolve(false) })
  })
}

superviseChild(child, { name: 'agent', onAbnormalExit: spawnLoopsFlush })
