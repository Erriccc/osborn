#!/usr/bin/env node
// Test runner. The repo has no test framework: every file under <package>/tests/
// is a standalone node:assert script run with tsx (see CONTRIBUTING.md). This
// walks tests/, runs each file in its own process, and exits non-zero if any
// file fails. With no arguments it runs frontend/ (`npm test`); agent CI runs
// `node ../frontend/scripts/run-tests.mjs . <name>...` from agent/, leaving out
// the named files (<name>.test.ts). A single file is still `npx tsx tests/<f>`.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [pkgArg, ...SKIP] = process.argv.slice(2)
const PKG = resolve(pkgArg ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const TESTS = join(PKG, 'tests')
const TEST_FILE = /\.test\.(ts|tsx|mts|mjs|js)$/
// Resolved once, so this spawns tsx itself instead of an npx bootstrap per file.
// tsx is intentionally absent from package.json (it would ship to production),
// so a fresh clone lands here and needs the install line from CONTRIBUTING.md.
const TSX = join(PKG, 'node_modules', '.bin', 'tsx')

/** Every test file under dir, recursively, sorted for a stable report order. */
function collect(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collect(full))
    else if (TEST_FILE.test(entry.name)) out.push(full)
  }
  return out.sort()
}

const files = collect(TESTS).filter((f) => {
  const skip = SKIP.includes(basename(f).replace(TEST_FILE, ''))
  if (skip) console.log(`SKIP  ${relative(PKG, f)}`)
  return !skip
})
if (!files.length) {
  console.error(`no test files under ${TESTS}`)
  process.exit(1)
}
if (!existsSync(TSX)) {
  console.error('tsx is not installed — see the test deps install line in CONTRIBUTING.md')
  process.exit(1)
}

const failed = []
for (const file of files) {
  const rel = relative(PKG, file)
  // tsx handles .ts and .mjs alike; cwd is the package so relative fixture paths resolve.
  const r = spawnSync(TSX, [rel], { cwd: PKG, stdio: 'inherit' })
  const code = r.status ?? 1
  if (code !== 0) failed.push({ rel, code, signal: r.signal })
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${rel}`)
}

console.log(`\n${files.length - failed.length}/${files.length} test files passed`)
if (failed.length) {
  console.error('\nFailed files:')
  for (const f of failed) console.error(`  ${f.rel}${f.signal ? ` (signal ${f.signal})` : ` (exit ${f.code})`}`)
  process.exit(1)
}
