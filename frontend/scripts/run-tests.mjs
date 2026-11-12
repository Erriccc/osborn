#!/usr/bin/env node
// Frontend test runner. The repo has no test framework: every file under
// frontend/tests/ is a standalone node:assert script run with tsx (see
// CONTRIBUTING.md). Nothing invoked them in CI, so 40+ suites of assertions
// were decorative. This walks tests/, runs each file in its own process, and
// exits non-zero if any file fails. A single file is still `npx tsx tests/<f>`
// (CONTRIBUTING.md), so this takes no arguments.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TESTS = join(FRONTEND, 'tests')
const TEST_FILE = /\.test\.(ts|tsx|mts|mjs|js)$/

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

const files = collect(TESTS)
if (!files.length) {
  console.error(`no test files under ${TESTS}`)
  process.exit(1)
}

const failed = []
for (const file of files) {
  const rel = relative(FRONTEND, file)
  // tsx handles .ts and .mjs alike; cwd is frontend/ so relative fixture paths resolve.
  const r = spawnSync('npx', ['--no-install', 'tsx', rel], { cwd: FRONTEND, stdio: 'inherit' })
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
