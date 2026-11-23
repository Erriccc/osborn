// #458: the main agent's direct tool-call budget is 10 per turn, then it delegates.
// Run with `npx tsx agent/tests/step-budget.test.ts`.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDirectModeResearchPrompt, getResearchSystemPrompt } from '../src/prompts.js'

const prompt = getDirectModeResearchPrompt('/tmp/osb-ws')
assert.match(prompt, /Maximum 10 total tool calls per cycle/)
assert.match(prompt, /Never an 11th direct call/)
assert.doesNotMatch(prompt, /Maximum 3 total tool calls|Never a 4th direct call/)
// Pipeline (the default) and realtime use the research system prompt: same budget.
const research = getResearchSystemPrompt('/tmp/osb-ws')
assert.match(research, /Maximum 10 direct tool calls per turn/)
assert.doesNotMatch(research, /3\+ tool calls/)
// The spoken-progress nudge fires before the budget runs out.
const llm = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'claude-llm.ts'), 'utf8')
const cadence = Number(llm.match(/const SPEAK_CADENCE_N = (\d+)/)?.[1])
assert.ok(cadence > 0 && cadence < 10, `SPEAK_CADENCE_N ${cadence} must nudge before the 10-call budget`)
// Nothing the agent sees every turn still describes the old 3-call cycle.
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'prompts')
assert.doesNotMatch(prompt, /your 3rd tool call/)
const reminder = readFileSync(join(dir, 'turn-shape-reminder.md'), 'utf8')
assert.doesNotMatch(reminder, /Call 3 max/)
assert.match(reminder, /at most 10 direct tool calls per turn/)
// Both main-agent prompts ask for spoken progress at the same rhythm the code nudges at.
for (const p of [prompt, research]) {
  assert.match(p, new RegExp(`every ${cadence} calls`), 'prompt cadence matches SPEAK_CADENCE_N')
}
// The packaged meetings skill no longer claims a 3-call budget.
const meetings = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'skills', 'meetings', 'SKILL.md'), 'utf8')
assert.doesNotMatch(meetings, /3-call|3 direct tool calls/)
console.log('step-budget tests passed')
