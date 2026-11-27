#!/usr/bin/env node
// Screenshot one page of a running frontend at desktop (1280) and phone (390) widths.
//
//   node scripts/ui-shots.mjs <path> <out-dir> [name]
//   e.g. node scripts/ui-shots.mjs /dev/fixtures/store scratch/shots store
//   -> scratch/shots/store-1280.png, scratch/shots/store-390.png
//
// It starts nothing. Start the frontend first with placeholder Supabase
// values (not secrets; pages that need a real login or a real machine will
// not render data, use a /dev/fixtures/ page for those). NODE_ENV=development
// because next dev returns 500 when NODE_ENV=production is inherited. nohup
// and the log file keep the shell from hanging on an open pipe; wait until it
// answers:
//
//   cd frontend && npm ci && mkdir -p ../scratch
//   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key \
//   NODE_ENV=development nohup npx next dev -p 3000 > ../scratch/next-dev.log 2>&1 &
//   for i in $(seq 60); do curl -sf localhost:3000 > /dev/null && break; sleep 1; done
//
// Base URL defaults to http://localhost:3000 (override with UI_SHOTS_BASE).
// Playwright comes from tests/voice-e2e (its existing @playwright/test
// dependency); install it and Chromium with the commands in the "Install
// Playwright Chromium" step of .github/workflows/issue-agent.yml.
//
// Set UI_SHOTS_CHANNEL=chrome to use an installed Google Chrome instead.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const [path, outDir, name = 'page'] = process.argv.slice(2)
if (!path || !outDir) {
  console.error('Usage: node scripts/ui-shots.mjs <path> <out-dir> [name]')
  process.exit(2)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'tests/voice-e2e/package.json'))
const { chromium } = require('@playwright/test')

const base = process.env.UI_SHOTS_BASE || 'http://localhost:3000'
const url = new URL(path, base).toString()
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch(process.env.UI_SHOTS_CHANNEL ? { channel: process.env.UI_SHOTS_CHANNEL } : {})
let failed = false
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 })
    // next dev compiles a page on first hit, so allow a slow first load.
    const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 })
    if (!res || !res.ok()) {
      console.error(`${url} returned ${res ? res.status() : 'no response'}`)
      failed = true
    }
    const file = join(outDir, `${name}-${width}.png`)
    await page.screenshot({ path: file, fullPage: true })
    console.log(file)
    await page.close()
  }
} finally {
  await browser.close()
}
process.exit(failed ? 1 : 0)
