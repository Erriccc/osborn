// /health `volumeSync`: the reader for the entrypoint's sync status file, and
// the entrypoint's sync block itself run against a temp volume with a fake npm
// and df. Run with `npx tsx agent/tests/volume-sync-status.test.ts`.
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readVolumeSyncStatus } from '../src/volume-sync-status.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'vol-sync-'))

// --- reader -------------------------------------------------------------------
{
  const tmpFile = join(root, 'tmp-status')
  const volFile = join(root, 'vol-status')
  assert.equal(readVolumeSyncStatus([tmpFile, volFile]), null, 'no file → null')

  writeFileSync(volFile, JSON.stringify({ ok: false, reason: 'disk_full', image: '0.9.295', volume: '0.9.290', freeMb: 12, needMb: 2048, at: '2026-11-20T00:00:00Z', extra: 'dropped' }))
  assert.deepEqual(readVolumeSyncStatus([tmpFile, volFile]), {
    ok: false, reason: 'disk_full', image: '0.9.295', volume: '0.9.290', freeMb: 12, needMb: 2048, detail: null, at: '2026-11-20T00:00:00Z',
  })

  // The /tmp copy is written only when the volume could not take it, so it wins.
  writeFileSync(tmpFile, JSON.stringify({ ok: true, reason: 'synced', freeMb: 'x', detail: 'y'.repeat(2000) }))
  const t = readVolumeSyncStatus([tmpFile, volFile])!
  assert.equal(t.reason, 'synced')
  assert.equal(t.freeMb, null, 'non-number freeMb is dropped')
  assert.equal(t.detail!.length, 600, 'detail is capped')

  writeFileSync(tmpFile, '{not json')
  assert.equal(readVolumeSyncStatus([tmpFile, volFile])!.reason, 'disk_full', 'a corrupt file falls through')
  writeFileSync(tmpFile, JSON.stringify({ reason: 'synced' }))
  assert.equal(readVolumeSyncStatus([tmpFile, volFile])!.reason, 'disk_full', 'a file without ok falls through')
}

// --- entrypoint sync block ------------------------------------------------------
const dockerfile = readFileSync(join(here, '..', 'Dockerfile.sandbox'), 'utf8')
const start = dockerfile.indexOf('# === Sync volume npm-global with image osborn version ===')
const end = dockerfile.indexOf('echo "[sandbox-d] exec\'ing osborn')
assert.ok(start > 0 && end > start, 'sync block found in Dockerfile.sandbox')
const block = dockerfile.slice(start, end)
assert.ok(!/\|\s*tail/.test(block.split('\n').filter((l) => /npm install/.test(l)).join('\n')), 'npm output is never piped (its exit status must count)')

const fakeNpm = `#!/bin/bash
echo called >> "$FAKE_ROOT/npm-calls"
prefix=""; spec=""
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift 2;; osborn@*) spec="$1"; shift;; *) shift;; esac; done
v="\${spec#osborn@}"
mkdir -p "$prefix/lib/node_modules/osborn/bin" "$prefix/bin"
case "$FAKE_NPM" in
  ok)
    printf '{"name":"osborn","version":"%s"}\\n' "$v" > "$prefix/lib/node_modules/osborn/package.json"
    echo '#!/bin/sh' > "$prefix/lib/node_modules/osborn/bin/cli.js"
    /bin/ln -sfn ../lib/node_modules/osborn/bin/cli.js "$prefix/bin/osborn"
    echo "added 440 packages"; exit 0;;
  enospc|tmp-enospc)
    echo partial > "$prefix/lib/node_modules/osborn/half"
    # The volume filled up (df now says 5 MB), or only /tmp did (df unchanged).
    if [ "$FAKE_NPM" = enospc ]; then echo 5 > "$FAKE_ROOT/free"; fi
    echo "npm error code ENOSPC"; echo "npm error syscall write"; echo "npm error nospc ENOSPC: no space left on device, write"
    echo "npm error A complete log of this run can be found in: /tmp/npm-cache/_logs/x-debug-0.log"; exit 228;;
  *)
    echo "npm error code E404"; echo "npm error 404 Not Found - osborn@$v"
    echo "npm error A complete log of this run can be found in: /tmp/npm-cache/_logs/x-debug-0.log"; exit 1;;
esac
`
const fakeDf = `#!/bin/bash
echo "Filesystem 1048576-blocks Used Available Capacity Mounted on"
FREE=$(cat "$FAKE_ROOT/free" 2>/dev/null || echo "$FAKE_FREE")
echo "/dev/vdb 30000 $((30000-FREE)) $FREE 99% /workspace"
`

interface Run { ws: string; out: string; status: Record<string, unknown> | null; tmpStatus: Record<string, unknown> | null; npmCalled: boolean; code: number }

function run(name: string, opts: { free: number; npm?: string; volVersion?: string | null; image?: string; prep?: (ws: string) => void; failLn?: boolean }): Run {
  const r = join(root, name)
  const ws = join(r, 'workspace')
  const tmp = join(r, 'tmp')
  const bin = join(r, 'bin')
  mkdirSync(join(ws, '.npm-global', 'bin'), { recursive: true })
  mkdirSync(tmp, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'npm'), fakeNpm); chmodSync(join(bin, 'npm'), 0o755)
  writeFileSync(join(bin, 'df'), fakeDf); chmodSync(join(bin, 'df'), 0o755)
  if (opts.failLn) { writeFileSync(join(bin, 'ln'), '#!/bin/sh\necho "ln: failed" >&2\nexit 1\n'); chmodSync(join(bin, 'ln'), 0o755) }
  const mods = join(ws, '.npm-global', 'lib', 'node_modules')
  if (opts.volVersion) {
    mkdirSync(join(mods, 'osborn', 'bin'), { recursive: true })
    writeFileSync(join(mods, 'osborn', 'package.json'), `{"name":"osborn","version":"${opts.volVersion}"}\n`)
    writeFileSync(join(mods, 'osborn', 'bin', 'cli.js'), 'old')
    symlinkSync('../lib/node_modules/osborn/bin/cli.js', join(ws, '.npm-global', 'bin', 'osborn'))
  }
  opts.prep?.(ws)
  const script = 'set -e\n' + block.replaceAll('/tmp/osborn-sync', `${tmp}/osborn-sync`).replaceAll('/workspace', ws)
  const p = spawnSync('bash', ['-c', script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_ROOT: r, FAKE_NPM: opts.npm ?? 'ok', FAKE_FREE: String(opts.free), IMAGE_SEED_VERSION: opts.image ?? '0.9.295' },
    encoding: 'utf8',
  })
  const readJson = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null)
  return {
    ws, out: p.stdout + p.stderr, code: p.status ?? -1,
    status: readJson(join(ws, '.osborn-sync-status')),
    tmpStatus: readJson(join(tmp, 'osborn-sync-status')),
    npmCalled: existsSync(join(r, 'npm-calls')),
  }
}
const volPkg = (ws: string) => readFileSync(join(ws, '.npm-global', 'lib', 'node_modules', 'osborn', 'package.json'), 'utf8')

{
  // The incident: a full volume. No npm run, the old copy untouched, the reason recorded.
  const r = run('disk-full', { free: 40, volVersion: '0.9.290' })
  assert.equal(r.code, 0, r.out)
  assert.equal(r.npmCalled, false)
  assert.match(volPkg(r.ws), /0\.9\.290/)
  assert.match(r.out, /SYNC SKIPPED: disk full/)
  assert.deepEqual({ ...r.status, at: undefined }, { ok: false, reason: 'disk_full', image: '0.9.295', volume: '0.9.290', freeMb: 40, needMb: 2048, at: undefined })
}
{
  // Enough room: staged install renamed in, bin linked, stage and .osborn-prev cleared.
  const r = run('synced', {
    free: 5000, volVersion: '0.9.290',
    prep: (ws) => mkdirSync(join(ws, '.npm-global', 'lib', 'node_modules', '.osborn-prev'), { recursive: true }),
  })
  assert.equal(r.code, 0, r.out)
  assert.match(volPkg(r.ws), /0\.9\.295/)
  assert.equal(readlinkSync(join(r.ws, '.npm-global', 'bin', 'osborn')), '../lib/node_modules/osborn/bin/cli.js')
  assert.ok(existsSync(join(r.ws, '.npm-global', 'bin', 'osborn')), 'bin link resolves')
  assert.ok(!existsSync(join(r.ws, '.osborn-sync-stage')))
  assert.ok(!existsSync(join(r.ws, '.npm-global', 'lib', 'node_modules', '.osborn-prev')))
  assert.ok(!existsSync(join(r.ws, '.npm-global', 'lib', 'node_modules', '.osborn-old')))
  assert.equal(r.status!.ok, true)
  assert.equal(r.status!.reason, 'synced')
}
{
  // npm runs out of space mid-install: the working copy is untouched, the stage removed.
  const r = run('enospc', { free: 3000, npm: 'enospc', volVersion: '0.9.290' })
  assert.equal(r.code, 0, r.out)
  assert.match(volPkg(r.ws), /0\.9\.290/)
  assert.equal(readFileSync(join(r.ws, '.npm-global', 'lib', 'node_modules', 'osborn', 'bin', 'cli.js'), 'utf8'), 'old')
  assert.ok(!existsSync(join(r.ws, '.osborn-sync-stage')))
  assert.equal(r.status!.ok, false)
  assert.equal(r.status!.reason, 'disk_full')
  assert.equal(r.status!.freeMb, 5, 'free space when the volume filled, not after the stage was removed')
  assert.match(String(r.status!.detail), /ENOSPC/)
  assert.doesNotMatch(String(r.status!.detail), /complete log of this run/)
}
{
  // ENOSPC with room left on the volume: the npm cache in /tmp filled, not the volume.
  const r = run('tmp-enospc', { free: 3000, npm: 'tmp-enospc', volVersion: '0.9.290' })
  assert.equal(r.code, 0, r.out)
  assert.match(volPkg(r.ws), /0\.9\.290/)
  assert.equal(r.status!.reason, 'npm_failed')
  assert.match(String(r.status!.detail), /ENOSPC/)
}
{
  const r = run('npm-failed', { free: 3000, npm: 'e404', volVersion: '0.9.290' })
  assert.equal(r.code, 0, r.out)
  assert.match(volPkg(r.ws), /0\.9\.290/)
  assert.equal(r.status!.reason, 'npm_failed')
  assert.match(String(r.status!.detail), /404/)
  assert.doesNotMatch(String(r.status!.detail), /complete log of this run/)
}
{
  // Leftover staging dirs from installOsbornSpec / the rollback override are cleared
  // before the free-space check, so they cannot read as a full disk.
  const r = run('leftovers', {
    free: 5000, volVersion: '0.9.290',
    prep: (ws) => {
      mkdirSync(join(ws, '.osborn-stage-abc123-x', 'lib'), { recursive: true })
      mkdirSync(join(ws, '.osborn-rollback-stage', 'lib'), { recursive: true })
    },
  })
  assert.ok(!existsSync(join(r.ws, '.osborn-stage-abc123-x')))
  assert.ok(!existsSync(join(r.ws, '.osborn-rollback-stage')))
  assert.equal(r.status!.reason, 'synced')
}
{
  // A bin link that cannot be made does not abort the boot; the status is still written.
  const r = run('bin-link-fails', {
    free: 5000, volVersion: '0.9.290',
    failLn: true,
  })
  assert.equal(r.code, 0, r.out)
  assert.equal(r.status!.reason, 'synced')
}
{
  // A rollback placeholder (or no copy) never matches the image, so it resyncs.
  const r = run('placeholder', { free: 5000, volVersion: '0.0.0-rollback' })
  assert.match(volPkg(r.ws), /0\.9\.295/)
  const none = run('missing', { free: 5000, volVersion: null })
  assert.match(volPkg(none.ws), /0\.9\.295/)
  assert.equal(none.status!.volume, 'none')
}
{
  const r = run('up-to-date', { free: 10, volVersion: '0.9.295' })
  assert.equal(r.npmCalled, false)
  assert.equal(r.status!.ok, true)
  assert.equal(r.status!.reason, 'up_to_date')
}
{
  // The volume cannot take even the status file: it lands in /tmp, and the boot goes on.
  const r = run('status-to-tmp', { free: 40, volVersion: '0.9.290', prep: (ws) => mkdirSync(join(ws, '.osborn-sync-status.tmp')) })
  assert.equal(r.code, 0, r.out)
  assert.equal(r.status, null)
  assert.equal(r.tmpStatus!.reason, 'disk_full')
}

rmSync(root, { recursive: true, force: true })
console.log('volume-sync-status: all assertions passed')
