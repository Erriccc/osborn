# Prompt System (for performance tracking)

The system has layered prompts at different levels — all centralized in `prompts.ts`. Referenced from `CLAUDE.md` to keep the top-level claude guidance under the 40k context budget. Read this when tuning voice behavior, debugging research flow, or adding new injection prefixes.

| Layer | Location | When | Content |
|---|---|---|---|
| **Realtime voice model** | `prompts.ts` (`getRealtimeInstructions()`) | Realtime sessions | Teleprompter rules: call `ask_fast_brain` for EVERY user message and speak the returned script verbatim. Anti-hallucination, adaptive verbosity, no gap-filling, speech pacing. |
| **Direct voice agent** | `prompts.ts` (`DIRECT_MODE_PROMPT`) | Direct sessions | Short: "You are Osborn, a voice AI assistant operating in direct mode..." |
| **Direct mode research prompt** | `prompts.ts` (`getDirectModeResearchPrompt(workspacePath)`) | Direct mode `voiceMode === 'direct'` | Speech-optimized rules for the Claude SDK in direct/pipeline mode (no markdown, conversational tone). |
| **Realtime research system prompt** | `prompts.ts` (`getResearchSystemPrompt(workspacePath)`) | Realtime mode | Structured research rules for the Claude SDK in realtime mode (paths, write restrictions, parallel sub-agents via Task). Agent reads `spec.md` but NEVER writes — fast brain owns it. |
| **Fast brain** | `prompts.ts` (`FAST_BRAIN_SYSTEM_PROMPT`) | Inside `askFastBrain()` | Tool catalog, structured response markers (`RECORDED:`, `ASK_USER:`, `NEEDS_DEEPER_RESEARCH`, `PARTIAL:`), question tracking, spec.md update rules, anti-hallucination. |
| **Spec consolidation** | `prompts.ts` (`CHUNK_PROCESS_SYSTEM`, `REFINEMENT_PROCESS_SYSTEM`) | `processResearchChunk()` | JSON-output prompts that update `spec.md` from research content (chunk = mid-research, refinement = post-research). |
| **Result augmentation** | `prompts.ts` (`AUGMENT_RESULT_SYSTEM`) | After research | Adds context to raw findings before voice relay. |
| **Update contextualization** | `prompts.ts` (`CONTEXTUALIZE_UPDATE_SYSTEM`) | `contextualizeResearchUpdate()` | Generates natural 1-2 sentence voice update from raw events; instructed NOT to say "complete" or "done". |
| **Proactive prompts** | `prompts.ts` (`PROACTIVE_PROMPT_SYSTEM`) | `generateProactivePrompt()` | Priority order: ALIGN > NARROW > CONNECT > PROGRESS > NOTHING. 15s loop, 4-prompt cap. |
| **Visual document** | `prompts.ts` (`VISUAL_DOCUMENT_SYSTEM`) | `generateVisualDocument()` | Mermaid diagrams, comparison tables, analysis docs. |
| **Research completion** | `prompts.ts` (`RESEARCH_COMPLETION_SYSTEM`) | Spoken briefing after research | Fact-fidelity mandate, no hallucinated file names. |
| **Pipeline fast brain** | `prompts/pipeline-fast-brain.md` (`getPipelineFastBrainPrompt`) | Pipeline mode every turn | AFC agent rules for `search_session`, `get_recent`, `emergency_stop`. |
| **Notifications** | `prompts.ts` (`getNotificationInjection()`) | Any mode | `[NOTIFICATION] {text}. Acknowledge briefly. Do NOT call any tools.` |
| **Voice script injections** | `prompts.ts` (`getScriptInjection()`, `getProactiveInjection()`, `getResearchUpdateInjection()`, `getResearchCompleteInjection()`) | Voice queue items | `[SCRIPT]`, `[PROACTIVE]`, `[RESEARCH UPDATE — STILL IN PROGRESS]`, `[RESEARCH COMPLETE]` prefixes with fact-fidelity mandates. |
| **Session context briefings** | `fast-brain.ts` (`prepareBriefingScript`, `prepareRecoveryScript`) | Session resume/recovery | LLM-rewritten briefings matching the user's vocabulary from chatHistory. |

**Points checklist (`[POINTS]`, #455).** For a long foreground turn (60+ words, at least 3 separate points after dropping chit-chat and explicit asks), `ClaudeLLM.noteUserTurn` returns a short checklist that rides on the same `UserPromptSubmit` `additionalContext` as the follow-through recap. The text is `agent/src/prompts/points-checklist.md`, built by `getPointsChecklist()` in `prompts.ts`: the points are quoted data, not instructions, and the whole block stays under 1400 bytes. Only a follow-through (foreground) session computes or records points; background slots return nothing. Points are local ledger items (never filed) and close at turn end when the reply or its non-delegating tool calls cover them (`points.ts`).
