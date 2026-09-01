#!/usr/bin/env node

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, existsSync, lstatSync, symlinkSync } from 'fs'
import os from 'os'

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

// Use src/index.ts (dev) if available, otherwise dist/index.js (npm install)
const srcPath = join(__dirname, '..', 'src', 'index.ts')
const distPath = join(__dirname, '..', 'dist', 'index.js')

let child
if (existsSync(srcPath)) {
  // Dev mode: run via tsx
  const tsxPath = join(__dirname, '..', 'node_modules', '.bin', 'tsx')
  child = spawn(tsxPath, [srcPath, mode, ...args], {
    stdio: 'inherit',
    cwd: join(__dirname, '..'),
    env: process.env,
  })
} else if (existsSync(distPath)) {
  // Production: run compiled JS directly
  child = spawn('node', [distPath, mode, ...args], {
    stdio: 'inherit',
    cwd: join(__dirname, '..'),
    env: process.env,
  })
} else {
  console.error('Error: Neither src/index.ts nor dist/index.js found')
  process.exit(1)
}

child.on('error', (err) => {
  console.error('Failed to start agent:', err.message)
  process.exit(1)
})

child.on('exit', (code) => {
  process.exit(code || 0)
})
