/**
 * harness-deploy-check.ts
 *
 * The browser-screen-recorder twin of image-build-check.ts — same orchestrator
 * pattern, no GitHub Actions:
 *
 *   1. Version source: the served skill file (public/browser-screen-recorder-
 *      skill.md, copied from tests/voice-e2e/SKILL.served.md at build) — the
 *      single source of truth a git push already updates.
 *   2. Staleness check: does the Fly registry for the engine app have tag
 *      v<version>? One HTTP call; exists → nothing to do.
 *   3. Build context: the deployed frontend has NO tests/voice-e2e/ (pruned),
 *      but it ships the harness BUNDLE — so we materialize the build context
 *      from public/browser-screen-recorder-bundle.json into a temp dir. The
 *      artifact we serve to installers is also our own build context.
 *   4. `fly deploy --remote-only --image-label v<version>` from the temp dir —
 *      builds the image AND rolls the single engine machine.
 *
 * Invoked from instrumentation.ts fire-and-forget on startup + 15-min cadence
 * (same reasoning as the sandbox check: a push after the last Railway boot
 * still gets its deploy within 15 min).
 *
 * Never throws. Requires FLY_API_TOKEN; app defaults to osborn-voice-e2e
 * (override FLY_HARNESS_APP; set it empty to disable).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'fs'
import { execSync, spawn, spawnSync } from 'child_process'
import { homedir, tmpdir } from 'os'
import { join, dirname } from 'path'

const FLY_REGISTRY = 'https://registry.fly.io'
const FLYCTL_INSTALL_URL = 'https://fly.io/install.sh'

function log(...args: unknown[]): void {
  console.log('[harness-deploy-check]', ...args)
}

// Observable heartbeat — the check writes its status here; the
// /api/browser-screen-recorder/deploy-status route serves it. Born from a
// real incident: Railway silently stopped deploying and the only way to know
// whether this check ever ran was inference from the outside.
const STATUS_FILE = join(tmpdir(), 'bsr-deploy-check.json')
function writeStatus(result: string): void {
  try { writeFileSync(STATUS_FILE, JSON.stringify({ lastRunAt: new Date().toISOString(), result })) } catch { /* ignore */ }
}

// Event-loop-safe spawn (spawnSync here would block Railway's healthcheck —
// see the incident note in image-build-check.ts).
function spawnAsync(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : null
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ status: code, stdout, stderr }) })
    child.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ status: null, stdout, stderr: stderr + '\n' + (err as Error).message }) })
  })
}

function resolveFlyBin(): string {
  for (const p of ['/root/.fly/bin/flyctl', '/root/.fly/bin/fly', join(homedir(), '.fly', 'bin', 'flyctl'), join(homedir(), '.fly', 'bin', 'fly')]) {
    if (existsSync(p)) return p
  }
  return 'fly'
}

function buildEnvWithFlyPath(): NodeJS.ProcessEnv {
  const flyBin = join(homedir(), '.fly', 'bin')
  return { ...process.env, PATH: `${flyBin}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}` }
}

function ensureFlyctl(): void {
  const existing = resolveFlyBin()
  if (existing !== 'fly' && existsSync(existing)) return
  try {
    if (spawnSync('fly', ['version'], { encoding: 'utf8', timeout: 5000 }).status === 0) return
  } catch { /* not in PATH */ }
  log('flyctl not found — installing...')
  execSync(`curl -L ${FLYCTL_INSTALL_URL} | sh`, { stdio: 'pipe', env: buildEnvWithFlyPath(), timeout: 120000 })
}

function findPublicDir(): string | null {
  for (const c of [join(process.cwd(), 'public'), join(process.cwd(), 'frontend', 'public')]) {
    if (existsSync(join(c, 'browser-screen-recorder-skill.md'))) return c
  }
  return null
}

async function imageTagExists(tag: string, token: string, app: string): Promise<boolean> {
  const credentials = Buffer.from(`x:${token}`).toString('base64')
  const res = await fetch(`${FLY_REGISTRY}/v2/${app}/tags/list`, {
    headers: { Authorization: `Basic ${credentials}` },
    signal: AbortSignal.timeout(15000),
  })
  if (res.status === 404) return false // repo has no images yet
  if (!res.ok) throw new Error(`Fly registry HTTP ${res.status} listing tags for ${app}`)
  const data = await res.json() as { tags?: unknown[] }
  const tags = Array.isArray(data.tags) ? data.tags as string[] : []
  return tags.includes(tag)
}

export async function checkHarnessDeploy(): Promise<void> {
  try {
    const FLY_API_TOKEN = process.env.FLY_API_TOKEN?.trim()
    const APP = (process.env.FLY_HARNESS_APP ?? 'osborn-voice-e2e').trim()
    if (!FLY_API_TOKEN) { log('FLY_API_TOKEN not set — skipping'); writeStatus('skipped: no FLY_API_TOKEN'); return }
    if (!APP) { log('FLY_HARNESS_APP empty — disabled'); writeStatus('disabled'); return }

    const publicDir = findPublicDir()
    if (!publicDir) { log('skill file not found in public/ — skipping'); writeStatus('skipped: no skill file'); return }

    // 1. Version from the served skill (single source of truth).
    const skill = readFileSync(join(publicDir, 'browser-screen-recorder-skill.md'), 'utf8')
    const version = skill.match(/^Version: (\d+)$/m)?.[1]
    if (!version) { log('no Version: line in served skill — skipping'); return }
    const tag = `v${version}`

    // 2. Registry staleness check.
    if (await imageTagExists(tag, FLY_API_TOKEN, APP)) {
      log(`image ${APP}:${tag} exists — engine current`)
      writeStatus(`current: ${tag} already in registry`)
      return
    }
    log(`image ${APP}:${tag} missing — deploying engine from the bundle`)

    // 3. Materialize the build context from the bundle.
    const bundle = JSON.parse(readFileSync(join(publicDir, 'browser-screen-recorder-bundle.json'), 'utf8')) as { version: number; files: Record<string, string> }
    const ctx = mkdtempSync(join(tmpdir(), 'bsr-deploy-'))
    for (const [rel, content] of Object.entries(bundle.files)) {
      const p = join(ctx, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content)
    }
    log(`materialized bundle v${bundle.version}: ${Object.keys(bundle.files).length} files → ${ctx}`)

    // 4. Remote build + roll the machine.
    ensureFlyctl()
    const flyBin = resolveFlyBin()
    const args = ['deploy', '--remote-only', '--image-label', tag, '--app', APP, '--config', join(ctx, 'fly.toml')]
    log(`Running: ${flyBin} ${args.join(' ')}`)
    const result = await spawnAsync(flyBin, args, { cwd: ctx, env: buildEnvWithFlyPath(), timeoutMs: 900000 })
    if (result.stdout) console.log('[harness fly deploy stdout]\n' + result.stdout.slice(-2000))
    if (result.stderr) console.log('[harness fly deploy stderr]\n' + result.stderr.slice(-2000))
    if (result.status !== 0) throw new Error(`fly deploy exited ${result.status}`)
    log(`engine deployed at ${tag}`)
    writeStatus(`deployed: ${tag}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[harness-deploy-check] ERROR: ${msg}`)
    writeStatus(`error: ${msg.slice(0, 200)}`)
  }
}
