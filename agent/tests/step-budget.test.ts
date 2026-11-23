// #458: the main agent's direct tool-call budget is 10 per turn, then it delegates.
// Run with `npx tsx agent/tests/step-budget.test.ts`.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDirectModeResearchPrompt } from '../src/prompts.js'

const prompt = getDirectModeResearchPrompt('/tmp/osb-ws')
assert.match(prompt, /Maximum 10 total tool calls per cycle/)
assert.match(prompt, /Never an 11th direct call/)
assert.doesNotMatch(prompt, /Maximum 3 total tool calls|Never a 4th direct call/)
// The spoken-progress nudge fires before the budget runs out.
const llm = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'claude-llm.ts'), 'utf8')
const cadence = Number(llm.match(/const SPEAK_CADENCE_N = (\d+)/)?.[1])
assert.ok(cadence > 0 && cadence < 10, `SPEAK_CADENCE_N ${cadence} must nudge before the 10-call budget`)
console.log('step-budget tests passed')
