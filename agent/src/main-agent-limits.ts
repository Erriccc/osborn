// Main (pipeline/direct) agent limits shared by the code and the prompts' wording.
// The direct-call cap is a ceiling stated in direct-mode-research.md, turn-shape-reminder.md and
// the realtime research prompt; step-budget.test.ts asserts they all say this number.
export const MAIN_DIRECT_CALL_CAP = 10
// Every N main-agent tool calls a non-blocking note asks for one spoken progress line.
export const SPEAK_CADENCE_N = 6
