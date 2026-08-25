/**
 * Claude LLM Wrapper for LiveKit Agents
 *
 * Wraps the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) to work
 * with LiveKit's AgentSession as an LLM provider.
 *
 * Flow: User speaks → STT → ClaudeLLM (Agent SDK) → TTS → User hears
 */

import { llm, shortuuid, DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from '@livekit/agents'
import { query, type Options, type McpServerConfig, type SDKMessage, type SDKUserMessage, type Query as SDKQuery } from '@anthropic-ai/claude-agent-sdk'
import { EventEmitter } from 'events'
import { saveSessionMetadata, getSessionWorkspace } from './config.js'
import { statusManager } from './status-manager.js'
import { getResearchSystemPrompt, getDirectModeResearchPrompt } from './prompts.js'
import { getIndexPath } from './summary-index.js'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

// Directory of this module — used to locate co-located prompt files (e.g., turn-shape reminder).
const __claudeLlmDir = dirname(fileURLToPath(import.meta.url))
const TURN_SHAPE_REMINDER_PATH = join(__claudeLlmDir, 'prompts', 'turn-shape-reminder.md')

// ≤3 direct tool call budget per turn. Reset on every UserPromptSubmit (new user message).
// Enforced mechanically in PreToolUse — the model CANNOT exceed this regardless of JSONL history.
// Task/Agent delegations are exempt (delegation is what we WANT). Sub-agent tool calls
// (agent_type !== null) are exempt (they're inside a delegation). Only the main orchestrator
// agent's direct tool calls count against the budget.
let turnToolCallCount = 0
const TOOL_CALL_BUDGET = 3

export interface ClaudeLLMOptions {
  workingDirectory?: string      // cwd for Claude Code (where it reads/writes/runs commands)
  sessionBaseDir?: string        // where .osborn/sessions/ lives (defaults to workingDirectory)
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
  allowedTools?: string[]
  eventEmitter?: EventEmitter
  resumeSessionId?: string
  continueSession?: boolean
  mcpServers?: Record<string, McpServerConfig>
  model?: string  // Claude model ID (default: claude-sonnet-4-6)
  voiceMode?: 'direct' | 'realtime'  // Which voice pipeline — controls system prompt selection
  skipTTSQueue?: boolean  // When true, emit 'tts_say' events instead of queue.put() — for session.say() bypass
  onCompactionEvent?: (event:
    | { type: 'compaction_started'; trigger?: string }
    | { type: 'compaction_progress'; stage: string; detail?: string }
    | { type: 'compaction_complete'; skillsWritten?: number; skillNames?: string[]; trigger?: string }
  ) => void
  // Per-user named agents (DB-backed, sent by the frontend via set_agents).
  // When set, used INSTEAD of the built-in NAMED_AGENTS at query creation.
  // SDK constraint: agents are fixed once query() starts — changes apply on
  // the next session (cold start / resume / switch), not mid-session.
  agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>
}

/**
 * Strip markdown formatting for TTS (text-to-speech)
 * Removes **bold**, ##headers, ```code```, etc. so TTS doesn't read them literally
 */
function stripMarkdownForTTS(text: string): string {
  return text
    // Remove code blocks (``` ... ```)
    .replace(/```[\s\S]*?```/g, ' [code block] ')
    // Remove inline code (` ... `)
    .replace(/`([^`]+)`/g, '$1')
    // Remove bold (**text** or __text__)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // Remove italic (*text* or _text_) - be careful not to match bullet points
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_([^_]+)_(?!_)/g, '$1')
    // Remove headers (# ## ### etc)
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bullet points but keep content
    .replace(/^[\s]*[-*+]\s+/gm, '')
    // Remove numbered lists but keep content
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Remove links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove images ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Remove blockquotes
    .replace(/^>\s+/gm, '')
    // Clean up multiple spaces/newlines
    .replace(/\n{3,}/g, '\n\n')
    .replace(/  +/g, ' ')
    .trim()
}


/**
 * Load skill files from agent/.claude/skills/{name}/SKILL.md
 * Injects into system prompt so Claude sees them as available capabilities.
 * Skills execute via Bash — no SDK settingSources needed.
 */
function loadSkillsFromDir(agentDir: string): string {
  const skillsDir = join(agentDir, '.claude', 'skills')
  if (!existsSync(skillsDir)) return ''

  const skills: string[] = []
  try {
    for (const skillName of readdirSync(skillsDir)) {
      const skillFile = join(skillsDir, skillName, 'SKILL.md')
      if (existsSync(skillFile)) {
        skills.push(readFileSync(skillFile, 'utf-8').trim())
      }
    }
  } catch (err) {
    console.warn('⚠️ Failed to load skills:', err)
  }

  if (skills.length === 0) return ''
  console.log(`📚 Loaded ${skills.length} skill(s) from ${skillsDir}`)
  return `<available-skills>\n${skills.join('\n\n---\n\n')}\n</available-skills>`
}

/**
 * Loads skills from both ~/.claude/skills/ (home dir) and {workingDir}/.claude/skills/ (project dir).
 * Merges results, deduplicating by skill directory name — home dir wins on conflicts.
 * Returns a combined <available-skills> XML block, or '' if no skills found.
 */
function loadAllSkills(_workingDir: string): string {
  // Single source of truth: ~/.claude/skills/
  // Defaults are seeded into this dir by the provisioning bootstrap (sprites.ts
  // buildOsbornBootstrap + Dockerfile.sandbox entrypoint). PostCompact writes
  // newly-learned skills here too. By unifying on one path we avoid the older
  // confusion where defaults loaded from node_modules/osborn/.claude/skills/
  // while PostCompact wrote to home — meaning learnings were second-class.
  const homeSkillsDir = join(homedir(), '.claude', 'skills')
  if (!existsSync(homeSkillsDir)) {
    console.log(`📚 No skills dir at ${homeSkillsDir} — bootstrap may not have run yet`)
    return ''
  }

  const skillMap = new Map<string, string>()
  try {
    for (const skillName of readdirSync(homeSkillsDir)) {
      const skillFile = join(homeSkillsDir, skillName, 'SKILL.md')
      if (existsSync(skillFile)) {
        skillMap.set(skillName, readFileSync(skillFile, 'utf-8').trim())
      }
    }
  } catch (err) {
    console.warn('⚠️ Failed to load skills from', homeSkillsDir, ':', err)
  }

  if (skillMap.size === 0) return ''
  console.log(`📚 Loaded ${skillMap.size} skill(s) from ${homeSkillsDir}`)
  return `<available-skills>\n${[...skillMap.values()].join('\n\n---\n\n')}\n</available-skills>`
}

// Compaction threshold: Fable 5 runs a 1M context window, so let sessions use
// all of it before auto-compacting. autoCompactWindow max is 1_000_000; the SDK
// reads it from settings.json (settingSources includes 'user'), so merge it into
// ~/.claude/settings.json at startup. Idempotent; never clobbers other keys.
function ensureCompactionSettings(): void {
  try {
    const claudeDir = join(homedir(), '.claude')
    const settingsPath = join(claudeDir, 'settings.json')
    let settings: Record<string, unknown> = {}
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* rewrite corrupt file */ }
    } else {
      mkdirSync(claudeDir, { recursive: true })
    }
    if (settings.autoCompactWindow !== 1_000_000) {
      settings.autoCompactWindow = 1_000_000
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
      console.log('🪟 autoCompactWindow set to 1,000,000 in', settingsPath)
    }
  } catch (err) {
    console.warn('⚠️ Failed to ensure compaction settings:', err)
  }
}
ensureCompactionSettings()

// Enable Opus 4.8's native 1M context window + set the auto-compact threshold
// at MODULE LOAD — BEFORE any query() spawns — so they actually apply to the
// persistent session. Setting these per-message in pushMessage() is too late:
// the SDK subprocess reads env once at cold-start, so later writes never reach
// the running query — the reason auto-compaction kept firing at ~150k every
// turn. ENABLE_1M_CONTEXT is Claude Code's documented switch for the context-1m
// (1M) window; without it opus runs at its 200K default. NOTE: 1M activation
// also depends on account entitlement (auto on Team seats; else usage credits).
process.env.ENABLE_1M_CONTEXT = '1'
process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '92'

// Research mode tools — full research capabilities
// Named sub-agents — the orchestrator delegates to these specialists. Each has
// a specific role, model, and tool set. Module-level + exported so the HTTP
// API (/agents) and the frontend agents manager can list them without
// duplicating the definitions. The query options reference this same object.
export const NAMED_AGENTS = {
  researcher: {
    description: [
      'Information gathering agent (Sonnet). Use for: codebase exploration, web research,',
      'finding patterns, reading multiple files, searching for examples.',
      'Returns structured findings — does NOT make decisions or edit files.',
      'Use this for ANY task that needs more than 2 tool calls to gather information.',
    ].join(' '),
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Task'],
    model: 'sonnet',
    prompt: [
      'You are Osborn\'s research agent. Your job is information gathering — thorough, structured, factual.',
      '',
      '## Your role',
      'Gather information the main agent needs to answer the user\'s question or make a decision.',
      'You are a scout — go find things, read them carefully, and report back.',
      '',
      '## Grounding — check the session index first',
      'Before researching, locate the session index (search-index.txt — a compact line-per-message log of this mission, under .claude/projects/<slug>/osb/<session>/; if several exist pick the most recently modified) and Grep it for the topic you are about to investigate. Read ONLY the matching slice, never the whole file.',
      'Purpose: find what has ALREADY been decided, answered, or ruled out so you do not re-research a settled question. If the index already establishes the answer, report that (with the index reference) instead of redoing the work.',
      'If you cannot find the index, proceed normally — this is an optimization, not a hard dependency.',
      '',
      '## How to work',
      '1. Understand what information is needed and why.',
      '2. Search broadly first (Glob, Grep, WebSearch), then read deeply (Read specific files).',
      '3. For large investigations, use the Task tool to run parallel searches.',
      '4. Cap yourself at 5-8 tool calls unless the task clearly requires more.',
      '',
      '## What to return',
      'Structured findings with specifics:',
      '- File paths and line numbers where you found relevant code',
      '- Exact values, configs, versions — not paraphrases',
      '- Direct quotes from documentation or web sources',
      '- What you looked for but did NOT find (negative results matter)',
      '',
      '## What NOT to do',
      '- Do NOT make recommendations or decisions — just surface facts',
      '- Do NOT edit or write any files',
      '- Do NOT run destructive commands (no rm, no git push, no npm publish)',
      '- If you need clarification, ask the main agent — it will relay to the user if needed',
      '',
      '## When to use / handoff',
      'Invoked FIRST for any task requiring facts, codebase exploration, or web research.',
      'Return findings to the orchestrator — never directly to the user.',
      'Run several researchers in parallel when there are independent threads to investigate.',
      'Hand off back to the orchestrator; it decides whether to invoke planner or writer next.',
    ].join('\n'),
  },
  reasoner: {
    description: [
      'Deep reasoning agent (Opus). Use for: architecture decisions, complex problem analysis,',
      'tradeoff evaluation, generating implementation plans, understanding hard problems.',
      'Slow but thorough — only use for genuinely complex problems that need careful thought.',
      'Does NOT edit files — returns a clear plan for the writer agent to execute.',
    ].join(' '),
    tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    model: 'opus',
    prompt: [
      'You are Osborn\'s reasoning agent — the "smart model" seat for hard tradeoffs, architecture decisions, and vetting research.',
      '',
      '## Your role',
      'You DECIDE. You do not route work — that is the orchestrator\'s job. You receive structured summaries (not raw dumps) and return clear, opinionated decisions with full rationale.',
      'Think hard about complex problems. Consider multiple approaches. Identify risks and edge cases.',
      '',
      '## Session context',
      'The orchestrator provides, as an artifact in your brief, the PATH to the session index file (search-index.txt — the running index of this session/mission). You MUST actually READ it — do not rely on a summary or a preloaded window. Read the full index (or the portions you need) directly to ground your analysis, understand the mission, and refine/manage the researchers\' work. Reach into the full index whenever a decision or a research review needs the fuller history — that direct reading is what sets your judgment apart.',
      '',
      '## How to work',
      '1. Read and understand the full context before forming an opinion.',
      '2. If the main agent provided researcher findings, use them as your starting point.',
      '3. Enumerate at least 2-3 alternative approaches before recommending one.',
      '4. For each option consider: pros, cons, risks, and reversibility.',
      '5. Use Read/Grep to verify assumptions against the actual codebase when relevant.',
      '6. Think about: correctness, maintainability, performance, failure modes, migration path.',
      '',
      '## Decision output format',
      'For a decision task, structure your response as:',
      '- OPTIONS: for each option — pros / cons / risks / reversibility',
      '- RECOMMENDATION: the chosen option (one clear answer, not "it depends")',
      '- RATIONALE: one paragraph — why this option wins and what assumptions you are making',
      '- PLAN: step-by-step implementation instructions specific enough for the writer agent',
      '- RISKS: what could go wrong and how to mitigate',
      '',
      '## Research-review gate',
      'When reviewing a researcher\'s findings, judge whether the research is COMPLETE and well-sourced against the original task. If it is, pass it. If it\'s thin, missing sources, or the answer likely lives somewhere the researcher didn\'t look, report that it needs more — so the orchestrator sends the researcher back.',
      'End every research review with exactly one of:',
      '  GATE: PASS',
      '  GATE: NEEDS-MORE — <what\'s missing / where to look>',
      '',
      '## What NOT to do',
      '- Do NOT edit or write files — return a plan for the writer agent',
      '- Do NOT give wishy-washy "both options are valid" non-answers — commit to a recommendation',
      '- Do NOT consume raw session dumps; ask the orchestrator for a structured summary instead',
      '- If you need more information, ask the main agent to delegate to the researcher',
      '',
      '## When to use / handoff',
      'Invoked for hard architecture or tradeoff decisions — read-only, returns a plan.',
      'Use AFTER researcher has gathered facts but BEFORE writer touches any files.',
      'Return a clear recommendation and implementation plan; the orchestrator passes it to the writer.',
    ].join('\n'),
  },
  writer: {
    description: [
      'Execution agent with file write/edit permissions (Sonnet).',
      'Handles ALL file operations: code, config, docs, scripts, data files.',
      'VERIFY-FIRST workflow: checks assumptions before making changes, runs tests after.',
      'If anything is unclear, asks the main agent for clarification before touching files.',
    ].join(' '),
    tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'NotebookRead', 'NotebookEdit'],
    model: 'sonnet',
    prompt: [
      'You are Osborn\'s writer agent. You execute file changes with a verify-first approach.',
      '',
      '## Your role',
      'Handle ALL file operations — code, config, documentation, scripts, data files.',
      'You are the only agent that writes. The main agent and reasoner produce plans; you execute them.',
      '',
      '## Grounding — consult the session index (light touch)',
      'Before editing, locate the session index (search-index.txt under .claude/projects/<slug>/osb/<session>/; newest if several) and Grep it ONLY for: (a) the files/symbols you are about to change, and (b) any recorded DECISIONS or known GOTCHAS relevant to this change. Read only the matching lines — do NOT read the whole index (thousands of lines). This is a lighter dose than the reviewer: a targeted lookup.',
      'If a decision or gotcha contradicts your task, STOP and report to the main agent before editing. If you find nothing or no index exists, proceed normally.',
      '',
      '## VERIFY-FIRST workflow (mandatory)',
      '',
      '### Step 1: Verify assumptions',
      '1. Read the files you\'re about to modify. Confirm they match what the plan expects.',
      '2. If the plan references specific code patterns, grep to confirm they exist.',
      '3. If applicable, run the current test suite or build to confirm the starting state works.',
      '4. If ANYTHING has drifted from the plan (file moved, code refactored, dependency changed):',
      '   STOP and report back to the main agent. Do NOT improvise.',
      '',
      '### Step 2: Clarify unknowns',
      '1. If the plan is vague or ambiguous — ask the main agent a specific clarifying question.',
      '   Examples: "Which config format — YAML or JSON?", "New file or extend existing auth.ts?"',
      '2. The main agent will answer from context or relay to the user.',
      '3. Do NOT guess. One clear question is better than a wrong assumption.',
      '4. Restate what you will do before doing it: which files, what changes, in what order.',
      '',
      '### Step 3: Execute changes',
      '- Make ONLY the changes described in the plan.',
      '- Do NOT refactor adjacent code, fix unrelated issues, add unrequested comments/docs.',
      '- If you hit an unexpected issue, STOP and report to the main agent.',
      '',
      '### Step 4: Verify results',
      '1. Run tests if available (npm test, pytest, cargo test, etc.).',
      '2. Run the build if applicable (npm run build, tsc --noEmit, etc.).',
      '3. If tests or build fail: attempt to fix the issue you introduced. Re-run.',
      '4. Report: files changed, what changed in each, test results, any failures.',
      '',
      '## When to use / handoff',
      'Invoked AFTER the planner produces a written plan — the writer is the SOLE agent that edits files.',
      'Do not invoke writer until a plan exists for any multi-step change.',
      'When the writer returns, the orchestrator invokes tester AND reviewer in parallel before surfacing results.',
    ].join('\n'),
  },
  tester: {
    description: [
      'Test-runner agent (Sonnet). Use for: running test suites, executing builds, interpreting',
      'CI failures, checking compilation errors, verifying that a change did not break anything.',
      'Returns structured pass/fail results with exact output — does NOT edit files.',
    ].join(' '),
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit'],
    model: 'sonnet',
    prompt: [
      'You are Osborn\'s tester agent. Your job is running tests and builds, then reporting results.',
      '',
      '## Your role',
      'Execute test suites, build commands, and linters. Interpret failures clearly.',
      'You are a quality gate — find out whether the code works, and say exactly what broke.',
      '',
      '## Grounding — consult shared context before writing or running tests',
      'Before deciding what to test, locate the session index (search-index.txt under .claude/projects/<slug>/osb/<session>/; newest if several) and Grep it for the changes/work under test. Also check any project docs and known-issues files (e.g. CONVENTIONS.md, docs/, a known-issues or gotchas doc if present) for: (a) KNOWN ISSUES and gotchas already recorded, and (b) what behavior is ALREADY covered by existing tests.',
      'Purpose: target regression coverage at real GAPS and known-risk areas rather than testing blind or duplicating coverage — and stay IN SYNC with the reviewer, which reads the same sources.',
      'Read only the relevant slice of the index, never the whole file. If you find nothing or no index/docs exist, proceed normally — this is an optimization, not a hard dependency.',
      '',
      '## Backward-compatibility / regression mandate (CRITICAL)',
      'Existing test suites MUST still pass — any pre-existing test that breaks is a BLOCKER; report it as such.',
      'The public API surface (function signatures, exported types, return shapes, behavior) must NOT silently change.',
      'Flag any change that could break existing callers, even if no test currently covers it.',
      '',
      '## How to work',
      '0. **Get the diff first (MANDATORY):** Run `git diff HEAD~1 HEAD --name-only` to get the list of',
      '   changed files, then `git diff HEAD~1 HEAD` for the full diff. Build your entire test plan around',
      '   the SPECIFIC files and functions that changed — not a generic sweep.',
      '1. Identify the correct test / build command from package.json, Makefile, or the task brief.',
      '2. Run the FULL existing test suite first to establish the regression baseline.',
      '3. Generate and run tests targeted at the SPECIFIC diff/change — at both unit and integration levels.',
      '   Focus on: the changed functions/components, their callers, and any behavior the diff modifies.',
      '4. Exercise edge cases: boundary values, empty inputs, error/exception paths, null/undefined.',
      '5. Execution loop: write test → run it → read failure output → fix the test OR flag as a real bug in the code. Do NOT silently paper over a real defect.',
      '6. If a command fails, read the relevant source files to locate the root cause.',
      '7. Cap yourself at 6-8 tool calls unless the investigation clearly requires more.',
      '',
      '## What to return',
      '- RESULT: PASS or FAIL (one word, first line)',
      '- COMMAND: the exact command(s) you ran',
      '- OUTPUT: relevant excerpt (errors, failing test names, line numbers)',
      '- ROOT CAUSE: your diagnosis of why it failed (if applicable)',
      '- TEST FILES: path(s) to any test files written or modified',
      '- COVERAGE DELTA: what the change adds or leaves uncovered (before vs after where determinable); list notable uncovered lines/paths',
      '- REGRESSIONS / COMPAT BREAKS: explicit list of any pre-existing tests that now fail or API changes that could break existing callers — tag each as BLOCKER',
      '- What you checked but found to be unrelated',
      '',
      '## Backward-compatibility testing & building the test library',
      'GROW THE LIBRARY OVER TIME: where coverage is missing for the behavior being verified,',
      'CREATE a targeted regression test so the suite accumulates over time. If NO test suite or',
      'test infrastructure exists yet, establish a MINIMAL one — a single test file plus the',
      'smallest runner wiring needed — do NOT stand up a heavy framework; keep it small and incremental.',
      '',
      'HARD RESTRICTION: you may ONLY write TEST files — files whose names contain `.test.` or `.spec.`,',
      'or files located under a `__tests__/` or `tests/` directory.',
      'NEVER write source, config, or other files. The write-gate enforces this and will deny any non-test path.',
      '',
      '## What NOT to do',
      '- Do NOT edit or write production files — report failures so the writer agent can fix them',
      '- Do NOT run destructive commands (no rm, no git push, no npm publish)',
      '- Do NOT guess at fixes — diagnose only',
      '- Do NOT paper over a real defect by weakening or skipping a test',
      '',
      '## When to use / handoff',
      'Invoked in PARALLEL with reviewer, immediately after the writer returns a change.',
      'Return a PASS or FAIL verdict with exact output; the orchestrator waits for both tester and reviewer.',
      'NEVER skip for a code change — the orchestrator synthesizes and speaks only after both return.',
    ].join('\n'),
  },
  planner: {
    description: [
      'Planning agent (Opus). Use for: decomposing a large or ambiguous request into a concrete,',
      'ordered sequence of atomic writer-safe steps. Returns a self-contained brief the writer',
      'can execute without further clarification. Slow but thorough — only use for genuinely',
      'complex multi-file changes or when the approach is uncertain.',
    ].join(' '),
    tools: ['Read', 'Glob', 'Grep', 'WebSearch'],
    model: 'opus',
    prompt: [
      'You are Osborn\'s planning agent. Your job is to decompose complex tasks into clear, atomic steps.',
      '',
      '## Your role',
      'Turn a vague or large request into a precise, ordered implementation plan the writer can execute',
      'step by step without guessing. You are the bridge between "what" and "how".',
      '',
      '## Grounding — plan against what already exists',
      'Before drafting a plan, locate the session index (search-index.txt under .claude/projects/<slug>/osb/<session>/; newest if several) and Grep it for prior DECISIONS, constraints, and known GOTCHAS relevant to the task. Read only the matching slice, never the whole file.',
      'Purpose: make the plan fit what has already been decided or tried — do not propose an approach the mission already ruled out. If a prior decision conflicts with the obvious plan, surface it in the plan rather than silently contradicting it.',
      'If you cannot find the index, proceed normally.',
      '',
      '## Documentation at delivery milestones',
      'Plans should account for documentation reconciliation at the point work is DELIVERED — when it ships,',
      'goes live, or reaches a release milestone. Include a step (or an explicit note in VERIFY) to check',
      'whether existing documentation still reflects what is changing, and flag it as a task if updates are',
      'needed. Do NOT schedule doc updates for every incremental step; anchor them to the delivery boundary',
      'so documentation stays stable between releases and does not silently drift out of sync when the work ships.',
      '',
      '## How to work',
      '1. Read enough of the codebase to understand the current structure (Glob, Grep, Read).',
      '2. Identify every file that needs to change and why.',
      '3. Order the steps so each one is independently safe (no step depends on a later one).',
      '4. Flag any decision the writer should NOT make alone — surface it as an open question.',
      '',
      '## What to return',
      'A self-contained brief with:',
      '- GOAL: one sentence summary of the outcome',
      '- CONTEXT: relevant file paths, existing patterns, constraints the writer must respect',
      '- STEPS: numbered, atomic steps (one logical change per step; include file path + what to change)',
      '- OPEN QUESTIONS: anything genuinely ambiguous that needs user input before proceeding',
      '- VERIFY: how the writer should confirm the change worked (test command, manual check, etc.)',
      '',
      '## What NOT to do',
      '- Do NOT edit or write files — produce a plan only',
      '- Do NOT leave steps vague ("update the config" → say which file, which key, what value)',
      '- Do NOT include steps that depend on runtime information you do not have',
      '',
      '## When to use / handoff',
      'Invoked AFTER researcher gathers facts and BEFORE writer touches any files, when the task has multiple steps.',
      'Do not skip on multi-step or multi-file changes — vague delegation to writer without a plan produces worse output.',
      'Return a self-contained brief; the orchestrator passes it directly to the writer.',
    ].join('\n'),
  },
  reviewer: {
    description: [
      'Code-review agent (Opus). Use for: the VERIFY step in a generator-verifier loop — after the',
      'writer completes a change, the reviewer reads the diff, checks correctness, spec/requirement',
      'adherence, obvious bugs, and security issues, then tags each finding BLOCKER/MAJOR/MINOR/NIT',
      'and returns an ACCEPT or REJECT verdict with specific, actionable feedback. May write documentation files (.md etc.) only.',
    ].join(' '),
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'],
    model: 'opus',
    prompt: [
      'You are Osborn\'s reviewer agent. You are the VERIFY step in a generator-verifier loop.',
      '',
      '## Your role',
      'Read the writer\'s completed change (via git diff or by reading modified files), then produce',
      'a structured verdict: ACCEPT or REJECT. You report findings so the single writer agent can fix code.',
      'You may write documentation files (.md/.txt/etc.) only. You are the quality gate between a change and merge.',
      '',
      '## Bash is read-only inspection only',
      'You may run: git diff, git log, git status, git show, npm run build, npm test, eslint,',
      'tsc --noEmit, and similar lint/test/security-scan commands.',
      'You must NOT run: rm, git push, git commit, git add, npm publish, or any destructive command.',
      '',
      '## Step 0 — Discover and adopt project standards (before reviewing)',
      'Look for existing project standards, conventions, and documentation: CLAUDE.md, AGENTS.md,',
      'docs/, README, style guides, and any gotchas/anti-pattern/decision notes in the repo or',
      'session memory. If present, ADOPT them as the standard you review against — check the change',
      'against these project-specific conventions and known past gotchas, not just generic best-practice.',
      'If NO such files exist, note that in your report and fall back to the task spec + general best-practice.',
      '',
      '## Maintain documentation',
      'You MAY create and maintain project standards and conventions files. Specifically: adopt an existing',
      'standards doc if one is found, or create one (e.g. CONVENTIONS.md, docs/standards.md) when none exists',
      'and the review reveals patterns worth recording.',
      '',
      'WHEN to reconcile docs: at the moment work is being DELIVERED — when a unit of work ships, goes live,',
      'or reaches a release milestone. That is the checkpoint to verify whether existing documentation still',
      'reflects what actually changed and update it if it has drifted. Do NOT update docs on every small',
      'incremental change; wait for the natural delivery boundary so docs stay stable between releases.',
      'Between delivery milestones, note discrepancies as findings in your verdict (MINOR or NIT) rather',
      'than immediately rewriting documentation.',
      '',
      'RESTRICTION: you may ONLY write files with documentation extensions: .md, .markdown, .mdx, .txt, .rst, .adoc.',
      'You must NEVER write source, config, or executable files — the write gate enforces this at the system',
      'level and will deny any such attempt.',
      '',
      '## Backward-compatibility mandate',
      'For every change, explicitly verify:',
      '- No existing exported function signature changed (parameter count/order/type, return type)',
      '- No existing data-channel message schema changed (field names, types, required fields)',
      '- No existing API endpoint behavior changed silently',
      '- No existing UI prop interface changed in a breaking way',
      '- Existing callers and consumers of the changed code still work',
      'Tag any violation BLOCKER — silent compat breaks are the hardest bugs to catch after the fact.',
      '',
      '## Regression test suite — run and correlate',
      'If a backward-compatibility/regression test suite exists in the project (any test/ or __tests__/',
      'directory, *.test.* or *.spec.* files, or a test script in package.json), RUN IT as part of your',
      'review using Bash. Correlate the results into your verdict:',
      '- A passing suite with no regressions: note it in WHAT IT CHECKED-AND-CLEARED.',
      '- Any pre-existing test that now fails is a BLOCKER — include it as an ISSUES entry tagged BLOCKER.',
      'Do not skip this step when a suite exists; a failing regression test is a hard blocker regardless',
      'of whether the diff looks clean.',
      '',
      '## How to work',
      '0. **Get the diff first (MANDATORY):** Run `git diff HEAD~1 HEAD --stat` then `git diff HEAD~1 HEAD`.',
      '   Build your entire review around what ACTUALLY changed — not the writer\'s narrative alone.',
      '   If the task provides a diff, still verify it matches git history.',
      '1. Run `git diff` (or read the files listed in the task) to see exactly what changed.',
      '2. Read any file that needs context to evaluate the diff (interfaces, callers, tests).',
      '3. Run the build or test suite if available to catch compile/runtime regressions.',
      '4. Check against the spec or requirement provided in the task brief AND any project standards found above.',
      '5. Look for: logic errors, missing edge cases, security issues (injection, path traversal,',
      '   credential exposure), broken types, spec deviations, unintended side-effects.',
      '6. Cap yourself at 10 tool calls unless the review clearly requires more.',
      '',
      '## Severity taxonomy',
      'Tag EVERY finding with exactly one of:',
      '  BLOCKER — incorrect behavior, data loss, security hole, broken build; must fix before merge',
      '  MAJOR   — significant bug or spec deviation that will likely cause real problems in use',
      '  MINOR   — non-critical defect or missed edge case worth fixing but not blocking',
      '  NIT     — style, naming, or polish; never a reason to REJECT on its own',
      '',
      '## What to return',
      'Structure your response EXACTLY as follows:',
      '',
      'VERDICT: ACCEPT | REJECT  — <one-line rationale>',
      '',
      'ISSUES (omit section entirely if VERDICT is ACCEPT):',
      '  [SEVERITY] <file>:<line>',
      '  Evidence: "<short quote of the offending code>"',
      '  Impact: <what breaks or why it matters>',
      '  Fix: <recommended change>',
      '  Verify: <how to confirm the fix is correct>',
      '',
      'WHAT IT CHECKED-AND-CLEARED:',
      '  - <each item you verified and found correct — be specific, not generic>',
      '',
      '## What NOT to do',
      '- Do NOT write code, config, or source files — only documentation-extension files (.md/.markdown/.mdx/.txt/.rst/.adoc) are permitted',
      '- Do NOT run destructive commands (no rm, no git push, no git commit, no npm publish)',
      '- Do NOT approve a change that has a real defect just to be agreeable',
      '- Do NOT REJECT solely on NIT-level findings',
      '',
      '## When to use / handoff',
      'Invoked in PARALLEL with tester, immediately after the writer returns a change.',
      'The orchestrator waits for both reviewer and tester before synthesizing and speaking to the user.',
    ].join('\n'),
  },
}

const RESEARCH_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash', 'WebSearch', 'WebFetch',
  'LSP', 'Task', 'TodoWrite',
]

/**
 * Pushable async iterable — allows pushing SDKUserMessages into a query's
 * streaming input. The query subprocess stays alive between pushes (no JSONL replay).
 */
class MessageChannel<T> {
  #queue: T[] = []
  #waiting: ((value: IteratorResult<T>) => void) | null = null
  #done = false

  push(item: T): void {
    if (this.#done) return
    if (this.#waiting) {
      const resolve = this.#waiting
      this.#waiting = null
      resolve({ value: item, done: false })
    } else {
      this.#queue.push(item)
    }
  }

  close(): void {
    this.#done = true
    if (this.#waiting) {
      const resolve = this.#waiting
      this.#waiting = null
      resolve({ value: undefined as any, done: true })
    }
  }

  get closed(): boolean { return this.#done }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.#queue.length > 0) {
          return Promise.resolve({ value: this.#queue.shift()!, done: false })
        }
        if (this.#done) {
          return Promise.resolve({ value: undefined as any, done: true })
        }
        return new Promise(resolve => { this.#waiting = resolve })
      },
    }
  }
}

/**
 * Claude LLM - Wraps Claude Agent SDK for LiveKit
 * Research mode: reads anything, writes only to session workspace
 */
export class ClaudeLLM extends llm.LLM {
  #opts: ClaudeLLMOptions
  #sessionId: string | null = null
  #eventEmitter: EventEmitter
  #resumeSessionId: string | null = null
  #continueSession: boolean = false
  #mcpServers: Record<string, McpServerConfig> = {}

  // File checkpointing - stores checkpoint UUIDs for rewinding file changes
  #checkpoints: string[] = []
  #latestCheckpoint: string | null = null

  // Pending permission request (for voice approval flow)
  #pendingPermission: {
    toolName: string
    input: Record<string, unknown>
    resolve: (decision: { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }) => void
  } | null = null

  // Persistent session — single query() with AsyncIterable<SDKUserMessage> input.
  // Subprocess spawns once on first chat(), stays alive for all subsequent messages.
  // No JSONL replay after the first cold start.
  #persistentQuery: SDKQuery | null = null
  #messageChannel: MessageChannel<SDKUserMessage> | null = null

  // Read-along tracking — per-turn message ID and chunk counter for TTS highlighting
  #currentTurnMessageId: string | null = null
  #currentTurnChunkIndex = 0
  #currentTurnChunks: string[] = []
  #backgroundConsumerRunning = false

  // Active queries — multiple can be running (SDK queues them internally).
  // We keep ALL references so interrupt() can stop whatever is currently executing.
  #activeQueries: Set<any> = new Set()
  // Per-agent-id query map — allows targeted stop of a single dispatch flow.
  // Strictly additive; abortQuery/interruptQuery still iterate #activeQueries (kill-all).
  #activeQueriesById: Map<string, any> = new Map()

  // Dedup guard — prevents double-firing reviewer/gate if SubagentStop fires
  // more than once for the same agent_id (e.g. retry edge cases).
  #dispatchedFor: Set<string> = new Set()

  constructor(opts: ClaudeLLMOptions = {}) {
    super()

    // Session resume/continue options
    this.#resumeSessionId = opts.resumeSessionId || null
    this.#continueSession = opts.continueSession || false

    // MCP servers
    this.#mcpServers = opts.mcpServers || {}

    this.#opts = {
      workingDirectory: opts.workingDirectory || process.cwd(),
      sessionBaseDir: opts.sessionBaseDir || opts.workingDirectory || process.cwd(),
      permissionMode: opts.permissionMode || 'default',
      allowedTools: opts.allowedTools || RESEARCH_TOOLS,
      resumeSessionId: this.#resumeSessionId || undefined,
      continueSession: this.#continueSession,
      mcpServers: this.#mcpServers,
      voiceMode: opts.voiceMode || 'realtime',
      skipTTSQueue: opts.skipTTSQueue || false,
      // CRITICAL: the PreCompact / PostCompact hooks call
      // `this.#opts.onCompactionEvent?.(...)` to invoke the bridge to the
      // frontend (chat-bubble + banner). Without including the callback in
      // this whitelisted literal, callers can pass it correctly via opts but
      // it's silently dropped during construction → hooks invoke undefined →
      // no chat bubble appears. This was the real reason the compaction UI
      // never showed up in 0.9.44–0.9.46 despite the wiring at every caller
      // looking right. Confirmed 2026-05-28 by reading the live dist on Fly
      // and seeing PreCompact/PostCompact emoji logs + the SDK iterator
      // marker [COMPACT-SDK-ITER] firing while [COMPACT-AGENT-RX] never did.
      // `onPermissionRequest` is handled separately via its own private field
      // and does NOT need to be in this literal.
      onCompactionEvent: opts.onCompactionEvent,
    }
    this.#eventEmitter = opts.eventEmitter || new EventEmitter()

    console.log('🟠 ClaudeLLM initialized (Research Mode)')
    console.log(`   📁 Working dir (cwd): ${this.#opts.workingDirectory}`)
    if (this.#opts.sessionBaseDir !== this.#opts.workingDirectory) {
      console.log(`   📁 Session base dir: ${this.#opts.sessionBaseDir}`)
    }
    console.log(`   🔧 Allowed tools: ${this.#opts.allowedTools?.join(', ')}`)
    const mcpCount = Object.keys(this.#mcpServers).length
    if (mcpCount > 0) {
      console.log(`   🔌 MCP servers: ${Object.keys(this.#mcpServers).join(', ')}`)
    }
    if (this.#resumeSessionId) {
      console.log(`   🔄 Resuming session: ${this.#resumeSessionId}`)
    } else if (this.#continueSession) {
      console.log(`   🔄 Continuing most recent session`)
    }
  }

  /**
   * Respond to a pending permission request
   * Call this after receiving 'permission_request' event
   */
  respondToPermission(allow: boolean, message?: string) {
    if (this.#pendingPermission) {
      const input = this.#pendingPermission.input
      if (allow) {
        this.#pendingPermission.resolve({
          behavior: 'allow',
          updatedInput: input, // Pass through original input
        })
      } else {
        this.#pendingPermission.resolve({
          behavior: 'deny',
          message: message || 'User denied permission',
        })
      }
      this.#pendingPermission = null
    }
  }

  /**
   * Check if there's a pending permission request
   */
  hasPendingPermission(): boolean {
    return this.#pendingPermission !== null
  }

  /**
   * Get pending permission details
   */
  getPendingPermission(): { toolName: string; input: any } | null {
    if (this.#pendingPermission) {
      return { toolName: this.#pendingPermission.toolName, input: this.#pendingPermission.input }
    }
    return null
  }

  // ============================================================
  // MCP SERVER MANAGEMENT - Runtime enable/disable MCP servers
  // ============================================================

  /**
   * Get all currently enabled MCP servers
   */
  getMcpServers(): Record<string, McpServerConfig> {
    return { ...this.#mcpServers }
  }

  /**
   * Get list of enabled MCP server keys
   */
  getEnabledMcpServerKeys(): string[] {
    return Object.keys(this.#mcpServers)
  }

  /**
   * Replace all MCP servers at once
   */
  setMcpServers(servers: Record<string, McpServerConfig>): void {
    this.#mcpServers = { ...servers }
    this.#opts.mcpServers = this.#mcpServers
    console.log(`🔌 MCP servers updated: ${Object.keys(servers).join(', ') || 'none'}`)
    this.#eventEmitter.emit('mcp_servers_changed', {
      enabledKeys: Object.keys(this.#mcpServers),
    })
  }

  /**
   * Enable a single MCP server
   */
  enableMcpServer(key: string, config: McpServerConfig): void {
    this.#mcpServers[key] = config
    this.#opts.mcpServers = this.#mcpServers
    console.log(`🔌 MCP server enabled: ${key}`)
    this.#eventEmitter.emit('mcp_servers_changed', {
      enabledKeys: Object.keys(this.#mcpServers),
    })
  }

  /**
   * Disable a single MCP server
   */
  disableMcpServer(key: string): void {
    delete this.#mcpServers[key]
    this.#opts.mcpServers = this.#mcpServers
    console.log(`🔌 MCP server disabled: ${key}`)
    this.#eventEmitter.emit('mcp_servers_changed', {
      enabledKeys: Object.keys(this.#mcpServers),
    })
  }

  label(): string {
    return 'claude.agent-sdk'
  }

  get model(): string {
    // The [1m] suffix opts into Opus 4.8's 1M context window (Claude Code's
    // context-1m-2025-08-07 beta). WITHOUT it the SDK runs opus at its 200k
    // base, so auto-compaction fired at ~153k every ~10 min (confirmed in the
    // live agent log: compact_boundary pre_tokens≈153k). With [1m] the window
    // is 1M and compaction happens far later. Overridable via opts.model.
    return this.#opts.model || 'claude-opus-4-8[1m]'
  }

  get sessionId(): string | null {
    return this.#sessionId
  }

  /**
   * Set per-user named agents (DB-backed, from the frontend's set_agents).
   * Synced to #opts so ClaudeLLMStream picks them up when the persistent
   * query is created. SDK constraint: takes effect at the NEXT query cold
   * start (session start/resume/switch) — a live subprocess keeps the agents
   * it was created with.
   */
  setAgents(agents: ClaudeLLMOptions['agents']): void {
    this.#opts.agents = agents
    console.log(`🤖 Named agents ${agents ? `set (${Object.keys(agents).join(', ')})` : 'reset to built-ins'} — applies at next query cold start`)
  }

  /**
   * Set session ID to resume a specific conversation
   * Call this before sending the first message to resume from a previous session
   */
  setResumeSessionId(sessionId: string | null): void {
    this.#resumeSessionId = sessionId
    // CRITICAL: Sync to opts so ClaudeLLMStream.run() picks up the resume ID
    this.#opts.resumeSessionId = sessionId || undefined

    if (sessionId) {
      console.log(`🔄 Will resume session: ${sessionId}`)
    }
  }

  /**
   * Set the working directory for the current session
   * Call this when resuming a session from a different project slug
   */
  setWorkingDirectory(path: string): void {
    this.#opts.workingDirectory = path
  }

  /**
   * Reset state for mid-conversation session switch
   * Clears pending permissions and resets conversation tracking
   */
  resetForSessionSwitch(): void {
    // Kill persistent session — new session needs fresh subprocess
    this.closeSession()

    // Clear any pending permission request from previous session
    if (this.#pendingPermission) {
      this.#pendingPermission.resolve({
        behavior: 'deny',
        message: 'Session switched - permission request cancelled',
      })
      this.#pendingPermission = null
    }

    // Clear session resume state so new resume can take effect
    this.#resumeSessionId = null
    this.#continueSession = false
    this.#opts.resumeSessionId = undefined
    this.#opts.continueSession = false
    this.#sessionId = null

    // Clear checkpoints from previous session
    this.#checkpoints = []
    this.#latestCheckpoint = null

    // Emit event for listeners
    this.#eventEmitter.emit('session_reset')

    console.log('🔄 LLM state reset for session switch')
  }

  /**
   * Enable "continue" mode - resumes most recent session
   */
  setContinueSession(enabled: boolean): void {
    this.#continueSession = enabled
    this.#opts.continueSession = enabled
    if (enabled) {
      console.log(`🔄 Will continue most recent session`)
    }
  }

  /**
   * Check if this instance is configured to resume a session
   */
  get isResumingSession(): boolean {
    return !!(this.#resumeSessionId || this.#continueSession)
  }

  get events(): EventEmitter {
    return this.#eventEmitter
  }

  // ============================================================
  // FILE CHECKPOINTING - Track and rewind file changes
  // ============================================================

  /**
   * Capture a checkpoint UUID for potential file rewind
   * Called internally when receiving user message UUIDs from the SDK
   */
  captureCheckpoint(checkpointId: string): void {
    this.#checkpoints.push(checkpointId)
    this.#latestCheckpoint = checkpointId
    console.log(`📍 Checkpoint captured: ${checkpointId.substring(0, 8)}...`)
    this.#eventEmitter.emit('checkpoint_captured', { checkpointId })
  }

  /**
   * Get the most recent checkpoint UUID
   * Use this to rewind all file changes back to the beginning
   */
  getLatestCheckpoint(): string | null {
    return this.#latestCheckpoint
  }

  /**
   * Get the first checkpoint UUID (initial state)
   * Rewinding to this restores all files to their original state
   */
  getFirstCheckpoint(): string | null {
    return this.#checkpoints.length > 0 ? this.#checkpoints[0] : null
  }

  /**
   * Get all captured checkpoint UUIDs
   * Ordered from oldest to newest
   */
  getCheckpoints(): string[] {
    return [...this.#checkpoints]
  }

  /**
   * Clear all captured checkpoints
   * Call this when starting a new session
   */
  clearCheckpoints(): void {
    this.#checkpoints = []
    this.#latestCheckpoint = null
    console.log('🧹 Checkpoints cleared')
  }

  /**
   * Check if checkpoints are available
   */
  hasCheckpoints(): boolean {
    return this.#checkpoints.length > 0
  }

  // ============================================================
  // AGENT CONTROL — interrupt, abort, rewind (for fast brain)
  // ============================================================

  /**
   * Interrupt the current Claude query gracefully (like pressing Esc).
   * Stops current tool execution but keeps the process alive.
   * Returns true if interrupted, false if no active query.
   */
  async interruptQuery(): Promise<boolean> {
    // Prefer persistent query's interrupt() — graceful Esc that keeps subprocess alive
    if (this.#persistentQuery && typeof this.#persistentQuery.interrupt === 'function') {
      try {
        await this.#persistentQuery.interrupt()
        console.log('🛑 Interrupted persistent session (Esc equivalent — subprocess stays alive)')
        return true
      } catch (err: any) {
        console.error('⚠️ Persistent interrupt failed:', err?.message)
      }
    }
    // Fallback: interrupt any active one-shot queries (realtime mode research)
    if (this.#activeQueries.size === 0) return false
    const queriesToInterrupt = [...this.#activeQueries]
    let interrupted = false
    for (const q of queriesToInterrupt) {
      if (typeof q.interrupt === 'function') {
        try {
          await q.interrupt()
          interrupted = true
        } catch (err: any) {
          console.error('⚠️ Interrupt failed:', err?.message)
        }
      }
    }
    if (interrupted) {
      console.log(`🛑 Interrupted ${queriesToInterrupt.length} active query(s) (Esc equivalent)`)
    }
    return interrupted
  }

  /**
   * Hard abort all active queries (like Ctrl+C).
   * Kills subprocesses. Next message will spawn new processes.
   */
  abortQuery(): void {
    // Kill persistent session first (if alive)
    this.closeSession()
    // Also kill any one-shot queries (realtime research)
    for (const q of this.#activeQueries) {
      try { q.return?.() } catch {}
    }
    this.#activeQueries.clear()
    this.#activeQueriesById.clear()
    console.log('🛑 All queries aborted (Ctrl+C equivalent)')
  }

  /**
   * Rewind file changes to a specific checkpoint.
   * Uses the most recently added query (most likely to have the rewind capability).
   */
  async rewindToCheckpoint(checkpointId?: string): Promise<boolean> {
    const id = checkpointId || this.#latestCheckpoint
    if (!id) {
      console.log('⚠️ No checkpoint available for rewind')
      return false
    }
    // Prefer persistent query (has the full session context)
    if (this.#persistentQuery && typeof this.#persistentQuery.rewindFiles === 'function') {
      try {
        await this.#persistentQuery.rewindFiles(id)
        console.log(`🔄 Files rewound to checkpoint: ${id.substring(0, 8)}...`)
        return true
      } catch (err: any) {
        console.error('⚠️ Rewind failed:', err?.message)
      }
    }
    // Fallback: try latest one-shot query
    const queries = [...this.#activeQueries]
    const latest = queries[queries.length - 1]
    if (latest && typeof latest.rewindFiles === 'function') {
      try {
        await latest.rewindFiles(id)
        console.log(`🔄 Files rewound to checkpoint: ${id.substring(0, 8)}...`)
        return true
      } catch (err: any) {
        console.error('⚠️ Rewind failed:', err?.message)
      }
    }
    return false
  }

  /**
   * Check if there are active queries that can be interrupted
   */
  hasActiveQuery(): boolean {
    return this.#activeQueries.size > 0
  }

  /** Add an active query (called from ClaudeLLMStream when query starts) */
  setActiveQuery(q: any): void {
    if (q) {
      this.#activeQueries.add(q)
    }
  }

  /** Remove an active query (called from ClaudeLLMStream when query completes) */
  removeActiveQuery(q: any): void {
    this.#activeQueries.delete(q)
  }

  /**
   * Stop a single dispatch flow by agent_id.
   * Returns true if the agent was found and stopped; false if not found.
   * Does NOT affect other active queries (use abortQuery() to kill all).
   */
  stopAgent(agentId: string): boolean {
    const q = this.#activeQueriesById.get(agentId)
    if (!q) return false
    try { q.return?.() } catch {}
    this.#activeQueriesById.delete(agentId)
    this.#activeQueries.delete(q)
    return true
  }

  // ============================================================
  // PERSISTENT SESSION — V1 query() with AsyncIterable<SDKUserMessage>
  // Single subprocess per voice session. First chat() does JSONL cold
  // start; subsequent chat() calls push messages to the existing
  // subprocess via the MessageChannel — no JSONL replay.
  // ============================================================

  /** Whether a persistent session is alive and consuming messages */
  hasSession(): boolean {
    return this.#persistentQuery !== null && !this.#messageChannel?.closed
  }

  /**
   * Close the persistent session (kills subprocess).
   * Call on disconnect, session switch, or recovery.
   */
  closeSession(): void {
    if (this.#messageChannel) {
      this.#messageChannel.close()
    }
    if (this.#persistentQuery) {
      try { this.#persistentQuery.close() } catch {}
      this.#activeQueries.delete(this.#persistentQuery)
    }
    this.#persistentQuery = null
    this.#messageChannel = null
    this.#backgroundConsumerRunning = false
    this.#dispatchedFor.clear()
    console.log('🔒 Persistent session closed')
  }

  /**
   * Push a user message into the persistent session.
   * If no session exists yet, creates one (cold start with JSONL replay).
   * If a session exists, instantly delivers the message (no replay).
   *
   * @param userText - The user's message text
   * @param sdkOptions - Full V1 Options (only used on first call to create the query)
   * @param callbacks - Event callbacks for the background consumer
   */
  pushMessage(
    userText: string,
    sdkOptions: Options,
    callbacks: {
      onSessionId: (id: string) => void
      onCheckpoint: (checkpointId: string) => void
      eventEmitter: EventEmitter
    },
  ): void {
    // (Compaction/1M env is set once at module load — see ENABLE_1M_CONTEXT /
    // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE near ensureCompactionSettings(). Setting it
    // here per-message was too late for the persistent query.)

    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: userText }] } as any,
      parent_tool_use_id: null,
      session_id: this.#sessionId || '',
    }

    if (this.#persistentQuery && this.#messageChannel && !this.#messageChannel.closed) {
      // Fast path — push to existing subprocess (no cold start)
      console.log('⚡ Persistent session: pushing message (no JSONL replay)')
      this.#messageChannel.push(userMessage)
      return
    }

    // Cold start — create channel, push first message, start query + background consumer
    console.log('🔄 Persistent session: cold start (first message, JSONL replay)')
    this.#messageChannel = new MessageChannel()
    this.#messageChannel.push(userMessage)

    this.#persistentQuery = query({ prompt: this.#messageChannel as any, options: sdkOptions })
    this.#activeQueries.add(this.#persistentQuery)

    this.#startBackgroundConsumer(callbacks)
  }

  /**
   * Background consumer — runs for the lifetime of the persistent session.
   * Consumes all SDKMessage events from the query and routes them to
   * the event emitter (same events as the old per-query skipTTSQueue path).
   */
  async #startBackgroundConsumer(callbacks: {
    onSessionId: (id: string) => void
    onCheckpoint: (checkpointId: string) => void
    eventEmitter: EventEmitter
  }): Promise<void> {
    if (this.#backgroundConsumerRunning) return
    this.#backgroundConsumerRunning = true
    const pq = this.#persistentQuery!

    try {
      for await (const message of pq) {
        const msg = message as any

        // Session ID capture
        if (msg.type === 'system' && msg.subtype === 'init') {
          const mcpServers = msg.mcp_servers
          if (mcpServers && Array.isArray(mcpServers)) {
            for (const s of mcpServers) {
              const status = s.status === 'connected' ? '✅' : '❌'
              console.log(`${status} MCP server ${s.name}: ${s.status}`)
            }
          }
          const newSessionId = msg.session_id
          if (newSessionId) {
            callbacks.onSessionId(newSessionId)
            const isNew = !this.#sessionId
            if (isNew) console.log(`📋 New session: ${newSessionId}`)
            this.#sessionId = newSessionId
            if (isNew && this.#opts.workingDirectory) {
              saveSessionMetadata(this.#opts.workingDirectory, {
                sessionId: newSessionId,
                lastUpdated: new Date().toISOString(),
                projectPath: this.#opts.workingDirectory,
              })
            }
            const requestedResumeId = this.#opts.resumeSessionId
            if (requestedResumeId && newSessionId !== requestedResumeId) {
              console.error(`❌ Session resume FAILED: Expected ${requestedResumeId.substring(0, 8)}..., got ${newSessionId.substring(0, 8)}...`)
              callbacks.eventEmitter.emit('session_resume_failed', { requestedSessionId: requestedResumeId, actualSessionId: newSessionId })
            } else if (requestedResumeId && newSessionId === requestedResumeId) {
              console.log(`✅ Session resumed successfully: ${newSessionId.substring(0, 8)}...`)
            }
          }
        }

        // Compaction signals observed on the SDK iterator (parallel to hook path).
        // The SDK emits TWO message subtypes during compaction independent of
        // hook registration:
        //   - type:'system', subtype:'compact_boundary'  (with compact_metadata)
        //   - type:'system', subtype:'status', status:'compacting' | null
        // We DON'T route these through onCompactionEvent (to avoid duplicate
        // chat bubbles — hooks already do that), but we LOG them. If the hook
        // path ever silently fails, these logs will be the only signal that
        // compaction actually happened — making the failure obvious in fly logs.
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          const meta = msg.compact_metadata || {}
          console.log(`[COMPACT-SDK-ITER] compact_boundary observed: trigger=${meta.trigger ?? '?'} pre_tokens=${meta.pre_tokens ?? '?'} preserved=${meta.preserved_segment ? 'yes' : 'no'}`)
          // Fire onCompactionEvent as a FALLBACK if hooks didn't fire — we
          // detect this by checking whether we've seen 'compaction_started'
          // recently. For now, log only; can wire as fallback if hooks fail.
        }
        if (msg.type === 'system' && msg.subtype === 'status') {
          const status = msg.status
          if (status === 'compacting' || status === null) {
            console.log(`[COMPACT-SDK-ITER] status change: ${status === 'compacting' ? 'ENTERED compacting' : 'EXITED compacting'} session=${msg.session_id?.substring(0,8) ?? '?'}`)
          }
        }

        // Checkpoint capture
        if (msg.type === 'user' && msg.uuid) {
          callbacks.onCheckpoint(msg.uuid)
        }

        // SDK request ID
        if (msg.requestId) {
          callbacks.eventEmitter.emit('query_request_id', { requestId: msg.requestId })
        }

        // Stream assistant text → tts_say events
        if (msg.type === 'assistant' && msg.message?.content) {
          // Assign a stable messageId for this turn (first block sets it, rest reuse)
          if (!this.#currentTurnMessageId) {
            this.#currentTurnMessageId = crypto.randomUUID()
            this.#currentTurnChunkIndex = 0
            this.#currentTurnChunks = []
          }
          const turnMessageId = this.#currentTurnMessageId
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              const chunkIndex = this.#currentTurnChunkIndex
              callbacks.eventEmitter.emit('assistant_text', { text: block.text, messageId: turnMessageId, chunkIndex })
              const ttsChunk = stripMarkdownForTTS(block.text)
              if (ttsChunk.trim()) {
                this.#currentTurnChunks.push(ttsChunk)
                this.#currentTurnChunkIndex++
                console.log(`🔊 TTS say (${ttsChunk.length} chars): "${ttsChunk}"`)
                callbacks.eventEmitter.emit('tts_say', { text: ttsChunk, messageId: turnMessageId, chunkIndex })
              }
            }
          }
        }

        // Result — marks end of a turn (but we keep consuming for next turn)
        if (msg.type === 'result') {
          const turnMessageId = this.#currentTurnMessageId
          const turnChunks = [...this.#currentTurnChunks]
          if (msg.result) {
            callbacks.eventEmitter.emit('assistant_result', { text: msg.result, messageId: turnMessageId })
          }
          if (turnMessageId && turnChunks.length > 0) {
            callbacks.eventEmitter.emit('tts_chunks', { messageId: turnMessageId, chunks: turnChunks })
          }
          // Reset per-turn state for next turn
          this.#currentTurnMessageId = null
          this.#currentTurnChunkIndex = 0
          this.#currentTurnChunks = []
          console.log('✅ Claude turn complete (persistent session stays alive)')
        }
      }
    } catch (error: any) {
      if (error?.message?.includes('aborted') || error?.message?.includes('AbortError')) {
        console.log('🛑 Persistent session query aborted')
      } else {
        console.error('❌ Persistent session error:', error)
        callbacks.eventEmitter.emit('tts_say', { text: 'Sorry, I encountered an error.' })
      }
    } finally {
      this.#backgroundConsumerRunning = false
      this.#activeQueries.delete(pq)
      this.#persistentQuery = null
      this.#messageChannel = null
      console.log('🔒 Persistent session background consumer exited')
    }
  }

  /**
   * Dispatcher v1 — auto-spawn a reviewer after a writer sub-agent completes.
   * Runs a one-shot query() with the reviewer agent and emits dispatch_rejected
   * if the verdict is REJECT. A reviewer failure must never crash the consumer.
   * Public so ClaudeLLMStream can call it via this.#llmRef.spawnReviewer().
   */
  async spawnReviewer(agentId: string, writerOutput: string, emitter: EventEmitter): Promise<void> {
    // Dedup guard — SubagentStop may fire more than once for the same agent_id.
    if (this.#dispatchedFor.has(agentId)) return
    this.#dispatchedFor.add(agentId)

    try {
      const idxPathReviewer = (this.#sessionId && this.#opts.workingDirectory)
        ? getIndexPath(this.#sessionId, this.#opts.workingDirectory)
        : null

      // Get the actual diff to give reviewer concrete evidence instead of just the narrative
      let gitDiff = ''
      try {
        const { execSync } = await import('child_process')
        const diffStat = execSync('git diff HEAD~1 HEAD --stat 2>/dev/null', { cwd: this.#opts.workingDirectory, timeout: 5000 }).toString().trim()
        const diff = execSync('git diff HEAD~1 HEAD 2>/dev/null', { cwd: this.#opts.workingDirectory, timeout: 5000 }).toString().trim()
        gitDiff = diffStat ? `\n\n<git_diff_stat>\n${diffStat}\n</git_diff_stat>\n\n<git_diff>\n${diff.slice(0, 6000)}\n</git_diff>` : ''
      } catch {
        // non-fatal: if git fails, proceed without diff
      }

      const prompt = [
        'Use the reviewer sub-agent to review this writer output for correctness/spec-adherence/obvious bugs.',
        'The git diff is provided below — use it as the authoritative source of what changed.',
        'End your reply with exactly `VERDICT: ACCEPT` or `VERDICT: REJECT`.',
        ...(idxPathReviewer ? [`The session index is at ${idxPathReviewer} — you MUST read it before reviewing.`] : []),
        gitDiff,
        '',
        '<writer_output>',
        writerOutput.slice(0, 6000),
        '</writer_output>',
      ].join('\n')

      // Do NOT pass agents here — the reviewer must be review-only and must not
      // be able to spawn writer/researcher/reasoner sub-agents. Passing an empty
      // agents roster prevents any SubagentStop(agent_type==='writer') from
      // firing inside this one-shot query and re-arming the backstop loop.
      const reviewerOptions: Options = {
        cwd: this.#opts.workingDirectory,
        permissionMode: 'default',
        systemPrompt: NAMED_AGENTS.reviewer.prompt,
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'],
        hooks: {
          PreToolUse: [
            {
              matcher: '.*',
              hooks: [async (input: any) => {
                const toolName = input?.tool_name || 'unknown'
                const toolInput = input?.tool_input || {}
                emitter.emit('tool_use', { name: toolName, input: toolInput, agentRole: 'reviewer' })
                return {}
              }],
            },
            {
              matcher: '.*',
              hooks: [async (input: any) => {
                const toolName = input?.tool_name || ''
                const toolInput = input?.tool_input
                if (
                  (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') &&
                  !/\.(md|markdown|mdx|txt|rst|adoc)$/i.test(String(toolInput?.file_path))
                ) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                    },
                    reason: 'reviewer may only write documentation files (.md/.markdown/.mdx/.txt/.rst/.adoc)',
                  }
                }
                return {}
              }],
            },
          ],
          PostToolUse: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              const toolName = input?.tool_name || 'unknown'
              const toolInput = input?.tool_input || {}
              const toolResponse = input?.tool_response
              emitter.emit('tool_result', { name: toolName, input: toolInput, response: toolResponse, agentRole: 'reviewer' })
              return {}
            }],
          }],
        },
      }

      console.log(`[DISPATCH] spawning reviewer for agentId=${agentId.slice(0, 8)}`)
      const reviewerQuery = query({ prompt, options: reviewerOptions })
      this.#activeQueries.add(reviewerQuery)
      this.#activeQueriesById.set(agentId, reviewerQuery)

      let reviewerText = ''
      try {
        for await (const msg of reviewerQuery) {
          const m = msg as any
          if (m.type === 'result' && m.result) {
            reviewerText = String(m.result)
          }
        }
      } finally {
        this.#activeQueries.delete(reviewerQuery)
        this.#activeQueriesById.delete(agentId)
      }

      const verdictMatch = reviewerText.match(/VERDICT:\s*(ACCEPT|REJECT)/i)
      const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : null

      if (verdict === 'REJECT') {
        console.log(`[DISPATCH] review REJECT for agentId=${agentId.slice(0, 8)}`)
        statusManager.upsertDispatch(agentId, { dispatchState: 'rejected', artifact: reviewerText })
        emitter.emit('dispatch_rejected', { tuid: agentId, verdict: 'REJECT', review: reviewerText })
      } else {
        console.log(`[DISPATCH] review ACCEPT for agentId=${agentId.slice(0, 8)}`)
      }
    } catch (err) {
      console.error('[DISPATCH] reviewer spawn failed (non-fatal):', err)
    }
  }

  /**
   * Dispatcher v1 — research gate: vet a researcher sub-agent's output before
   * it reaches the main agent. Emits dispatch_rejected with verdict 'NEEDS-MORE'
   * (distinct from reviewer's 'REJECT') so the frontend can tell them apart.
   */
  async spawnResearchGate(agentId: string, researchOutput: string, emitter: EventEmitter): Promise<void> {
    // Dedup guard — SubagentStop may fire more than once for the same agent_id.
    if (this.#dispatchedFor.has(agentId)) return
    this.#dispatchedFor.add(agentId)

    try {
      const idxPathGate = (this.#sessionId && this.#opts.workingDirectory)
        ? getIndexPath(this.#sessionId, this.#opts.workingDirectory)
        : null

      const prompt = [
        'Use the reasoner sub-agent to vet this research output.',
        'Determine whether the research is sufficient to answer the original question.',
        'End your reply with exactly `GATE: PASS` or `GATE: NEEDS-MORE`.',
        ...(idxPathGate ? [`The session index is at ${idxPathGate} — you MUST read it before reviewing.`] : []),
        '',
        '<research_output>',
        researchOutput.slice(0, 8000),
        '</research_output>',
      ].join('\n')

      // Do NOT pass agents here — the research-gate reasoner must be review-only
      // and must not be able to spawn sub-agents. Same rationale as spawnReviewer:
      // an agents roster would allow delegation back to the writer, which would
      // fire SubagentStop(agent_type==='writer') and re-arm the backstop.
      const gateOptions: Options = {
        cwd: this.#opts.workingDirectory,
        permissionMode: 'default',
        systemPrompt: NAMED_AGENTS.reasoner.prompt,
        hooks: {
          PreToolUse: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              const toolName = input?.tool_name || 'unknown'
              const toolInput = input?.tool_input || {}
              emitter.emit('tool_use', { name: toolName, input: toolInput, agentRole: 'reasoner' })
              return {}
            }],
          }],
          PostToolUse: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              const toolName = input?.tool_name || 'unknown'
              const toolInput = input?.tool_input || {}
              const toolResponse = input?.tool_response
              emitter.emit('tool_result', { name: toolName, input: toolInput, response: toolResponse, agentRole: 'reasoner' })
              return {}
            }],
          }],
        },
      }

      console.log(`[DISPATCH] spawning research-gate for agentId=${agentId.slice(0, 8)}`)
      const gateQuery = query({ prompt, options: gateOptions })
      this.#activeQueries.add(gateQuery)
      this.#activeQueriesById.set(agentId, gateQuery)

      let review = ''
      try {
        for await (const msg of gateQuery) {
          const m = msg as any
          if (m.type === 'result' && m.result) {
            review = String(m.result)
          }
        }
      } finally {
        this.#activeQueries.delete(gateQuery)
        this.#activeQueriesById.delete(agentId)
      }

      const gateMatch = review.match(/GATE:\s*(PASS|NEEDS-MORE)/i)
      const gateVerdict = gateMatch ? gateMatch[1].toUpperCase() : null

      if (gateVerdict === 'NEEDS-MORE') {
        console.log(`[DISPATCH] research-gate NEEDS-MORE for agentId=${agentId.slice(0, 8)}`)
        statusManager.upsertDispatch(agentId, { dispatchState: 'rejected', artifact: review })
        emitter.emit('dispatch_rejected', { tuid: agentId, verdict: 'NEEDS-MORE', review })
      } else {
        console.log(`[DISPATCH] research-gate PASS for agentId=${agentId.slice(0, 8)}`)
      }
    } catch (err) {
      console.error('[DISPATCH] research-gate spawn failed (non-fatal):', err)
    }
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortController,
  }: {
    chatCtx: llm.ChatContext
    toolCtx?: llm.ToolContext
    connOptions?: APIConnectOptions
    parallelToolCalls?: boolean
    toolChoice?: llm.ToolChoice
    extraKwargs?: Record<string, unknown>
    abortController?: AbortController
  }): llm.LLMStream {
    return new ClaudeLLMStream(this, {
      chatCtx,
      toolCtx,
      connOptions,
      opts: this.#opts,
      sessionId: this.#sessionId,
      abortController,
      onSessionId: (id) => {
        const isFirst = !this.#sessionId
        this.#sessionId = id
        if (isFirst) {
          this.#eventEmitter.emit('session_id', { sessionId: id })
        }
      },
      eventEmitter: this.#eventEmitter,
      // Pass checkpoint capture handler
      onCheckpoint: (checkpointId: string) => {
        this.captureCheckpoint(checkpointId)
      },
      // Pass permission handler for canUseTool callback
      onPermissionRequest: (toolName: string, input: Record<string, unknown>) => {
        type PermResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }
        return new Promise<PermResult>((resolve) => {
          this.#pendingPermission = { toolName, input, resolve }
          console.log(`⚠️ Permission request: ${toolName}`)
          this.#eventEmitter.emit('permission_request', { toolName, input })
        })
      },
    })
  }
}

// Permission result type matching Claude Agent SDK
type PermissionResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }

/**
 * Claude LLM Stream - Runs Claude Agent SDK query() and streams results
 */
class ClaudeLLMStream extends llm.LLMStream {
  #opts: ClaudeLLMOptions
  #sessionId: string | null
  #onSessionId: (id: string) => void
  #eventEmitter: EventEmitter
  #onPermissionRequest: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>
  #onCheckpoint: (checkpointId: string) => void
  #abortController?: AbortController
  #llmRef: ClaudeLLM
  #approvedWriterToolUseIds = new Set<string>()

  constructor(
    llmInstance: ClaudeLLM,
    {
      chatCtx,
      toolCtx,
      connOptions,
      opts,
      sessionId,
      onSessionId,
      eventEmitter,
      onCheckpoint,
      onPermissionRequest,
      abortController,
    }: {
      chatCtx: llm.ChatContext
      toolCtx?: llm.ToolContext
      connOptions: APIConnectOptions
      opts: ClaudeLLMOptions
      sessionId: string | null
      onSessionId: (id: string) => void
      eventEmitter: EventEmitter
      onCheckpoint: (checkpointId: string) => void
      onPermissionRequest: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>
      abortController?: AbortController
    },
  ) {
    super(llmInstance, { chatCtx, toolCtx, connOptions })
    this.#llmRef = llmInstance
    this.#opts = opts
    this.#sessionId = sessionId
    this.#onSessionId = onSessionId
    this.#eventEmitter = eventEmitter
    this.#onCheckpoint = onCheckpoint
    this.#onPermissionRequest = onPermissionRequest
    this.#abortController = abortController
  }

  protected async run(): Promise<void> {
    const requestId = `claude_${shortuuid()}`
    let activeQuery: any = null

    try {
      // Extract user's message from chat context
      // ChatContext has .items which are ChatItem[] (ChatMessage | FunctionCall | FunctionCallOutput)
      const items = this.chatCtx.items

      // Find the last user message
      let userText = ''
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i] as any
        if (item.type === 'message' && item.role === 'user') {
          // Content is ChatContent[] = (ImageContent | AudioContent | string)[]
          if (Array.isArray(item.content)) {
            userText = item.content
              .filter((c: any) => typeof c === 'string')
              .join('\n')
          }
          break
        }
      }

      if (!userText.trim()) {
        this.queue.put({
          id: requestId,
          delta: { role: 'assistant', content: "I didn't catch that. Could you repeat?" },
        })
        return
      }

      console.log(`🎤 User (${userText.length} chars): "${userText}"`)

      // Build Claude Agent SDK options
      const resumeSessionId = this.#opts.resumeSessionId
      const continueSession = this.#opts.continueSession

      // Session workspace path for system prompt — lives under ~/.claude/projects/{slug}/osb/{sessionId}/
      const sessionId = this.#sessionId || this.#opts.resumeSessionId || null
      const workspacePath = sessionId && this.#opts.workingDirectory
        ? getSessionWorkspace(this.#opts.workingDirectory, sessionId)
        : null

      const allowedTools = this.#opts.allowedTools || []

      const sdkOptions: Options = {
        cwd: this.#opts.workingDirectory,
        permissionMode: this.#opts.permissionMode,
        allowedTools,
        // model: this.#opts.model || 'haiku', // haiku for speed with limited tools, sonnet for full research capabilities (including tool use trace in response)
        model: this.#opts.model || 'claude-opus-4-8[1m]', // Opus 4.8 + [1m] → 1M context (see get model() note); prevents ~153k early compaction
        enableFileCheckpointing: true,
        settingSources: ['project', 'user'],
        extraArgs: { 'replay-user-messages': null },
        ...(this.#abortController && { abortController: this.#abortController }),
        ...(resumeSessionId && { resume: resumeSessionId }),
        ...(continueSession && !resumeSessionId && { continue: true }),
        ...(this.#sessionId && !resumeSessionId && !continueSession && { resume: this.#sessionId }),
        // System prompt — direct mode gets speech-optimized prompt, realtime gets structured research prompt
        // Skills from agent/.claude/skills/ are appended if present
        systemPrompt: [
          this.#opts.voiceMode === 'direct'
            ? getDirectModeResearchPrompt(workspacePath)
            : getResearchSystemPrompt(workspacePath),
          loadAllSkills(this.#opts.sessionBaseDir || this.#opts.workingDirectory || process.cwd()),
        ].filter(Boolean).join('\n\n'),
        canUseTool: async (toolName, input, _options) => {
          // Auto-approve Bash calls to the agent's OWN local API (/canvas,
          // /tts) — how the agent SPEAKS into a meeting. A spoken reply must
          // never wait on a permission dialog. Localhost-only, own endpoints
          // only, no shell chaining — not a general curl allowance.
          if ((toolName as string) === 'Bash') {
            const cmd = String((input as any)?.command || '')
            if (/^\s*curl\b[^;&|]*https?:\/\/(localhost|127\.0\.0\.1):\d+\/(canvas|tts)\b/.test(cmd) && !/[;&|]/.test(cmd)) {
              console.log(`✅ Auto-approved Bash → own API (canvas/tts speak path)`)
              return { behavior: 'allow', updatedInput: input }
            }
          }
          // Auto-approve writes to session workspace (but block spec.md and library/ — fast brain manages those)
          if (toolName === 'Write' || toolName === 'Edit') {
            const filePath = String(input?.file_path || '')
            const agentType = input?.agent_type || null
            const toolUseId = (_options as any)?.toolUseID
              const toolInput = input?.tool_input || {}
              console.log('input,', input, 'input.file_path', filePath, 'agent_type', agentType)
            console.log(`🔍 canUseTool: ${toolName} filePath="${filePath}" keys=${Object.keys(input || {}).join(',')}`)
            console.log(`🔍 canUseTool _options keys=[${Object.keys(_options || {}).join(', ')}] title="${(_options as any)?.title || ''}" decisionReason="${(_options as any)?.decisionReason || ''}" blockedPath="${(_options as any)?.blockedPath || ''}"`)
            if (filePath.includes('/osb/') || filePath.includes('.osborn/sessions/') || filePath.includes('.osborn/research/')) {
              // Block writes to spec.md — the fast brain manages it
              const fileName = filePath.split('/').pop() || ''
              if (fileName === 'spec.md') {
                console.log(`🚫 Blocked research agent write to managed file: ${filePath} (fast brain handles spec.md)`)
                return { behavior: 'deny', message: 'spec.md is managed by the fast brain. Do NOT write to it. Return your findings in your response text — the fast brain will organize them into spec.md automatically.' }
              }
              console.log(`✅ Auto-approved ${toolName} to workspace: ${filePath}`)
              return { behavior: 'allow', updatedInput: input }
            }
            // Auto-approve writer sub-agent writes to skill installation directories.
            // Pattern matches `.claude/skills/<skillname>/<file>` in any osborn install location
            // (npm global, dev tree, cloud sandbox), so installing a multi-file skill via the
            // writer agent doesn't blow up into a per-file permission cascade.
            // Requires agent_type === 'writer' — main/researcher/reasoner are blocked by PreToolUse
            // before they ever reach canUseTool, so this check is the only path that lets a
            // skill install through silently.
            if (agentType === 'writer' && /\/\.claude\/skills\/[^/]+\//.test(filePath)) {
              console.log(`✅ Auto-approved writer ${toolName} to skill dir: ${filePath}`)
              return { behavior: 'allow', updatedInput: input }
            }
            // Auto-approve the meetings skill's notes file. It lives at the
            // WORKING DIRECTORY root (not /osb/), so it missed the workspace
            // auto-approve — every meeting notes write stalled the turn behind
            // a permission dialog nobody in a live meeting can answer (found
            // live 2026-08-01: addressed replies froze >30s, bot went silent).
            if (/(^|\/)meeting-(todos|notes)\.md$/.test(filePath)) {
              console.log(`✅ Auto-approved ${toolName} to meeting notes: ${filePath}`)
              return { behavior: 'allow', updatedInput: input }
            }
            // if (toolUseId && this.#approvedWriterToolUseIds.has(toolUseId)) {
            //   this.#approvedWriterToolUseIds.delete(toolUseId)
            //   console.log(`✅ Writer pre-approved ${toolName}: ${filePath}`)
            //   return { behavior: 'allow', updatedInput: input }
            // }
          }
          // Auto-approve AskUserQuestion — research agent should freely ask clarifying questions
          if (toolName === 'AskUserQuestion') {
            console.log(`✅ Auto-approved ${toolName}`)
            return { behavior: 'allow', updatedInput: input }
          }
          // Auto-deny tools the research agent should never use
          if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') {
            console.log(`🚫 Auto-denied ${toolName} (not used in research mode)`)
            return { behavior: 'deny', message: 'Research mode does not use plan mode. Just proceed with the research directly.' }
          }
          
          console.log(`⚠️ Permission needed: ${toolName}`)
          return this.#onPermissionRequest(toolName, input)
        },
        hooks: {
          PreToolUse: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              const toolName = input?.tool_name || 'unknown'
              const toolInput = input?.tool_input || {}
              const agentType = input?.agent_type || null
              console.log(`🔍 PreToolUse: toolName=${toolName} agent_type=${agentType} agent_id=${(input as any)?.agent_id || 'none'} all_keys=[${Object.keys(input || {}).join(', ')}]`)

              // ≤3 direct tool call budget enforcement.
              // Only counts calls from the MAIN orchestrator agent (agent_type === null).
              // Task/Agent delegations are exempt — delegation is the desired behavior.
              // Sub-agent tool calls are exempt — they're inside a delegation.
              if (!agentType && toolName !== 'Task' && toolName !== 'Agent') {
                turnToolCallCount++
                if (turnToolCallCount > TOOL_CALL_BUDGET) {
                  console.log(`🛑 Tool budget exceeded (${turnToolCallCount}/${TOOL_CALL_BUDGET}) — DENYING ${toolName}. Must delegate via Task.`)
                  this.#eventEmitter.emit('tool_blocked', { name: toolName, reason: `Tool call budget exceeded (${turnToolCallCount}/${TOOL_CALL_BUDGET}). Delegate via Task.` })
                  return {
                    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
                    reason: `Hard limit: maximum ${TOOL_CALL_BUDGET} direct tool calls per turn (you are at ${turnToolCallCount}). Delegate the remaining work to a sub-agent via Task(subagent_type=\'researcher\'|\'writer\'|\'reasoner\', run_in_background: true). This is a system-enforced limit.`,
                  }
                }
                console.log(`🔧 Tool call ${turnToolCallCount}/${TOOL_CALL_BUDGET}: ${toolName}`)
              }

              // Write/Edit/MultiEdit access control
              if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
                // Writer sub-agent gets full write access everywhere
                console.log('verifying agent_type', agentType)
                // Writer agent: no longer auto-approved — falls through to canUseTool for permission dialog
                if (agentType === 'writer') {
                  console.log(`✍️ Writer agent: deferring to canUseTool for permission`)
                  this.#eventEmitter.emit('tool_use', { name: toolName, input: toolInput, agentRole: agentType || 'main' })
                  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }
                }

                // Reviewer agent: ONLY documentation-extension files allowed — fail closed
                if (agentType === 'reviewer') {
                  const reviewerPath = String(toolInput.file_path || '')
                  const DOC_EXTENSIONS = /\.(md|markdown|mdx|txt|rst|adoc)$/i
                  if (!reviewerPath || !DOC_EXTENSIONS.test(reviewerPath)) {
                    const reason = reviewerPath
                      ? `Reviewer write denied: ${reviewerPath} is not a documentation file (.md/.markdown/.mdx/.txt/.rst/.adoc). Reviewer may only write documentation.`
                      : 'Reviewer write denied: could not determine target file path. Failing closed.'
                    console.log(`🚫 Reviewer write blocked: ${reviewerPath || '(no path)'} — not a doc extension`)
                    this.#eventEmitter.emit('tool_blocked', { name: toolName, reason })
                    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' }, reason }
                  }
                  console.log(`📝 Reviewer doc write allowed: ${reviewerPath}`)
                  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }
                }

                // Tester agent: ONLY test files allowed — fail closed
                if (agentType === 'tester') {
                  const testerPath = String(toolInput.file_path || '')
                  const STRICT_TEST_FILE = /\.(test|spec)\.[jt]sx?$/
                  const resolvedBase = testerPath ? basename(resolve(testerPath)) : ''
                  if (!testerPath || !STRICT_TEST_FILE.test(resolvedBase)) {
                    const reason = testerPath
                      ? `Tester write denied: ${testerPath} is not a test file (basename must match .test.ts/tsx/js/jsx or .spec.ts/tsx/js/jsx). Tester may only write test files.`
                      : 'Tester write denied: could not determine target file path. Failing closed.'
                    console.log(`🚫 Tester write blocked: ${testerPath || '(no path)'} — not a test file`)
                    this.#eventEmitter.emit('tool_blocked', { name: toolName, reason })
                    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' }, reason }
                  }
                  console.log(`🧪 Tester test-file write allowed: ${testerPath}`)
                  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }
                }

                // All other agents (main, researcher, reasoner, etc.): workspace only
                const filePath = String(toolInput.file_path || '')
                if (filePath && !filePath.includes('/osb/') && !filePath.includes('.osborn/sessions/') && !filePath.includes('.osborn/research/')) {
                  console.log(`🚫 Research mode: blocked write to ${filePath} (agent_type: ${agentType ?? 'main'})`)
                  this.#eventEmitter.emit('tool_blocked', { name: toolName, reason: 'Research mode: writes restricted to session workspace' })
                  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' }, reason: 'Research mode: writes restricted to session workspace.' }
                }
              }

              console.log(`🔧 Claude: ${toolName}`)
              this.#eventEmitter.emit('tool_use', { name: toolName, input: toolInput, agentRole: agentType || 'main' })
              return {}
            }]
          }],
          PostToolUse: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              const toolName = input?.tool_name || 'unknown'
              const toolInput = input?.tool_input || {}
              const toolResponse = input?.tool_response  // Capture actual tool output for fast brain processing
              const agentTypePost = input?.agent_type || null
              console.log(`✅ Done: ${toolName}`)
              if (toolName === 'Task' || toolName === 'Agent') {
                const agentId = input?.tool_input?.agent_id ?? input?.tool_input?.id ?? undefined
                console.log('[LIFECYCLE-PROBE] PostToolUse on', toolName, 'agent_id=', agentId, 'ts=', Date.now())
              }
              this.#eventEmitter.emit('tool_result', { name: toolName, input: toolInput, response: toolResponse, agentRole: agentTypePost || 'main' })
              return {}
            }]
          }],
          // Per-turn behavioral re-anchor. Fires on EVERY user message that reaches Claude
          // (initial requests, follow-ups, mid-flight steering, resumed-session messages).
          // Reads the reminder text from disk every call, so it's hot-editable just like the
          // main prompt — edit agent/src/prompts/turn-shape-reminder.md, reconnect, next message
          // sees the new reminder. The SDK injects `additionalContext` alongside the user's actual
          // message so the model sees both the literal user input AND the reminder, weighing them
          // together. This is what fights JSONL-history-overrides-system-prompt drift on resumed
          // sessions: the conductor pattern gets re-asserted on every turn instead of being
          // anchored only at session-init time.
          UserPromptSubmit: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              try {
                // Reset the per-turn tool call counter so the new turn starts fresh.
                turnToolCallCount = 0

                const reminder = readFileSync(TURN_SHAPE_REMINDER_PATH, 'utf-8')
                const promptPreview = String(input?.prompt || '').substring(0, 60).replace(/\n/g, ' ')
                console.log(`📌 UserPromptSubmit: injected turn-shape reminder (${reminder.length} chars) for prompt="${promptPreview}..." [tool budget reset to 0/${TOOL_CALL_BUDGET}]`)
                return {
                  hookSpecificOutput: {
                    hookEventName: 'UserPromptSubmit',
                    additionalContext: reminder,
                  },
                }
              } catch (err) {
                console.error('⚠️ UserPromptSubmit: failed to load turn-shape-reminder.md:', err instanceof Error ? err.message : err)
                return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } }
              }
            }]
          }],
          // ── PreCompact: inject extraction instruction only ──
          // Fires before the SDK compresses the conversation. Injects the compact-learnings
          // instruction so the SDK compaction summary includes the four structured sections.
          // Skill extraction happens in PostCompact, which reads input.compact_summary directly.
          PreCompact: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              try {
                this.#opts.onCompactionEvent?.({ type: 'compaction_started', trigger: input?.trigger })

                const instructionPath = join(__claudeLlmDir, 'prompts', 'compact-learnings-instruction.md')
                const instruction = existsSync(instructionPath) ? readFileSync(instructionPath, 'utf-8') : ''

                console.log(`🧠 PreCompact: injecting instruction (${instruction.length} chars, trigger=${input?.trigger || 'unknown'})`)
                return { systemMessage: instruction }

              } catch (err) {
                console.error('⚠️ PreCompact hook error:', err instanceof Error ? err.message : err)
                return {}
              }
            }]
          }],
          // ── PostCompact: parse compact_summary from stdin payload and persist skill sections ──
          // input.compact_summary is the full summary text the SDK just wrote.
          // We read the four sections directly from it — no JSONL file access needed.
          PostCompact: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              try {
                const summary: string = input?.compact_summary || ''
                const { mkdirSync, writeFileSync: writeSyncFs, readFileSync: readSyncFs, existsSync: existsSyncFs } = await import('node:fs')
                const skillDir = homedir()
                const today = new Date().toISOString().split('T')[0]
                const sessionId = this.#sessionId || 'unknown'
                let skillsWritten = 0
                const skillNames: string[] = []
                // Emit fine-grained progress events so the UI can render a multi-step
                // "crystallizing..." panel instead of a single 3-second flash. Each
                // stage gets a human-readable label + optional detail (skill name,
                // char counts) so the user sees something happening through the whole
                // ~3 minute compaction window.
                const progress = (stage: string, detail?: string) => {
                  this.#opts.onCompactionEvent?.({ type: 'compaction_progress', stage, detail })
                }

                progress('Reading compact summary', `${summary.length} chars`)

                // Helper: extract text between a marker and the next === marker (or end of string)
                const extractSection = (marker: string): string => {
                  const idx = summary.indexOf(marker)
                  if (idx === -1) return ''
                  const start = idx + marker.length
                  const nextMarker = summary.indexOf('=== ', start)
                  return (nextMarker === -1 ? summary.substring(start) : summary.substring(start, nextMarker)).trim()
                }

                // ── Section 1: HANDOFF_STATE — stays in compact summary only, not written to disk ──
                const handoff = extractSection('=== HANDOFF_STATE ===')
                if (handoff) {
                  console.log(`🧠 PostCompact: HANDOFF_STATE present (${handoff.length} chars) — not written to disk`)
                  progress('Parsed handoff state', `${handoff.length} chars`)
                }

                // ── Section 2: DECISIONS — append project-scoped decisions ──
                try {
                  const decisions = extractSection('=== DECISIONS ===')
                  if (decisions) {
                    const projectLines = decisions
                      .split('\n')
                      .filter(l => /DECISION:.*SCOPE:\s*project/i.test(l))
                    if (projectLines.length) {
                      progress('Extracting decisions', `${projectLines.length} project-scoped`)
                      const decFolder = join(skillDir, '.claude', 'skills', 'decisions')
                      const decPath = join(decFolder, 'SKILL.md')
                      mkdirSync(decFolder, { recursive: true })
                      const existing = existsSyncFs(decPath) ? readSyncFs(decPath, 'utf-8') : ''
                      const header = existing ? '' : `# Project Decisions\n\nAuto-extracted from compact summaries.\n\n`
                      const entry = `\n## ${today} (session ${sessionId.substring(0, 8)})\n${projectLines.join('\n')}\n`
                      writeSyncFs(decPath, header + existing + entry, 'utf-8')
                      console.log(`🧠 PostCompact: appended ${projectLines.length} decision(s) to ${decPath}`)
                      skillsWritten++
                      skillNames.push('decisions')
                      progress('Wrote skill', 'decisions')
                    }
                  }
                } catch (decErr) {
                  console.error('⚠️ PostCompact: DECISIONS write failed:', decErr instanceof Error ? decErr.message : decErr)
                }

                // ── Section 3: SKILL_CANDIDATES — parse individual blocks and write each ──
                try {
                  const skillsSection = extractSection('=== SKILL_CANDIDATES ===')
                  if (skillsSection) {
                    const skillBlockRe = /---\s*SKILL:\s*([^\n-]+?)\s*---\n([\s\S]*?)---\s*END SKILL\s*---/g
                    const nameRe = /^[a-z][a-z0-9-]{1,39}$/
                    let match: RegExpExecArray | null
                    while ((match = skillBlockRe.exec(skillsSection)) !== null) {
                      const name = match[1].trim()
                      const body = match[2].trim()
                      if (!nameRe.test(name)) {
                        console.warn(`⚠️ PostCompact: skipping skill with invalid name "${name}" (must match /^[a-z][a-z0-9-]{1,39}$/)`)
                        continue
                      }
                      const skillFolder = join(skillDir, '.claude', 'skills', name)
                      const skillPath = join(skillFolder, 'SKILL.md')
                      mkdirSync(skillFolder, { recursive: true })
                      const header = `# ${name}\nAuto-extracted: ${today} | Session: ${sessionId.substring(0, 8)}\n\n`
                      writeSyncFs(skillPath, header + body + '\n', 'utf-8')
                      console.log(`🧠 PostCompact: wrote skill '${name}' to ${skillPath}`)
                      skillsWritten++
                      skillNames.push(name)
                      progress('Wrote skill', name)
                    }
                  }
                } catch (skillErr) {
                  console.error('⚠️ PostCompact: SKILL_CANDIDATES write failed:', skillErr instanceof Error ? skillErr.message : skillErr)
                }

                // ── Section 4: BEHAVIORAL_LEARNINGS — write to learned-behaviors/SKILL.md ──
                try {
                  const learnings = extractSection('=== BEHAVIORAL_LEARNINGS ===')
                  if (learnings.length >= 30) {
                    progress('Extracting learnings', `${learnings.length} chars`)
                    const skillFolder = join(skillDir, '.claude', 'skills', 'learned-behaviors')
                    const skillPath = join(skillFolder, 'SKILL.md')
                    mkdirSync(skillFolder, { recursive: true })
                    const header = `# Learned Behaviors\n\nAuto-extracted from voice sessions via PostCompact.\nLast updated: ${today} | Session: ${sessionId.substring(0, 8)}...\n\n`
                    writeSyncFs(skillPath, header + learnings + '\n', 'utf-8')
                    console.log(`🧠 PostCompact: wrote learned behaviors to ${skillPath} (${learnings.length} chars)`)
                    skillsWritten++
                    skillNames.push('learned-behaviors')
                    progress('Wrote skill', 'learned-behaviors')
                  } else {
                    console.log('🧠 PostCompact: no BEHAVIORAL_LEARNINGS section found or too short — skipping')
                  }
                } catch (blErr) {
                  console.error('⚠️ PostCompact: BEHAVIORAL_LEARNINGS write failed:', blErr instanceof Error ? blErr.message : blErr)
                }

                // ── Section 5: USER_CONTEXT — merge into user-context/CONTEXT.md ──
                // Passive UX: agent learns the user's language automatically after every
                // compaction. No explicit "grill me" command needed. The compact summary
                // captures vocabulary/style observations confirmed during the session.
                try {
                  const userCtx = extractSection('=== USER_CONTEXT ===')
                  const hasContent = userCtx.length >= 30 && !userCtx.includes('(none this session)')
                  if (hasContent) {
                    progress('Updating user context', `${userCtx.length} chars`)
                    const ctxFolder = join(skillDir, '.claude', 'skills', 'user-context')
                    const ctxPath = join(ctxFolder, 'CONTEXT.md')
                    mkdirSync(ctxFolder, { recursive: true })

                    // Append new observations to existing CONTEXT.md under a dated section.
                    // The grill-me skill can consolidate/clean up on explicit request.
                    const existing = existsSyncFs(ctxPath) ? readSyncFs(ctxPath, 'utf-8') : '# User Context\n\n'
                    const entry = `\n## Observations — ${today} (session ${sessionId.substring(0, 8)})\n\n${userCtx}\n`
                    writeSyncFs(ctxPath, existing + entry, 'utf-8')
                    console.log(`🧠 PostCompact: updated user context at ${ctxPath}`)
                    skillsWritten++
                    skillNames.push('user-context')
                    progress('Wrote skill', 'user-context')
                  } else {
                    console.log('🧠 PostCompact: no USER_CONTEXT observations this session — skipping')
                  }
                } catch (ucErr) {
                  console.error('⚠️ PostCompact: USER_CONTEXT write failed:', ucErr instanceof Error ? ucErr.message : ucErr)
                }

                this.#opts.onCompactionEvent?.({ type: 'compaction_complete', skillsWritten, skillNames })
                console.log(`🧠 PostCompact: complete — ${skillsWritten} skill file(s) written: [${skillNames.join(', ')}]`)

              } catch (err) {
                console.error('⚠️ PostCompact hook error:', err instanceof Error ? err.message : err)
              }
              return {}
            }]
          }],
          SubagentStart: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              console.log('[LIFECYCLE-PROBE] SubagentStart', JSON.stringify(input))
              this.#eventEmitter.emit('agent_started', { agent_type: input?.agent_type, agent_id: input?.agent_id })
              return {}
            }]
          }],
          SubagentStop: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              console.log('[LIFECYCLE-PROBE] SubagentStop', JSON.stringify(input))
              const at = input?.agent_type
              const msg = String(input?.last_assistant_message ?? '')
              const aid = input?.agent_id ?? ('sa-' + Date.now())
              statusManager.upsertDispatch(aid, { subagentType: at, dispatchState: 'completed', artifact: msg })
              this.#eventEmitter.emit('task_completed', { agent_type: at, agent_id: aid, last_assistant_message: String(msg).slice(0, 400) })
              // Infinite-loop guard — never re-dispatch the reviewer or reasoner.
              if (at === 'reviewer' || at === 'reasoner') return {}
              if (at === 'writer' && msg) {
                void this.#llmRef.spawnReviewer(aid, msg, this.#eventEmitter)
              } else if (at === 'researcher' && msg) {
                void this.#llmRef.spawnResearchGate(aid, msg, this.#eventEmitter)
              }
              return {}
            }]
          }],
          TaskCreated: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              console.log('[LIFECYCLE-PROBE] TaskCreated', JSON.stringify(input))
              return {}
            }]
          }],
          TaskCompleted: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              console.log('[LIFECYCLE-PROBE] TaskCompleted', JSON.stringify(input))
              return {}
            }]
          }]
        },
        // Named sub-agents — the orchestrator delegates to these specialists.
        // Built-in definitions live at module level (NAMED_AGENTS); per-user
        // DB-backed definitions (opts.agents, via set_agents) take precedence.
        agents: this.#opts.agents ?? NAMED_AGENTS,
      }

      // Run Claude Agent SDK query() and stream results
      let hasOutput = false
      let fullResponse = '' // Collect full response for frontend
      // Per-turn read-along tracking (non-skipTTSQueue path)
      let streamTurnMessageId: string | null = null
      let streamTurnChunkIndex = 0
      let streamTurnChunks: string[] = []

      // DIRECT MODE OPTIMIZATION: When skipTTSQueue is true, we run the Claude query
      // in the background and return from run() immediately. This is critical because:
      //
      // LiveKit's main speech loop (agent_activity.ts) processes one SpeechHandle at a time.
      // The LLM's SpeechHandle blocks the queue until run() returns (which closes the queue
      // → pipeline completes → _markGenerationDone()). If we await the full query() here,
      // the pipeline is blocked for the entire duration of tool execution (10-30s).
      // Meanwhile, session.say() SpeechHandles queue up but can't play.
      //
      // By returning early, the pipeline completes in milliseconds. The say() handles
      // created by tts_say events get processed by the main loop immediately.
      // The query continues in the background — text arrives via tts_say, tools via hooks.
      if (this.#opts.skipTTSQueue) {
        // PERSISTENT SESSION: Push message to existing subprocess (no JSONL replay).
        // First call creates the query (cold start). Subsequent calls are instant.
        // The background consumer in ClaudeLLM handles all message routing (TTS, tools, etc.)
        this.#llmRef.pushMessage(userText, sdkOptions, {
          onSessionId: this.#onSessionId,
          onCheckpoint: this.#onCheckpoint,
          eventEmitter: this.#eventEmitter,
        })

        // Return immediately — queue closes, pipeline completes, say() handles play
        console.log('🚀 Direct mode: Claude query running in background, pipeline released')
        return
      }

      // Store active query for interrupt/rewind access
      activeQuery = query({ prompt: userText, options: sdkOptions })
      this.#llmRef.setActiveQuery(activeQuery)

      for await (const message of activeQuery) {
        // Capture session ID for context continuity
        if ((message as any).type === 'system' && (message as any).subtype === 'init') {
          // Log MCP server connection status
          const mcpServers = (message as any).mcp_servers
          if (mcpServers && Array.isArray(mcpServers)) {
            for (const s of mcpServers) {
              const status = s.status === 'connected' ? '✅' : '❌'
              console.log(`${status} MCP server ${s.name}: ${s.status}`)
              if (s.status !== 'connected') {
                console.log(`   🔍 MCP error:`, JSON.stringify(s))
              }
            }
          }
          const newSessionId = (message as any).session_id
          if (newSessionId) {
            this.#onSessionId(newSessionId)
            const isNewSession = !this.#sessionId
            if (isNewSession) {
              console.log(`📋 New session: ${newSessionId}`)
            }
            this.#sessionId = newSessionId

            // Save session metadata for new sessions
            if (isNewSession && this.#opts.workingDirectory) {
              saveSessionMetadata(this.#opts.workingDirectory, {
                sessionId: newSessionId,
                lastUpdated: new Date().toISOString(),
                projectPath: this.#opts.workingDirectory,
              })
            }

            // Verify session resume succeeded (if we requested a specific session)
            const requestedResumeId = this.#opts.resumeSessionId
            if (requestedResumeId && newSessionId !== requestedResumeId) {
              console.error(`❌ Session resume FAILED: Expected ${requestedResumeId.substring(0, 8)}..., got ${newSessionId.substring(0, 8)}...`)
              this.#eventEmitter.emit('session_resume_failed', {
                requestedSessionId: requestedResumeId,
                actualSessionId: newSessionId,
              })
            } else if (requestedResumeId && newSessionId === requestedResumeId) {
              console.log(`✅ Session resumed successfully: ${newSessionId.substring(0, 8)}...`)
            }
          }
        }

        // Capture checkpoint UUIDs from user messages (for file rewind capability)
        // Per SDK docs: user messages include a UUID that can be used as a restore point
        if ((message as any).type === 'user' && (message as any).uuid) {
          const checkpointId = (message as any).uuid
          this.#onCheckpoint(checkpointId)
        }

        // Stream text chunks — send each assistant text block to TTS
        if ((message as any).type === 'assistant' && (message as any).message?.content) {
          // Emit SDK requestId on first assistant message — identifies this query()
          // in the JSONL for tracking which research task produced which output
          const sdkRequestId = (message as any).requestId
          if (sdkRequestId) {
            this.#eventEmitter.emit('query_request_id', { requestId: sdkRequestId })
          }

          // Assign a stable messageId for this turn (first block sets it, rest reuse)
          if (!streamTurnMessageId) {
            streamTurnMessageId = crypto.randomUUID()
            streamTurnChunkIndex = 0
            streamTurnChunks = []
          }

          for (const block of (message as any).message.content) {
            if (block.type === 'text' && block.text) {
              hasOutput = true
              const rawText = block.text
              const chunkIndex = streamTurnChunkIndex

              // Emit RAW text to frontend (for chat bubbles with full formatting)
              this.#eventEmitter.emit('assistant_text', { text: rawText, messageId: streamTurnMessageId, chunkIndex })

              // Strip markdown for clean speech
              const ttsChunk = stripMarkdownForTTS(rawText)
              if (ttsChunk.trim()) {
                streamTurnChunks.push(ttsChunk)
                streamTurnChunkIndex++
                if (this.#opts.skipTTSQueue) {
                  // Direct mode: emit event for session.say() — bypasses LiveKit's
                  // BufferedTokenStream which causes stuck/delayed/out-of-order audio
                  console.log(`🔊 TTS say (${ttsChunk.length} chars): "${ttsChunk}"`)
                  this.#eventEmitter.emit('tts_say', { text: ttsChunk, messageId: streamTurnMessageId, chunkIndex })
                } else {
                  // Realtime mode: use LLM stream queue (framework handles TTS)
                  console.log(`🔊 TTS stream (${ttsChunk.length} chars): "${ttsChunk}"`)
                  this.queue.put({
                    id: requestId,
                    delta: { role: 'assistant', content: ttsChunk },
                  })
                }
              }
            }
          }
        }

        // Final result — only speak if no text blocks were streamed already
        if ((message as any).type === 'result' && (message as any).result) {
          const rawResult = (message as any).result

          // Emit RAW result to frontend
          this.#eventEmitter.emit('assistant_result', { text: rawResult, messageId: streamTurnMessageId })

          // Emit ordered chunk list for frontend read-along
          if (streamTurnMessageId && streamTurnChunks.length > 0) {
            this.#eventEmitter.emit('tts_chunks', { messageId: streamTurnMessageId, chunks: streamTurnChunks })
          }
          // Reset per-turn state
          streamTurnMessageId = null
          streamTurnChunkIndex = 0
          streamTurnChunks = []

          if (!hasOutput) {
            hasOutput = true
            const ttsText = stripMarkdownForTTS(rawResult)
            if (ttsText.trim()) {
              if (this.#opts.skipTTSQueue) {
                console.log(`🔊 TTS say result (${ttsText.length} chars): "${ttsText}"`)
                this.#eventEmitter.emit('tts_say', { text: ttsText })
              } else {
                console.log(`🔊 TTS result (${ttsText.length} chars): "${ttsText}"`)
                this.queue.put({
                  id: requestId,
                  delta: { role: 'assistant', content: ttsText },
                })
              }
            }
          }
        }
      }

      // If Claude produced no output at all, say "Done."
      if (!hasOutput) {
        if (this.#opts.skipTTSQueue) {
          this.#eventEmitter.emit('tts_say', { text: 'Done.' })
        } else {
          this.queue.put({
            id: requestId,
            delta: { role: 'assistant', content: 'Done.' },
          })
        }
      }

      console.log('✅ Claude response complete')

    } catch (error) {
      // AbortError = clean abort (disconnect, new research, recovery) — don't push
      // garbage text that would flow through the post-research pipeline
      if (this.#abortController?.signal.aborted) {
        console.log('🛑 Claude Agent SDK query aborted')
        if (!this.#opts.skipTTSQueue) {
          this.queue.put({ id: requestId, delta: { role: 'assistant', content: '' } })
        }
        return
      }
      console.error('❌ Claude Agent SDK error:', error)
      if (this.#opts.skipTTSQueue) {
        this.#eventEmitter.emit('tts_say', { text: 'Sorry, I encountered an error.' })
      } else {
        this.queue.put({
          id: requestId,
          delta: { role: 'assistant', content: 'Sorry, I encountered an error.' },
        })
      }
    } finally {
      this.#llmRef.removeActiveQuery(activeQuery)
    }
  }
}

/**
 * Create a ClaudeLLM instance
 */
export function createClaudeLLM(opts?: ClaudeLLMOptions): ClaudeLLM {
  return new ClaudeLLM(opts)
}
