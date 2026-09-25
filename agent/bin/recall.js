#!/usr/bin/env node

// osborn-recall — thin shim. Runs src/recall-cli.ts via tsx in dev, or the
// compiled dist/recall-cli.js after `npm install`. Mirrors bin/cli.js.

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, lstatSync, symlinkSync } from 'fs'
import os from 'os'

// Same /workspace/.claude symlink guard as cli.js so stores resolve on Fly machines.
try {
  const home = os.homedir()
  const target = '/workspace/.claude'
  const link = join(home, '.claude')
  if (existsSync(target) && home !== '/workspace') {
    let needsLink = true
    try { needsLink = !lstatSync(link).isSymbolicLink() } catch {}
    if (needsLink) symlinkSync(target, link)
  }
} catch {}

const __dirname = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

const srcPath = join(__dirname, '..', 'src', 'recall-cli.ts')
const distPath = join(__dirname, '..', 'dist', 'recall-cli.js')

let child
if (existsSync(srcPath)) {
  const tsxPath = join(__dirname, '..', 'node_modules', '.bin', 'tsx')
  child = spawn(tsxPath, [srcPath, ...args], { stdio: 'inherit', cwd: join(__dirname, '..'), env: process.env })
} else if (existsSync(distPath)) {
  child = spawn('node', [distPath, ...args], { stdio: 'inherit', cwd: join(__dirname, '..'), env: process.env })
} else {
  console.error('Error: neither src/recall-cli.ts nor dist/recall-cli.js found')
  process.exit(1)
}

child.on('error', (err) => { console.error('Failed to start osborn-recall:', err.message); process.exit(1) })
child.on('exit', (code) => process.exit(code || 0))
