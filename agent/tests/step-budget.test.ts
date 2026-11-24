// #458: the main agent's direct tool-call budget is 10 per turn, then it delegates.
// Run with `npx tsx agent/tests/step-budget.test.ts`.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAIN_DIRECT_CALL_CAP, SPEAK_CADENCE_N } from '../src/main-agent-limits.js'
import { getDirectModeResearchPrompt, getResearchSystemPrompt } from '../src/prompts.js'

const prompt = getDirectModeResearchPrompt('/tmp/osb-ws')
assert.match(prompt, new RegExp(`At most ${MAIN_DIRECT_CALL_CAP} direct tool calls per turn`))
assert.match(prompt, /DELEGATION RUBRIC/)
assert.doesNotMatch(prompt, /Never an 11th direct call|NO speech yet/)
assert.doesNotMatch(prompt, /Maximum 3 total tool calls|Never a 4th direct call/)
// Realtime uses getResearchSystemPrompt (pipeline uses direct-mode-research.md, checked above): same budget.
const research = getResearchSystemPrompt('/tmp/osb-ws')
assert.match(research, new RegExp(`Maximum ${MAIN_DIRECT_CALL_CAP} direct tool calls per turn`))
assert.doesNotMatch(research, /3\+ tool calls/)
// The spoken-progress nudge fires before the budget runs out.
const llm = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'claude-llm.ts'), 'utf8')
const cadence = SPEAK_CADENCE_N
assert.ok(cadence > 0 && cadence < MAIN_DIRECT_CALL_CAP, `SPEAK_CADENCE_N ${cadence} must nudge before the ${MAIN_DIRECT_CALL_CAP}-call ceiling`)
assert.match(llm, /from '\.\/main-agent-limits\.js'/)
// Nothing the agent sees every turn still describes the old 3-call cycle.
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'prompts')
assert.doesNotMatch(prompt, /your 3rd tool call/)
const reminder = readFileSync(join(dir, 'turn-shape-reminder.md'), 'utf8')
assert.doesNotMatch(reminder, /Call 3 max/)
assert.match(reminder, new RegExp(`at most ${MAIN_DIRECT_CALL_CAP} direct tool calls per turn`, "i"))
for (const a of ['researcher', 'reasoner', 'planner', 'writer', 'tester', 'steward', 'reviewer']) assert.ok(reminder.includes(`'${a}'`), `reminder names ${a}`)
assert.doesNotMatch(reminder, /At most 3 delegations/)
// One speaking rule and one question rule, said the same in every layer.
for (const [name, text] of [['direct-mode-research', prompt], ['turn-shape-reminder', reminder]] as const) {
  assert.match(text, /every 6 calls/, `${name}: speaking cadence`)
}
assert.doesNotMatch(reminder, /before ANY speech|at least ONE co-direction question/)
assert.match(readFileSync(join(dir, 'points-checklist.md'), 'utf8'), /only when its answer changes what you do/)
// Both main-agent prompts ask for spoken progress at the same rhythm the code nudges at.
for (const p of [prompt, research]) {
  assert.match(p, new RegExp(`every ${cadence} calls`), 'prompt cadence matches SPEAK_CADENCE_N')
}
// The packaged meetings skill no longer claims a 3-call budget.
const meetings = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'skills', 'meetings', 'SKILL.md'), 'utf8')
assert.doesNotMatch(meetings, /3-call|3 direct tool calls/)
console.log('step-budget tests passed')
