/**
 * Prompt-review CLI for Osborn dev-logged sessions.
 *
 * Workflow:
 *   1. Find the newest captured session under `.osborn/dev-logs/`
 *      (or accept a path arg).
 *   2. Extract voice mode + provider from the log via regex.
 *   3. Dynamic-import the current prompts from `../src/prompts.ts` so the
 *      reviewer sees the LATEST version of each prompt (not a snapshot).
 *   4. Extract the pipeline fast-brain `buildSystemPrompt` function source
 *      from `../src/pipeline-fastbrain.ts` (which is module-private and
 *      cannot be dynamic-imported as a value).
 *   5. Build a markdown review brief: session summary + raw log + active
 *      prompts + review task instructions.
 *   6. Size-check — if too large for argv, write the brief to a file and
 *      pass a pointer instead.
 *   7. Spawn `claude` CLI with `stdio: 'inherit'` and `--add-dir agent/src`
 *      so the reviewing Claude can Read / Grep / Edit the prompt files.
 *
 * Usage:
 *   npm run review                       # review the latest log
 *   npm run review <path-to-log-file>    # review a specific log
 *
 * This script is OUT-OF-LOOP from the agent — removing it has zero impact
 * on runtime behavior. Pair with `npm run dev:logged` (scripts/dev-logged.ts)
 * to capture sessions.
 */

import { spawn } from 'node:child_process'
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  writeFileSync,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ============================================================================
// Paths
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url))
// scripts/ is sibling to src/, both under agent/
const agentDir = resolve(__dirname, '..')
const agentSrcDir = join(agentDir, 'src')
const logDir = join(agentDir, '.osborn', 'dev-logs')

// ============================================================================
// Step 1 — find the log file
// ============================================================================

function findLatestLog(): string | null {
  if (!existsSync(logDir)) return null
  const files = readdirSync(logDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => {
      const p = join(logDir, f)
      return { name: f, path: p, mtime: statSync(p).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  return files.length > 0 ? files[0].path : null
}

const argLogPath = process.argv[2]
const logPath = argLogPath ? resolve(argLogPath) : findLatestLog()

if (!logPath) {
  console.error('❌ No dev log found.')
  console.error(`   Run \`npm run dev:logged\` to capture a session first.`)
  console.error(`   Log dir: ${logDir}`)
  process.exit(1)
}

if (!existsSync(logPath)) {
  console.error(`❌ Log file not found: ${logPath}`)
  process.exit(1)
}

console.log(`📖 Reading ${logPath}`)
const logContent = readFileSync(logPath, 'utf-8')

// ============================================================================
// Step 2 — extract voice mode, provider, working dir
// ============================================================================

const voiceModeFromMeta = logContent.match(/🎙️ Using voice mode from frontend: (\w+)/)
const voiceModeFromMarker = logContent.match(/🎯 (DIRECT|PIPELINE|REALTIME) MODE/i)
const voiceMode =
  voiceModeFromMeta?.[1]?.toLowerCase() ??
  voiceModeFromMarker?.[1]?.toLowerCase() ??
  'pipeline' // safe default — pipeline is the default mode

const providerMatch = logContent.match(/🎙️ Using provider from frontend: (\w+)/)
const provider = providerMatch?.[1] ?? null

const workingDirFromStart = logContent.match(/📂 Working directory \(cwd\): ([^\n]+)/)
const workingDirFromFrontend = logContent.match(/📂 Working directory from frontend: ([^\n]+)/)
const workingDir =
  workingDirFromFrontend?.[1]?.trim() ??
  workingDirFromStart?.[1]?.trim() ??
  process.cwd()

const userTurnCount =
  (logContent.match(/📝 User \(/g)?.length ?? 0) +
  (logContent.match(/📝 Text \(/g)?.length ?? 0) +
  (logContent.match(/📥 \[pipeline\] chat\(\) call/g)?.length ?? 0)

console.log(`   Mode: ${voiceMode}, Provider: ${provider ?? 'unknown'}, User turns: ~${userTurnCount}`)

// ============================================================================
// Step 3 — dynamic-import current prompts
// ============================================================================

interface PromptSection {
  label: string
  text: string
}

async function loadPrompts(mode: string, wd: string): Promise<PromptSection[]> {
  const sections: PromptSection[] = []

  const promptsPath = join(agentSrcDir, 'prompts.ts')
  if (!existsSync(promptsPath)) {
    console.error(`❌ Cannot find ${promptsPath}`)
    return sections
  }

  // tsx ESM loader handles .ts imports at runtime. Use file:// URL to be safe
  // across platforms.
  const promptsModule: any = await import(pathToFileURL(promptsPath).href)

  if (mode === 'direct') {
    sections.push({
      label: 'Direct Mode Research Prompt (Claude SDK — agent/src/prompts.ts: getDirectModeResearchPrompt)',
      text: promptsModule.getDirectModeResearchPrompt?.(wd) ?? '(export not found)',
    })
  } else if (mode === 'pipeline') {
    sections.push({
      label: 'Research System Prompt (Claude SDK — agent/src/prompts.ts: getResearchSystemPrompt)',
      text: promptsModule.getResearchSystemPrompt?.(wd) ?? '(export not found)',
    })
    // Pipeline fast brain system prompt — see extractPipelineFastBrainSource below.
    const pfbSource = extractPipelineFastBrainSource()
    sections.push({
      label: 'Pipeline Fast Brain — buildSystemPrompt function source (agent/src/pipeline-fastbrain.ts)',
      text: pfbSource ?? '(extraction failed — pipeline-fastbrain.ts format may have changed)',
    })
  } else if (mode === 'realtime') {
    sections.push({
      label: 'Realtime Voice Model Instructions (agent/src/prompts.ts: getRealtimeInstructions)',
      text: promptsModule.getRealtimeInstructions?.(wd) ?? '(export not found)',
    })
    sections.push({
      label: 'Research System Prompt (Claude SDK sub-research — agent/src/prompts.ts: getResearchSystemPrompt)',
      text: promptsModule.getResearchSystemPrompt?.(wd) ?? '(export not found)',
    })
    sections.push({
      label: 'Fast Brain System Prompt (agent/src/prompts.ts: FAST_BRAIN_SYSTEM_PROMPT)',
      text: promptsModule.FAST_BRAIN_SYSTEM_PROMPT ?? '(export not found)',
    })
  }

  return sections
}

// ============================================================================
// buildSystemPrompt extractor (brace-match, since it's not exported)
// ============================================================================

function extractPipelineFastBrainSource(): string | null {
  const pfbPath = join(agentSrcDir, 'pipeline-fastbrain.ts')
  if (!existsSync(pfbPath)) return null
  const src = readFileSync(pfbPath, 'utf-8')

  const startIdx = src.indexOf('function buildSystemPrompt')
  if (startIdx === -1) return null

  // Step 1: find the opening PAREN of the parameter list.
  const openParenIdx = src.indexOf('(', startIdx)
  if (openParenIdx === -1) return null

  // Step 2: paren-match to find the closing paren. We MUST skip past the
  // parameter list before looking for the function body's opening brace,
  // because TypeScript parameter type annotations contain braces
  // (e.g. `chatHistory?: { role: string; content: string }[]`). A naive
  // brace walker would latch onto the first `{` inside the param list,
  // decrement on its matching `}`, and return a 2-line "function body"
  // that's just the signature prefix.
  let parenDepth = 1
  let i = openParenIdx + 1
  while (i < src.length && parenDepth > 0) {
    const ch = src[i]
    if (ch === '(') parenDepth++
    else if (ch === ')') parenDepth--
    i++
  }
  if (parenDepth !== 0) return null
  const afterParamsIdx = i // position just after the closing `)`

  // Step 3: find the function body's opening brace AFTER the parameter list.
  // This skips any optional `: ReturnType` annotation between `)` and `{`.
  const openBraceIdx = src.indexOf('{', afterParamsIdx)
  if (openBraceIdx === -1) return null

  // Step 4: brace-match the function body. Doesn't handle braces in strings
  // or comments, which is fine for the current source (template literals
  // with `${...}` interpolations are balanced).
  let braceDepth = 1
  i = openBraceIdx + 1
  while (i < src.length && braceDepth > 0) {
    const ch = src[i]
    if (ch === '{') braceDepth++
    else if (ch === '}') braceDepth--
    i++
  }
  if (braceDepth !== 0) return null

  return src.substring(startIdx, i)
}

// ============================================================================
// Step 4 — build markdown review brief
// ============================================================================

const prompts = await loadPrompts(voiceMode, workingDir)
const timestamp = new Date().toISOString()

const promptSections = prompts
  .map((p) => `### ${p.label}\n\n\`\`\`\n${p.text}\n\`\`\``)
  .join('\n\n')

const brief = `# Osborn Prompt Review

## Session summary

- **Voice mode**: ${voiceMode}
- **Provider**: ${provider ?? 'unknown'}
- **Working dir**: ${workingDir}
- **User turns (approx)**: ${userTurnCount}
- **Log path**: ${logPath}
- **Review generated**: ${timestamp}

## Raw session log

The following is the full untruncated terminal output from an \`npm run dev:logged\` session with Osborn, a voice AI research assistant. Pattern guide:

- \`📝 User (conv_item, N chars): "..."\` / \`📝 Text (N chars): "..."\` — what the user said (voice) or typed (data channel)
- \`📥 [pipeline] chat() call #N (chars): "..."\` — pipeline-mode user turn entering the Claude SDK
- \`💬 Agent (conv_item, N chars): "..."\` — what the agent said back via the voice model
- \`💬 Claude text (N chars): ...\` / \`📋 Claude result (N chars): ...\` — Claude SDK streaming output / final result
- \`🧠⚡ [FAST_BRAIN TYPE +Nms]: "..."\` / \`🧠⚡ [pipeline-fb] AFC: ...\` — fast brain classifications / responses
- \`🔧 Claude: X\` / \`✅ Done: X\` — tool calls
- \`🎙️ / 🎯\` — voice mode + provider markers

\`\`\`
${logContent}
\`\`\`

## Active prompts (at review time)

These are the prompts currently in \`agent/src/prompts.ts\` (and the function source from \`agent/src/pipeline-fastbrain.ts\` for pipeline mode) that shaped behavior during this \`${voiceMode}\`-mode session. They are loaded dynamically at review time, so they reflect the CURRENT state of the files — not a snapshot.

${promptSections}

## Review task

**This is a design audit, not a rule-checking pass.** Reading each prompt section in isolation and grepping the log for violations is the wrong approach and produces shallow, checklist-style output. The prompts are a system — they interlock, depend on each other, and only make sense in the context of what the user is trying to build. Your job is to understand that system as a whole, share your understanding with the user, and THEN grade the session against it.

Do this in phases, in order. Do not skip ahead.

### Phase 1 — Build a mental model of the system

Before you touch the session log, understand Osborn as a system end-to-end.

1. **Read every prompt section above in full.** Don't skim. Notice how each prompt assumes things about what the other layers do.
2. **Read \`agent/CLAUDE.md\`** via the Read tool. It describes the voice mode architecture (direct / pipeline / realtime), sub-agent orchestration (researcher / reasoner / writer), the fast brain middle tier, and the layered responsibility model. The prompts only make sense in this context.
3. **Grep briefly** for how prompts are selected at runtime: look at \`agent/src/claude-llm.ts\` around line 880-920 and \`agent/src/index.ts\` around the fast brain routing. Understand how a turn actually flows through the layers — not just the static prompt text.

Then write down, as the first content of your response to the user, an explicit mental model:
- What does a user turn flow look like end-to-end? (STT → fast brain classification → Claude SDK orchestrator → sub-agents or direct response → TTS back to the user)
- What's each prompt's intended role? How do they interlock?
- What would an "ideal" turn look like, if everything worked perfectly?

### Phase 2 — Develop a theory of user intent

Based on the session log AND your mental model, form a short theory: **what does THIS user want Osborn to be?** What's their ideal experience? Read between the lines of how they talk to the agent, what they interrupt, what they repeat, what they correct. 2-3 sentences max.

### Phase 3 — STOP and confirm with the user before grading

Show the user your mental model and your theory of their intent. Ask: "Does this match how you think about it? Anything I'm missing or getting wrong?" **Wait for a response.** Do not proceed to auditing until the user has confirmed or corrected your understanding.

This is the most important phase. Skip it and you'll be grading the session against your assumptions instead of the user's. The whole point of this review is to have a conversation about the design, not to hand-deliver a list of violations.

### Phase 4 — Walk the log through the confirmed model

Only now, read the raw session log turn by turn. For each meaningful turn, ask three questions in this exact order:
- **What should have happened here**, given the system as designed and the user's confirmed intent?
- **What actually happened?**
- **Why the gap?**

Categorize each gap by root cause:
- **Expression gap** — the intent is present in a prompt but worded weakly. Fix: tighten wording.
- **Omission gap** — the intent isn't in any prompt at all. Fix: add new guidance, considering where it belongs.
- **Conflict gap** — two prompts contradict each other or leave a gap between them. Fix: reconcile.
- **Architecture gap** — the system design can't actually produce the intended behavior. Fix: flag and discuss. Do NOT patch a prompt to work around an architectural problem.
- **Model miss** — the prompt says it clearly and the model ignored it. Fix: usually can't be fixed with tighter wording; flag and move on.

### Phase 5 — Propose changes holistically, one at a time

Do NOT batch-propose a list of six edits. Each proposed change should be brought to the user individually with:
1. The gap you're trying to close and its category (from Phase 4)
2. The exact before/after prompt text
3. How the change interacts with OTHER prompt sections — does it conflict with anything? Does it create a new gap? Is it addressing root cause or a symptom?
4. A pause for user confirmation before you use Edit

### Phase 6 — Apply edits

Only after the user has explicitly agreed to a specific change, use the Edit tool on:
- \`${agentSrcDir}/prompts.ts\`
- \`${agentSrcDir}/pipeline-fastbrain.ts\`

---

**Start with Phase 1 right now.** Don't jump to the log. Don't start summarizing the session. The very first thing in your response should be your mental model of the Osborn system as you understand it after reading the prompts, CLAUDE.md, and the relevant source.
`

// ============================================================================
// Step 5 — write brief to file, print manual fallback, spawn claude with pointer
// ============================================================================

// Always write the brief to a file. Passing a 50KB brief as argv has several
// problems:
//   - `claude "query"` in Claude Code CLI is NON-INTERACTIVE print mode, not
//     interactive-with-initial-message. A huge positional arg makes claude
//     print and exit, not open a chat.
//   - Argv size limits (ARG_MAX) are platform-dependent and the `npm → tsx →
//     spawn` chain adds layers that can fail silently on large args.
//   - Shell-quoting a 50KB multi-line markdown string is fragile.
// File + short pointer is dramatically more reliable.
const briefTs = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
const briefPath = join(logDir, `review-brief-${briefTs}.md`)
writeFileSync(briefPath, brief, 'utf-8')
const briefKB = Math.round(Buffer.byteLength(brief, 'utf-8') / 1024)
console.log(`📄 Brief written: ${briefPath}`)
console.log(`   Size: ${briefKB}KB`)

// Dry-run mode: print the brief and exit cleanly without spawning claude.
// Useful for testing + previewing the brief. Set REVIEW_DRY_RUN=1 to activate.
if (process.env.REVIEW_DRY_RUN === '1') {
  console.log('\n=== REVIEW_DRY_RUN=1 — brief below (claude NOT spawned) ===\n')
  console.log(brief)
  console.log('\n=== end of brief ===')
  process.exit(0)
}

// Short pointer message for claude's initial argv. Tells claude to open the
// brief file and follow the review task instructions. Small enough to avoid
// all the argv / CLI-mode pitfalls above.
const pointerMessage =
  `I've captured a prompt-review brief for an Osborn voice session at ${briefPath}. ` +
  `Please Read that file in full and follow the "Review task" instructions at the bottom.`

// Print manual fallback command — if the auto-spawn below doesn't land
// cleanly (terminal state weirdness, claude CLI version differences, etc.),
// the user can copy-paste this into a fresh terminal.
console.log(``)
console.log(`─────────────────────────────────────────────────────────────`)
console.log(`If the auto-launch doesn't work, run these commands manually:`)
console.log(``)
console.log(`  cd ${agentDir}`)
console.log(`  claude --add-dir ${agentSrcDir}`)
console.log(``)
console.log(`Then inside the claude session, type or paste:`)
console.log(``)
console.log(`  Read ${briefPath} and follow the "Review task" at the bottom.`)
console.log(`─────────────────────────────────────────────────────────────`)
console.log(``)

// Allow skipping the auto-launch entirely — useful when the user prefers
// manual control, or when nesting under tsx/npm causes stdio weirdness.
if (process.env.REVIEW_NO_LAUNCH === '1') {
  console.log(`REVIEW_NO_LAUNCH=1 — not auto-launching claude. Use the manual commands above.`)
  process.exit(0)
}

console.log(`🚀 Auto-launching: claude --add-dir ${agentSrcDir} "<pointer message>"`)
console.log(`   (set REVIEW_NO_LAUNCH=1 to skip auto-launch next time)`)
console.log(``)

try {
  const claude = spawn('claude', ['--add-dir', agentSrcDir, pointerMessage], {
    stdio: 'inherit',
    cwd: agentDir,
  })

  console.log(`   claude PID: ${claude.pid}\n`)

  claude.on('error', (err: any) => {
    if (err.code === 'ENOENT') {
      console.error(`\n❌ \`claude\` CLI not found on PATH.`)
      console.error(`   Install with: npm install -g @anthropic-ai/claude-code`)
      console.error(`   Or use the manual commands printed above.`)
      process.exit(1)
    }
    console.error(`\n❌ Failed to spawn claude: ${err.message}`)
    console.error(`   Try the manual commands printed above.`)
    process.exit(1)
  })

  claude.on('exit', (code, signal) => {
    if (code !== 0 || signal) {
      console.log(`\n📝 claude exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
      if (code !== 0 && signal === null) {
        console.log(`   If the session didn't render properly, try the manual commands above.`)
      }
    }
    process.exit(code ?? 0)
  })
} catch (err) {
  console.error(`❌ Unexpected error: ${(err as Error).message}`)
  console.error(`   Try the manual commands printed above.`)
  process.exit(1)
}
