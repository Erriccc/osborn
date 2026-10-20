/**
 * Shared helpers for the regression suites.
 *
 * check()        — PASS/FAIL line + failure counting (process exit handled by caller)
 * sandboxHome()  — point $HOME at a throwaway dir BEFORE importing modules that
 *                  write to $HOME at module load (claude-llm.ts writes
 *                  ~/.claude/settings.json the moment it is imported).
 * anchoredSlice()— method-scoped source slices so source-text assertions are
 *                  anchored to a declaration, not a whole-file substring grep.
 */
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REGRESSION_DIR = dirname(fileURLToPath(import.meta.url))
export const AGENT_DIR = resolve(REGRESSION_DIR, '..', '..')
export const REPO_DIR = resolve(AGENT_DIR, '..')

export function readSource(relFromRepo: string): string {
  return readFileSync(resolve(REPO_DIR, relFromRepo), 'utf-8')
}

let failures = 0
export function check(id: string, cond: boolean, evidence: string) {
  if (cond) console.log(`PASS  ${id}: ${evidence}`)
  else { failures++; console.log(`FAIL  ${id}: ${evidence}`) }
}

export function finish(suiteName: string): never {
  console.log(failures === 0
    ? `\nALL ${suiteName.toUpperCase()} CHECKS PASSED`
    : `\n${failures} ${suiteName.toUpperCase()} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * Redirect $HOME to a fresh temp dir. MUST be called before dynamically
 * importing src modules with module-load side effects. os.homedir() on POSIX
 * reads $HOME first, so this is enough. Returns the sandbox path.
 * No-op when the caller already runs under an osborn-regress sandbox (run-all.sh).
 */
export function sandboxHome(): string {
  const cur = process.env.HOME || ''
  if (cur.includes('osborn-regress')) return cur
  const dir = mkdtempSync(join(tmpdir(), 'osborn-regress-home-'))
  process.env.HOME = dir
  return dir
}

/** Strip block comments and //-comment lines (conservative — keeps inline code). */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !/^\s*\/\//.test(l))
    .map(l => l.replace(/(^|[^:])\/\/(?!.*["'`]).*$/, '$1'))
    .join('\n')
}

/** Extract a balanced {...} block starting at the first `{` at/after idx. */
export function balancedBlock(src: string, idx: number, open = '{', close = '}'): string {
  const start = src.indexOf(open, idx)
  if (start < 0) throw new Error('no opening brace')
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === open) depth++
    else if (c === close) { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced')
}

/**
 * Method/branch-scoped slice: find `startAnchor` (unique declaration text or
 * regex), return `len` chars from there — or up to `endAnchor` when given.
 * Throws when the anchor is missing so a renamed anchor fails LOUDLY instead
 * of silently passing on an empty slice.
 */
export function anchoredSlice(
  src: string,
  startAnchor: string | RegExp,
  opts?: { len?: number; endAnchor?: string },
): string {
  const idx = typeof startAnchor === 'string' ? src.indexOf(startAnchor) : src.search(startAnchor)
  if (idx < 0) throw new Error(`anchor not found: ${startAnchor}`)
  if (opts?.endAnchor) {
    const end = src.indexOf(opts.endAnchor, idx)
    if (end < 0) throw new Error(`end anchor not found: ${opts.endAnchor}`)
    return src.slice(idx, end + opts.endAnchor.length)
  }
  return src.slice(idx, idx + (opts?.len ?? 2000))
}

/** Capture console.log output during fn (e.g. stopAgent logs the resolved taskId). */
export async function captureLogs(fn: () => Promise<unknown> | unknown):
  Promise<{ logs: string[]; result: unknown; threw: unknown }> {
  const logs: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
  let result: unknown, threw: unknown = null
  try { result = await fn() } catch (e) { threw = e } finally { console.log = orig }
  return { logs, result, threw }
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
