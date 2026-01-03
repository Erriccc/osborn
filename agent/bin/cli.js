#!/usr/bin/env node

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Pass all args to the actual agent
const args = process.argv.slice(2)

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

// Run the agent using tsx
const agentPath = join(__dirname, '..', 'src', 'index.ts')
const tsxPath = join(__dirname, '..', 'node_modules', '.bin', 'tsx')

// Determine mode (default to 'dev' if no mode specified)
let mode = 'dev'
if (args.includes('start')) {
  mode = 'start'
  args.splice(args.indexOf('start'), 1)
} else if (args.includes('dev')) {
  args.splice(args.indexOf('dev'), 1)
}

const child = spawn(tsxPath, [agentPath, mode, ...args], {
  stdio: 'inherit',
  cwd: join(__dirname, '..'),
  env: process.env,
})

child.on('error', (err) => {
  console.error('Failed to start agent:', err.message)
  process.exit(1)
})

child.on('exit', (code) => {
  process.exit(code || 0)
})
