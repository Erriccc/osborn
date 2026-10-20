/**
 * Type-level pins (contracts A, C, D, F) — checked by `tsc --noEmit -p
 * tests/regression/tsconfig.json` (tsx strips types WITHOUT checking them, so
 * this file is meaningless under tsx — run-all.sh runs it through tsc).
 *
 * Eq<> is an EXACT type-identity check: widening, narrowing, or renaming any
 * pinned signature makes this file fail to compile.
 *
 *   A  AgentControlCallbacks exact keys + signatures; askPipelineFastBrain
 *      parameter/return shape; PipelineFastBrainOptions keys
 *   C  ClaudeLLM: stopAgent / getRunningTasks / noteTaskDispatch /
 *      claimTaskDispatch / trackTaskMessage / pushMessage pushOpts
 *   D  PipelineDirectLLM.chat returns llm.LLMStream (NOT a Promise) +
 *      stopAgent/getRunningTasks passthrough types
 *   F  @anthropic-ai/claude-agent-sdk typings: Options.perTaskStopAffordance,
 *      Query.stopTask(taskId), SDKUserMessage.priority 'now'|'next'|'later'
 */
import type { EventEmitter } from 'events'
import { llm } from '@livekit/agents'
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentControlCallbacks,
  PipelineFastBrainOptions,
  PipelineFastBrainResult,
} from '../../src/pipeline-fastbrain.js'
import { askPipelineFastBrain } from '../../src/pipeline-fastbrain.js'
import type { ClaudeLLM } from '../../src/claude-llm.js'
import type { PipelineDirectLLM } from '../../src/pipeline-direct-llm.js'

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

// ── A: AgentControlCallbacks — exact field names and signatures ─────────────
type _acKeys = Expect<Eq<keyof AgentControlCallbacks,
  'interrupt' | 'abort' | 'hasActiveAgent' | 'getRecentUserMessages' | 'sendPrompt'>>
type _acInterrupt = Expect<Eq<AgentControlCallbacks['interrupt'], () => Promise<boolean>>>
type _acAbort = Expect<Eq<AgentControlCallbacks['abort'], () => void>>
type _acHasActive = Expect<Eq<AgentControlCallbacks['hasActiveAgent'], () => boolean>>
type _acGetRecent = Expect<Eq<AgentControlCallbacks['getRecentUserMessages'], (count: number) => string[]>>
type _acSendPrompt = Expect<Eq<AgentControlCallbacks['sendPrompt'], (prompt: string) => void>>

// ── A: askPipelineFastBrain export + parameter shape ────────────────────────
type FB = typeof askPipelineFastBrain
type _fbParams = Expect<Eq<Parameters<FB>, [string, string, string, PipelineFastBrainOptions?]>>
type _fbReturn = Expect<Eq<ReturnType<FB>, Promise<PipelineFastBrainResult>>>
type _fbOptsKeys = Expect<Eq<keyof PipelineFastBrainOptions,
  'chatHistory' | 'researchContext' | 'sessionBaseDir' | 'agentControl'>>
type _fbOptsAgentControl = Expect<Eq<PipelineFastBrainOptions['agentControl'], AgentControlCallbacks | undefined>>
type _fbResultType = Expect<Eq<PipelineFastBrainResult['type'],
  'answer' | 'research_needed' | 'acknowledgment' | 'error'>>

// ── C: ClaudeLLM public steering/stop surface ───────────────────────────────
type _stopAgent = Expect<Eq<ClaudeLLM['stopAgent'], (agentId: string) => Promise<boolean>>>
type _runningTasks = Expect<Eq<ReturnType<ClaudeLLM['getRunningTasks']>,
  Array<{ taskId: string; subagentType?: string; description?: string; status: string }>>>
type _noteDispatch = Expect<Eq<Parameters<ClaudeLLM['noteTaskDispatch']>, [string | undefined, string | undefined]>>
type _claimDispatch = Expect<Eq<Parameters<ClaudeLLM['claimTaskDispatch']>, [string | undefined, string | undefined]>>
type _trackMsg = Expect<Eq<ClaudeLLM['trackTaskMessage'], (msg: any) => void>>
// pushMessage(userText, sdkOptions, callbacks, pushOpts?) with the exact pushOpts shape
type _pushUserText = Expect<Eq<Parameters<ClaudeLLM['pushMessage']>[0], string>>
type _pushSdkOptions = Expect<Eq<Parameters<ClaudeLLM['pushMessage']>[1], Options>>
type _pushCallbacks = Expect<Eq<Parameters<ClaudeLLM['pushMessage']>[2], {
  onSessionId: (id: string) => void
  onCheckpoint: (checkpointId: string) => void
  eventEmitter: EventEmitter
}>>
type _pushOpts = Expect<Eq<Parameters<ClaudeLLM['pushMessage']>[3],
  { priority?: 'now' | 'next' | 'later' } | undefined>>
type _interruptQuery = Expect<Eq<ReturnType<ClaudeLLM['interruptQuery']>, Promise<boolean>>>

// ── D: PipelineDirectLLM — SYNCHRONOUS chat() + passthroughs ────────────────
type _chatSync = Expect<Eq<ReturnType<PipelineDirectLLM['chat']>, llm.LLMStream>>
type _pdStopAgent = Expect<Eq<PipelineDirectLLM['stopAgent'], (agentId: string) => Promise<boolean>>>
type _pdRunningTasks = Expect<Eq<ReturnType<PipelineDirectLLM['getRunningTasks']>,
  ReturnType<ClaudeLLM['getRunningTasks']>>>

// ── F: SDK dependency pins — an SDK upgrade dropping these fails here ───────
type _sdkPerTaskStop = Expect<Eq<Options['perTaskStopAffordance'], boolean | undefined>>
type _sdkStopTask = Expect<Eq<Query['stopTask'], (taskId: string) => Promise<void>>>
type _sdkPriority = Expect<Eq<SDKUserMessage['priority'], 'now' | 'next' | 'later' | undefined>>
// interrupt(): zero-arg and awaitable is all interruptQuery() relies on — the SDK's
// actual return is Promise<SDKControlInterruptResponse | undefined>, don't over-pin.
type _sdkInterruptArgs = Expect<Eq<Parameters<Query['interrupt']>, []>>
type _sdkInterruptAwaitable = Expect<ReturnType<Query['interrupt']> extends Promise<unknown> ? true : false>

// Keep tsc from flagging the value import as unused under future stricter configs.
void askPipelineFastBrain
console.log('type-pins: compiled — all type-level contracts hold (meaningful only under tsc, not tsx)')
