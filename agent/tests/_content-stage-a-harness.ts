// Shared harness for Stage A blind tests. NO implementation knowledge: only drives the entry point given by each
// test file's adapter block, through the stubbed fetch from _content-fixture.ts (no network, no spend).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { makeFixture, scriptPosts, DEV_LINE, type Fixture } from './_content-fixture.js'

export { DEV_LINE, scriptPosts }
export type { Fixture }

let pass = 0, fail = 0
export const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { fail++; console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n').slice(0, 4).join('\n      ')) }
}
export const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0) }

/** Rewrites dev-voice lines in every generated reply (chat/completions only) so tests can plant arbitrary dev lines. */
export const devOverride: { text: string | null } = { text: null }
export function wrapFetchForDevLine() {
  const inner = globalThis.fetch
  globalThis.fetch = (async (url: any, init?: any) => {
    const res: Response = await inner(url, init)
    if (devOverride.text === null || !String(url).includes('/chat/completions') || !res.ok) return res
    const raw = await res.text()
    try {
      const j = JSON.parse(raw)
      const c = j.choices?.[0]?.message?.content
      const o = JSON.parse(c)
      const fix = (n: any): void => {
        if (Array.isArray(n)) n.forEach(fix)
        else if (n && typeof n === 'object') {
          if ((n.speaker === 'dev' || n.voice === 'dev') && typeof n.text === 'string') n.text = devOverride.text
          Object.values(n).forEach(fix)
        }
      }
      fix(o)
      j.choices[0].message.content = JSON.stringify(o)
      return new Response(JSON.stringify(j), { status: 200 })
    } catch { return new Response(raw, { status: res.status }) }
  }) as typeof fetch
}

export interface Out { res: any; threw: unknown; logs: string[]; fx: Fixture }
export async function fresh(name: string, env: Record<string, string | undefined> = {}) {
  const fx = await makeFixture(name)
  fx.activate(env)
  wrapFetchForDevLine()
  devOverride.text = null
  return fx
}
export async function runOnce(entry: (...a: any[]) => any, fx: Fixture, extra: Record<string, unknown> = {}): Promise<Out> {
  const logs: string[] = []
  let res: any, threw: unknown = null
  try {
    res = await entry({ sessionId: fx.sessionId, projectDir: fx.projectDir, dbPath: fx.dbPath, libraryDir: fx.libraryDir, log: (m: string) => logs.push(String(m)), ...extra })
  } catch (e) { threw = e }
  return { res, threw, logs, fx }
}
export const statusOf = (r: any): string => String(r?.status ?? r?.state ?? '')
export const slugOf = (fx: Fixture) => basename(fx.projectDir)
export const allBodies = (fx: Fixture) => scriptPosts(fx.scenario).map(p => p.body).join('\n')
export const allTreeText = (dir: string): string => readdirSync(dir).map(e => {
  const p = join(dir, e)
  if (e === 'session.db' || e.startsWith('session.db-')) return ''
  return statSync(p).isDirectory() ? allTreeText(p) : readFileSync(p, 'utf8')
}).join('\n')
