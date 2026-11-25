// #458: the main agent's direct tool-call budget is 10 per turn, then it delegates.
// Run with `npx tsx agent/tests/step-budget.test.ts`.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAIN_DIRECT_CALL_CAP, SPEAK_CADENCE_N, getSpeakCadenceNudge, getDirectModeResearchPrompt, getResearchSystemPrompt, getTurnShapeReminder } from '../src/prompts.js'

assert.equal(MAIN_DIRECT_CALL_CAP, 10)
const prompt = getDirectModeResearchPrompt('/tmp/osb-ws')
const research = getResearchSystemPrompt('/tmp/osb-ws')
const reminder = getTurnShapeReminder()
// Pipeline/direct read direct-mode-research.md, realtime getResearchSystemPrompt: both carry the one
// budget + rubric block (prompts/main-agent-budget.md) once, with the numbers filled in.
for (const p of [prompt, research]) {
  assert.match(p, new RegExp(`At most ${MAIN_DIRECT_CALL_CAP} direct tool calls per turn`))
  assert.equal(p.split('DELEGATION RUBRIC (conditions').length, 2, 'rubric appears once')
  assert.doesNotMatch(p, /\{\{\w+\}\}/)
}
assert.doesNotMatch(prompt, /Never an 11th direct call|NO speech yet/)
assert.doesNotMatch(prompt, /Maximum 3 total tool calls|Never a 4th direct call/)
assert.doesNotMatch(research, /3\+ tool calls/)
// The spoken-progress nudge fires before the budget runs out.
const llm = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'claude-llm.ts'), 'utf8')
const cadence = SPEAK_CADENCE_N
assert.ok(cadence > 0 && cadence < MAIN_DIRECT_CALL_CAP, `SPEAK_CADENCE_N ${cadence} must nudge before the ${MAIN_DIRECT_CALL_CAP}-call ceiling`)
assert.match(llm, /SPEAK_CADENCE_N[^\n]*from '\.\/prompts\.js'/)
// Nothing the agent sees every turn still describes the old 3-call cycle.
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'prompts')
assert.doesNotMatch(prompt, /your 3rd tool call/)
assert.doesNotMatch(reminder, /Call 3 max|\{\{\w+\}\}/)
assert.match(reminder, new RegExp(`at most ${MAIN_DIRECT_CALL_CAP} direct tool calls per turn`, "i"))
for (const a of ['researcher', 'reasoner', 'planner', 'writer', 'tester', 'steward', 'reviewer']) assert.ok(reminder.includes(`'${a}'`), `reminder names ${a}`)
assert.doesNotMatch(reminder, /At most 3 delegations/)
for (const p of [prompt, research]) assert.match(p, /at most 3 background delegations running at once; the writer chain keeps its own order \(writer with its tester/)
const fallback = getDirectModeResearchPrompt(null)
assert.equal(fallback.split('DELEGATION RUBRIC (conditions').length, 2, 'fallback has the rubric once')
assert.doesNotMatch(fallback, /\{\{\w+\}\}/)
assert.doesNotMatch(reminder, /before ANY speech|at least ONE co-direction question/)
assert.match(readFileSync(join(dir, 'points-checklist.md'), 'utf8'), /only when its answer changes what you do/)
// Every main-agent layer asks for spoken progress at the same rhythm the code nudges at.
for (const p of [prompt, research, reminder]) {
  assert.match(p, new RegExp(`every ${cadence} calls`), 'prompt cadence matches SPEAK_CADENCE_N')
}
// The packaged meetings skill no longer claims a 3-call budget.
const meetings = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'skills', 'meetings', 'SKILL.md'), 'utf8')
assert.doesNotMatch(meetings, /3-call|3 direct tool calls/)
// No result/status narration: every layer speaks a result only for what it changes, never status.
for (const p of [prompt, research]) assert.match(p, /Never speak status/)
assert.doesNotMatch(prompt, /still installing|You are NOT silent/i)
assert.match(reminder, /never announce that it came back/)
assert.doesNotMatch(reminder, /brief callouts/)
assert.match(readFileSync(join(dir, 'chain-after-researcher.md'), 'utf8'), /Run the gate silently/)
const nudge = getSpeakCadenceNudge(cadence)
assert.match(nudge, new RegExp(`run ${cadence} tool calls`))
assert.match(nudge, /If not, say nothing/)
assert.doesNotMatch(nudge, /\{\{\w+\}\}|what you're doing next/)
assert.match(llm, /getSpeakCadenceNudge\(turnToolCallCount\)/)
console.log('step-budget tests passed')
