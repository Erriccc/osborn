/**
 * fly-dev-install.ts — put an unpublished agent build on one Fly machine.
 *
 *   cd frontend && npx tsx scripts/fly-dev-install.ts <fly-app> [git-ref=HEAD] --yes
 *
 * Packs agent/ at <git-ref> under the version the machine already runs (the
 * entrypoint reinstalls from npm when the volume version differs from the
 * image's), uploads it to Supabase Storage behind a short-lived signed URL and
 * installs it with installOsbornSpec. Rollback: the dashboard Update button or
 * the next release image (see agent/.claude/skills/deploy-workflow/SKILL.md).
 *
 * Env (frontend/.env.local): FLY_API_TOKEN, NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { installOsbornSpec, readInstalledOsbornVersion } from '../src/lib/machines'

const envFile = resolve(__dirname, '../.env.local')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const BUCKET = 'osborn-storage'
const SIGNED_URL_TTL_SEC = 15 * 60

function die(msg: string): never {
  console.error(`fly-dev-install: ${msg}`)
  process.exit(1)
}

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim()
const step = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const yes = args.includes('--yes')
  const [app, ref = 'HEAD'] = args.filter((a) => a !== '--yes')
  if (!app) die('usage: npx tsx scripts/fly-dev-install.ts <fly-app> [git-ref=HEAD] --yes')
  for (const k of ['FLY_API_TOKEN', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!process.env[k]) die(`${k} is not set`)
  }

  const repo = run('git', ['rev-parse', '--show-toplevel'], __dirname)
  const gitSha = run('git', ['rev-parse', '--verify', `${ref}^{commit}`], repo)
  const version = await readInstalledOsbornVersion(app)
  if (!version) die(`${app}: /health did not report a version (is the machine running?)`)

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
  const { data: row } = await sb.from('instances').select('user_id').eq('sandbox_id', app).maybeSingle()
  const userId = (row?.user_id as string | undefined) ?? ''
  const owner = userId ? (await sb.auth.admin.getUserById(userId)).data.user?.email ?? userId : '(no instances row)'

  console.log(`app:     ${app}\nowner:   ${owner}\nrunning: osborn@${version}\nbuild:   ${ref} @ ${gitSha} (packed as ${version})`)
  if (!yes) die('refusing without --yes')

  const tmp = mkdtempSync(join(tmpdir(), 'osborn-dev-'))
  const tree = join(tmp, 'tree')
  const objectPath = `dev-builds/${gitSha}.tgz`
  let uploaded = false
  try {
    step('git', ['worktree', 'add', '--detach', tree, gitSha], repo)
    const agent = join(tree, 'agent')
    step('npm', ['version', '--no-git-tag-version', '--allow-same-version', version], agent)
    step('npm', ['ci', '--no-audit', '--no-fund'], agent)
    step('npm', ['run', 'build'], agent)
    const tgzName = run('npm', ['pack', '--pack-destination', tmp], agent).split('\n').pop()!
    const tgz = readFileSync(join(tmp, tgzName))
    const sha256 = createHash('sha256').update(tgz).digest('hex')

    const up = await sb.storage.from(BUCKET).upload(objectPath, tgz, { contentType: 'application/gzip', upsert: true })
    if (up.error) throw new Error(`upload failed: ${up.error.message}`)
    uploaded = true
    const signed = await sb.storage.from(BUCKET).createSignedUrl(objectPath, SIGNED_URL_TTL_SEC)
    if (signed.error || !signed.data) throw new Error(`signed url failed: ${signed.error?.message}`)

    console.log(`installing ${tgzName} (sha256 ${sha256}) on ${app}...`)
    const result = await installOsbornSpec(app, { tarballUrl: signed.data.signedUrl, sha256, ref, gitSha }, userId, version)
    console.log(result.log)
    if (!result.success) process.exitCode = 1
  } finally {
    if (uploaded) {
      const { error } = await sb.storage.from(BUCKET).remove([objectPath])
      if (error) console.warn(`could not remove ${BUCKET}/${objectPath}: ${error.message}`)
    }
    try { step('git', ['worktree', 'remove', '--force', tree], repo) } catch { /* not created */ }
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((err) => die((err as Error).message))
