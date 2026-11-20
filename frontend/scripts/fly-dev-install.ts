/**
 * fly-dev-install.ts — put an unpublished agent build on one Fly machine.
 *
 *   cd frontend && npx tsx scripts/fly-dev-install.ts <fly-app> [git-ref=HEAD] --yes
 *
 * Packs agent/ at <git-ref> under the version the machine's image carries (the
 * entrypoint reinstalls from npm when the volume version differs from the
 * image's), sends the tarball over Fly exec and installs it with
 * installOsbornSpec. Do not press Update on the dashboard while it runs.
 * Rollback: see agent/.claude/skills/deploy-workflow/SKILL.md.
 *
 * Env (frontend/.env.local): FLY_API_TOKEN. With NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY it also prints the machine's owner.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { installOsbornSpec, readImageOsbornVersion, readInstalledOsbornVersion } from '../src/lib/machines'
import { serviceClient } from '../src/lib/sandbox-claims'

const envFile = resolve(__dirname, '../.env.local')
if (existsSync(envFile)) process.loadEnvFile(envFile)

function die(msg: string): never {
  console.error(`fly-dev-install: ${msg}`)
  process.exit(1)
}

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim()
const step = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })

async function ownerOf(app: string): Promise<{ userId: string; owner: string }> {
  const sb = serviceClient()
  if (!sb) return { userId: '', owner: 'owner unknown' }
  const { data: row } = await sb.from('instances').select('user_id').eq('sandbox_id', app).maybeSingle()
  const userId = (row?.user_id as string | undefined) ?? ''
  if (!userId) return { userId, owner: '(no instances row)' }
  return { userId, owner: (await sb.auth.admin.getUserById(userId)).data.user?.email ?? userId }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const yes = args.includes('--yes')
  const [app, ref = 'HEAD'] = args.filter((a) => a !== '--yes')
  if (!app) die('usage: npx tsx scripts/fly-dev-install.ts <fly-app> [git-ref=HEAD] --yes')
  if (!process.env.FLY_API_TOKEN) die('FLY_API_TOKEN is not set')

  const repo = run('git', ['rev-parse', '--show-toplevel'], __dirname)
  const gitSha = run('git', ['rev-parse', '--verify', `${ref}^{commit}`], repo)
  const version = await readInstalledOsbornVersion(app)
  if (!version) die(`${app}: /health did not report a version (is the machine running?)`)
  const imageVersion = await readImageOsbornVersion(app)
  if (imageVersion !== version) {
    die(`${app}: /health reports v${version} but the image carries v${imageVersion ?? 'unknown'}; update the machine first`)
  }
  const { userId, owner } = await ownerOf(app)

  console.log(`app:     ${app}\nowner:   ${owner}\nrunning: osborn@${version}\nbuild:   ${ref} @ ${gitSha} (packed as ${version})`)
  if (!yes) die('refusing without --yes')

  const tmp = mkdtempSync(join(tmpdir(), 'osborn-dev-'))
  const tree = join(tmp, 'tree')
  const cleanup = () => {
    try { execFileSync('git', ['worktree', 'remove', '--force', tree], { cwd: repo, stdio: 'ignore' }) } catch { /* not created */ }
    rmSync(tmp, { recursive: true, force: true })
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => { cleanup(); process.exit(130) })
  }
  try {
    step('git', ['worktree', 'add', '--detach', tree, gitSha], repo)
    const agent = join(tree, 'agent')
    step('npm', ['version', '--no-git-tag-version', '--allow-same-version', version], agent)
    step('npm', ['ci', '--no-audit', '--no-fund'], agent)
    step('npm', ['run', 'build'], agent)
    const tgzName = run('npm', ['pack', '--pack-destination', tmp], agent).split('\n').pop()!
    const tarball = readFileSync(join(tmp, tgzName))
    const sha256 = createHash('sha256').update(tarball).digest('hex')

    console.log(`installing ${tgzName} (${tarball.length} bytes, sha256 ${sha256}) on ${app}...`)
    const result = await installOsbornSpec(app, { tarball, sha256 }, userId, version)
    console.log(result.log)
    if (!result.success) process.exitCode = 1
  } finally {
    cleanup()
  }
}

main().catch((err) => die((err as Error).message))
