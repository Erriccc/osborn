/**
 * jsonl-sidecar.ts — append-only JSONL sidecars beside session.db
 * (compactions.jsonl, steward.jsonl, loops.jsonl).
 *
 * A crash can leave a torn final line with no trailing newline. Reads skip any
 * line that does not parse. Appends check the last byte first and start a fresh
 * line when it is not '\n', so the next good record never glues onto a torn one.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { dirname } from 'node:path'

function endsWithNewline(path: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    if (size === 0) return true
    const b = Buffer.alloc(1)
    readSync(fd, b, 0, 1, size - 1)
    return b[0] === 0x0a
  } catch {
    return true
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* ignore */ }
  }
}

/** Append one line (no trailing newline in `line`). Creates the directory. Throws on IO errors. */
export function appendJsonlLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const lead = existsSync(path) && !endsWithNewline(path) ? '\n' : ''
  appendFileSync(path, lead + line + '\n', 'utf-8')
}

/** Every line of `path` that parses as JSON, in file order. Missing file → []. Blank or torn lines are skipped. */
export function readJsonlLines(path: string): unknown[] {
  if (!existsSync(path)) return []
  let text: string
  try { text = readFileSync(path, 'utf-8') } catch { return [] }
  const out: unknown[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* torn or corrupt line */ }
  }
  return out
}
