/**
 * Static (source-text) regression checks — ported from /tmp/osborn-regression/static-checks.ts
 * so they survive reboots. All original checks kept; paths made repo-relative.
 *
 * Protects (0.9.253/0.9.254 contracts):
 *   1  perTaskStopAffordance declared in sdkOptions + present in SDK typings
 *   3  interrupt enrichment is truthful (sub-agents SURVIVED, no re-dispatch instruction,
 *      no dispatch marked 'failed' at interrupt time)
 *   4  fast-brain emergency_stop is interrupt-only (never abort)
 *   5  pushMessage priority stamping + deferred live-channel push behind #pendingInterrupt
 *   6  index.ts stop_dispatch truthfulness
 *
 * Run: npx tsx agent/tests/regression/static-checks.ts   (read-only — no HOME sandbox needed)
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const llmSrc = readFileSync(`${AGENT}/src/claude-llm.ts`, 'utf-8')
const directSrc = readFileSync(`${AGENT}/src/pipeline-direct-llm.ts`, 'utf-8')
const fbSrc = readFileSync(`${AGENT}/src/pipeline-fastbrain.ts`, 'utf-8')
const indexSrc = readFileSync(`${AGENT}/src/index.ts`, 'utf-8')
const sdkDts = readFileSync(`${AGENT}/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, 'utf-8')

let failures = 0
function check(id: string, cond: boolean, evidence: string) {
  if (cond) console.log(`PASS  ${id}: ${evidence}`)
  else { failures++; console.log(`FAIL  ${id}: ${evidence}`) }
}

/** Strip block comments and full-line // comments (conservative — keeps inline code intact). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !/^\s*\/\//.test(l))
    // also drop trailing comments that start with whitespace + // (not ://)
    .map(l => l.replace(/(^|[^:])\/\/(?!.*["'`]).*$/, '$1'))
    .join('\n')
}

/** Extract a balanced {...} object literal starting at the first `{` at/after idx. */
function balancedBlock(src: string, idx: number, open = '{', close = '}'): string {
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

// ───────────────────────── Item 1: flag declared ─────────────────────────
{
  const occurrences = llmSrc.split('enableFileCheckpointing').length - 1
  check('1a', occurrences >= 1, `enableFileCheckpointing occurrences in claude-llm.ts: ${occurrences}`)
  // The options object that sets enableFileCheckpointing must also set perTaskStopAffordance: true
  let allHaveFlag = true
  let pos = 0
  while (true) {
    const i = llmSrc.indexOf('enableFileCheckpointing', pos)
    if (i < 0) break
    pos = i + 1
    // walk back to the declaration opening: find the enclosing object literal.
    // Heuristic: scan backwards for `= {` of the options build (nearest preceding `: Options = {` or `= {`)
    const declIdx = llmSrc.lastIndexOf('= {', i)
    if (declIdx < 0) { allHaveFlag = false; break }
    let obj: string
    try { obj = balancedBlock(llmSrc, declIdx) } catch { allHaveFlag = false; break }
    if (!/perTaskStopAffordance:\s*true/.test(obj)) allHaveFlag = false
  }
  check('1b', allHaveFlag, 'every options object setting enableFileCheckpointing also sets perTaskStopAffordance: true')
  check('1c', /perTaskStopAffordance\?:\s*boolean/.test(sdkDts), 'SDK Options type actually declares perTaskStopAffordance (flag is not a silent unknown key)')
}

// ───────────────────────── Item 3: interrupt truthfulness ─────────────────────────
{
  const code = stripComments(directSrc)
  check('3a', !/SEVERED/i.test(code.replace(/re-?dispatch/gi, '')) || !/SEVERED/.test(code),
    `no "SEVERED" claim in emitted code (comments excluded): ${!/SEVERED/.test(code)}`)
  check('3b', /SURVIVED|survive/.test(code) && /report back/.test(code),
    'enrichment tells agent sub-agents SURVIVED and will report back')
  // Must not INSTRUCT re-dispatch. Acceptable: "Do NOT re-dispatch". Unacceptable: imperative re-dispatch.
  const redispatchLines = code.split('\n').filter(l => /re-?dispatch/i.test(l))
  const badRedispatch = redispatchLines.filter(l => !/\b(do not|don'?t|never|not)\b[^]*re-?dispatch/i.test(l))
  check('3c', badRedispatch.length === 0,
    badRedispatch.length === 0 ? 'every re-dispatch mention is a negation ("do NOT re-dispatch")' : `imperative re-dispatch lines: ${JSON.stringify(badRedispatch)}`)
  // Must not mark active dispatches failed at interrupt time: find the [INTERRUPTED] region
  const start = code.indexOf('[INTERRUPTED]')
  check('3d-pre', start >= 0, '[INTERRUPTED] template exists')
  const regionStart = Math.max(0, code.lastIndexOf('interruptQuery', start) - 2000)
  const region = code.slice(regionStart, start + 4000)
  check('3d', !/['"]failed['"]/.test(region) && !/markFailed|failDispatch|dispatchState:\s*['"]failed/.test(region),
    'no dispatch marked \'failed\' in the interrupt-enrichment region')
}

// ───────────────────────── Item 4: emergency_stop is interrupt-only ─────────────────────────
{
  const code = stripComments(fbSrc)
  const h = code.indexOf("'emergency_stop'", code.indexOf('executeTool') >= 0 ? code.indexOf('executeTool') : 0)
  // handler block: from the handler branch to the next `} else` / end — take 3000 chars after branch
  const branch = code.indexOf("name === 'emergency_stop'")
  check('4-pre', branch >= 0, 'emergency_stop handler branch exists')
  const handler = code.slice(branch, branch + 2500)
  check('4a', /agentControl\.interrupt\(\)/.test(handler), 'handler calls agentControl.interrupt()')
  check('4b', !/agentControl\.abort\s*\(/.test(handler), 'handler does NOT call agentControl.abort()')
  check('4c', !/agentControl\.abort\s*\(/.test(code), 'no agentControl.abort( anywhere in pipeline-fastbrain.ts code')
  // tool description: extract the emergency_stop tool definition block
  const defIdx = fbSrc.indexOf("name: 'emergency_stop'")
  const desc = fbSrc.slice(defIdx, fbSrc.indexOf('parameters', defIdx))
  check('4d', !/kill|restart/i.test(desc), `tool description makes no kill/restart claim`)
  check('4e', /keep running|survive|unaffected|background/i.test(desc), 'description says background sub-agents keep running')
}

// ───────────────────────── Item 5: pushMessage priority + defer (source-level) ─────────────────────────
{
  // Anchor on the METHOD DECLARATION, not a comment/call-site mention of pushMessage(.
  const pmDecl = llmSrc.search(/\n\s*pushMessage\(\s*\n\s*userText/)
  const pmIdx = pmDecl >= 0 ? pmDecl : llmSrc.indexOf('pushMessage(')
  const pm = llmSrc.slice(pmIdx, pmIdx + 4500)
  check('5a', /priority\?:\s*'now'\s*\|\s*'next'\s*\|\s*'later'/.test(pm),
    "pushMessage accepts optional { priority?: 'now'|'next'|'later' }")
  check('5b', /\.\.\.\(\s*pushOpts\?\.priority\s*&&\s*\{\s*priority:\s*pushOpts\.priority\s*\}\s*\)/.test(pm)
      || /pushOpts\?\.priority\s*&&\s*\{\s*priority/.test(pm),
    'priority is stamped onto the SDKUserMessage only when provided (conditional spread)')
  check('5c', /priority\?:\s*'now'\s*\|\s*'next'\s*\|\s*'later'/.test(sdkDts),
    'SDK SDKUserMessage/types actually declare priority now|next|later')
  // defer path: live-channel branch must consult #pendingInterrupt and push AFTER it settles
  const live = pm.slice(pm.indexOf('#persistentQuery && this.#messageChannel'))
  const pendIdx = live.indexOf('#pendingInterrupt')
  // Accept both the plain defer (pending.then) and the deadline-guarded form
  // (Promise.race([pending, deadline]).then) — both order the push after the interrupt.
  const thenPush = /if\s*\(pending\)\s*\{[\s\S]*?(pending\.then|Promise\.race\(\[pending[\s\S]*?\]\)\.then)\(\(\)\s*=>\s*\{[\s\S]*?\.push\(userMessage\)/.test(live)
  check('5d', pendIdx >= 0 && thenPush, 'live-channel push is deferred via #pendingInterrupt.then(...) when an interrupt is in flight')
  // no unconditional push BEFORE the pending check inside the live branch
  const firstPush = live.indexOf('.push(userMessage)')
  check('5e', pendIdx >= 0 && pendIdx < firstPush, 'the pending-interrupt check precedes any channel push in the live branch')
  // interruptQuery must set and clear #pendingInterrupt
  const iq = llmSrc.slice(llmSrc.indexOf('async interruptQuery'), llmSrc.indexOf('async interruptQuery') + 2500)
  check('5f', /#pendingInterrupt\s*=\s*tracked|#pendingInterrupt\s*=/.test(iq) && /finally/.test(iq),
    'interruptQuery exposes the in-flight interrupt on #pendingInterrupt and clears it on settle (finally)')
}

// ───────────────────────── Item 6 (partial): stop_dispatch call site ─────────────────────────
{
  const i = indexSrc.indexOf("'stop_dispatch'")
  check('6-pre', i >= 0, 'stop_dispatch handler exists in index.ts')
  const block = indexSrc.slice(i, i + 1200)
  check('6a', /await\s+currentLLM\.stopAgent/.test(block), 'stop_dispatch awaits stopAgent')
  check('6b', /agent_stopped/.test(block) && /stopped\s*[,}]|stopped:\s*stopped|,\s*stopped\s*\}/.test(block),
    'agent_stopped frontend message carries the truthful stopped boolean')
  check('6c', !/stopped\s*=\s*true(?![\s\S]{0,80}stopAgent)/.test(block), 'stopped is not hardcoded true')
}

console.log(failures === 0 ? '\nALL STATIC CHECKS PASSED' : `\n${failures} STATIC CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
