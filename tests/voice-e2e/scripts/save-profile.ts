/**
 * One-time profile capture (Playwright storageState pattern — the industry
 * standard for "test credentials without sharing the real account"):
 *
 *   npx tsx scripts/save-profile.ts
 *
 * Opens a headed Chrome at the app's landing page. YOU log in once (Google
 * OAuth, the real account). When the dashboard appears, the script saves the
 * SESSION (cookies + localStorage) to profiles/osbornojure/state.json —
 * NOT the Gmail credentials. Tester agents then start already-authenticated:
 *
 *   const context = await browser.newContext({ storageState: 'profiles/osbornojure/state.json' })
 *
 * They can see the dashboard, click around, resume sessions — everything the
 * user sees — with zero access to the underlying Google account. Refresh by
 * re-running this script when the session expires. profiles/ is gitignored.
 */
import { chromium } from '@playwright/test'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_URL = process.env.OSBORN_APP_URL || 'https://www.voice-native.com'
const OUT = join(__dirname, '..', 'profiles', 'osbornojure', 'state.json')

const browser = await chromium.launch({ channel: 'chrome', headless: false })
const context = await browser.newContext()
const page = await context.newPage()
await page.goto(APP_URL)
console.log('➡️  Log in in the opened window (Google OAuth). Waiting for the dashboard…')
await page.waitForURL(/dashboard/, { timeout: 300_000 })
await page.waitForTimeout(3_000) // let tokens settle into storage
mkdirSync(dirname(OUT), { recursive: true })
await context.storageState({ path: OUT })
console.log(`✅ Session saved to ${OUT} — tester agents can now start logged in.`)
await browser.close()
