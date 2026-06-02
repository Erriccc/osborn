# Ground Assumptions

## SKILL IDENTITY
Name: ground-assumptions
Install path: ~/.claude/skills/ground-assumptions/SKILL.md
Portable: yes — drops into any agent's skills dir (Claude Code, osborn on Fly, other Claude Agent SDK hosts)

## WHEN THIS SKILL ACTIVATES
This skill applies whenever the conversation enters a **planning / design / architecture phase**.
Specifically, if the user says or asks any of:

- "let's plan / design / architect..."
- "how should we..."
- "what's the best way to..."
- "I'm thinking we..."
- "what do you recommend..."
- "approach", "architecture", "design", "should we"
- Any time I am about to recommend an implementation strategy, performance characteristic,
  behavioral guarantee, or comparative judgment ("X is faster than Y", "this propagates", "this scales")

Also activates explicitly with:
- "ground assumptions"
- "verify before planning"
- "check that hypothesis"

## CORE PRINCIPLE
When you're **planning new work — a new feature, a new integration, or fitting
a change into the existing architecture** — every load-bearing assumption is a
**hypothesis until verified against real evidence.** Training-data intuition and
"it should work" do not count.

The canonical situation this skill is for: *we're about to implement something
new (e.g. add OpenAI Codex as an agent option alongside Claude Code), and we
need to know it actually fits our architecture one-to-one — does Codex's session
model, SDK, and data storage map to what we already do — BEFORE we build on that
assumption.* That's the shape: a new piece must slot into the existing system,
and we confirm the fit with evidence, not hope.

**What counts as verification** (in priority order):
1. **Existing tests / previous test runs** — has this already been proven? check first.
2. **Authoritative documentation / source code** — does the doc or the actual code confirm the behavior?
3. **A newly-created, targeted test** — if nothing above answers it, build a
   specific test (or several) that exercises exactly the assumption, run it on
   real infrastructure, and read the result.

**The main agent does NOT do the verification work itself.** Spawn subagents
(Agent tool) to run the tests / read the docs / check prior results, so the main
agent stays free to keep the planning conversation moving and react to results
as they land. **Delegation rule (hard):** when verification is needed, ALWAYS
delegate to a subagent — don't call Bash/WebSearch/Grep inline yourself. Spawn
multiple subagents in parallel when there are several independent assumptions to
check. (Exception: the user explicitly asks you to run something inline — then
say you're breaking the delegation pattern.)

Why this matters — past sessions shipped plans on unverified assumptions and
paid for it: a "small" change broke an unrelated subsystem; a behavior we
*assumed* ("this propagates", "this auto-updates") silently failed; an
integration we *assumed* was 1:1 wasn't. The expensive surprises live in
**architectural fit and integration**, not in micro-benchmarks. (Timing claims
matter too — don't say "fast"/"Xs" without measuring — but they are the *least*
of it. Lead with "does this fit / does this actually work", not "how fast".)

The discipline: **verify against evidence — existing tests, docs, or a new
delegated test — before the assumption is surfaced as fact or built upon.**

## ASSUMPTION PRIORITY ORDER (verify highest first)

When verification budget is limited, ALWAYS verify in this order:

1. **ARCHITECTURAL IMPACT** — does this change break or alter existing flows / subsystems?
   - "Does the new entrypoint affect the OAuth flow?"
   - "If we move osborn off the volume, does session resume still work?"
   - "Does the bind-mount conflict with Fly's shutdown umount?"
2. **INTEGRATION** — does this work with all the connected pieces (auth, network, sessions, data, persistence, MCP, recording, etc.)?
   - "Does Claude Code's `setup-token` pty work inside chroot?"
   - "Does the frontend's `/api/sandbox` fetch-log still read the right path?"
3. **BEHAVIORAL** — does the system actually do what we claim it does?
   - "Does image-swap actually replace the running osborn binary?"
4. **TIMING** — is the speed claim true under real conditions?
   - "Is the seed tarball really 5s to extract?"
5. **COSMETIC** — minor polish items that don't gate the architecture.

Timing claims are the LOWEST priority. We've burned multiple cycles on timing measurements
while missing that the architecture itself had subtle bugs that broke other parts of the system.
Architectural and integration assumptions are where the expensive surprises live.

## THE WORKFLOW (followed strictly during planning)

### 1. PLAN DRAFT
State the proposed plan as usual — fully, with intent and reasoning.

### 2. ASSUMPTION EXTRACTION
Before presenting the plan as a recommendation, **list every load-bearing assumption**.
A load-bearing assumption is anything where, if it's wrong, the plan stops working.

For each assumption, **also identify its second/third-order implications** —
what else in the system depends on it being true?

Format:
```
ASSUMPTIONS (must be verified before plan ships):
1. <claim that the plan depends on>
   → implications: <what else breaks if 1 is false>
2. <claim that the plan depends on>
   → implications: <what else breaks if 2 is false>
3. ...
```

If an assumption can't be stated cleanly in one sentence, it isn't ready to be tested.
Break it down further.

**Ripple-effect check** (do this once for every plan that touches existing architecture):

Ask explicitly:
- What existing flows touch the system we're changing?
  (auth, network, sessions, MCP, recording, persistence, log-fetch, dashboard, voice loop)
- For each connected flow, can the change break it in a non-obvious way?
- Is there a code path that USED to work without our knowledge that depends on the old behavior?

If yes to any of those, add the affected flow as a new assumption that needs verification.
This is where the expensive surprises hide.

### 3. ASYNC VERIFIER SPAWN (parallel, non-blocking)
For EACH assumption, spawn an Agent subagent **immediately**, in a SINGLE message
with multiple Agent tool calls so they run concurrently.

Choose verifier type by the nature of the assumption. **Architectural and integration verifiers come first** — they catch the expensive surprises.

| Assumption type | Verifier type | What it does |
|---|---|---|
| **Architectural impact** (`does X break flow Y?`) | **Ripple agent** | Traces all callers/consumers of the changed component, checks each for breakage |
| **Integration** (`does X work with subsystem Y?`) | **Integration agent** | Spawns end-to-end test exercising the connection between subsystems |
| Behavioral (`does X`, `propagates`, `survives Y`) | Test agent | Triggers the behavior, observes outcome |
| Documented (`API supports X`, `library does Y`) | Research agent | Fetches docs/code/sources, returns citation with quote |
| Derivable (`X+Y → Z`) | Reasoning agent | Derives from established facts, returns chain |
| Timing (`Xs`, `fast`, `slow`) | Test agent | Runs the actual operation on real infra, measures under stated conditions |
| Empirical (`users typically do X`) | Research agent | Cites surveys/data/observations |

Each verifier returns one of:
- **MEASURED**: empirical observation with conditions documented
- **SOURCED**: cited from authoritative source with quote
- **DERIVED**: chain from established facts
- **CONTRADICTED**: evidence that the assumption is false
- **UNVERIFIABLE**: cannot be determined in available time/resources

### 4. CONTINUE PLANNING (don't block on verifiers)
Keep talking with the user through design tradeoffs, edge cases, etc.
**Main agent is NOT in the test loop.** Verifiers run in the background.
DO NOT commit to a recommendation until verifiers report.

**Main agent's role while verifiers run:**
- Stay in conversation with the user
- Sketch more of the plan / explore tradeoffs / answer questions
- Track which verifiers are still in flight, which returned, which contradicted
- React to verifier results as they arrive — don't poll, don't wait silently

**Things the main agent should NOT do while verifiers are in flight:**
- Run a Bash command that performs the same test (defeats delegation)
- Read files the verifier is already reading (duplicative)
- "Just check one quick thing myself" — that's how delegation collapses
- Block the conversation until results come back

### 5. INTEGRATE RESULTS
When a verifier returns:
- **MEASURED / SOURCED / DERIVED** → mark assumption ✓, keep going
- **CONTRADICTED** → STOP, mark assumption ✗, announce: "Assumption N contradicted by <evidence>. Replanning." → restart at step 1 with revised approach
- **UNVERIFIABLE** → mark ⚠️, ask user: "Cannot verify <assumption>. Proceed with explicit risk, or pivot to a verifiable approach?"

### 6. COMMITTED PLAN
Only present a plan as the recommended approach when every assumption is
✓ MEASURED, ✓ SOURCED, ✓ DERIVED, or explicitly accepted as ⚠️ UNVERIFIABLE.

## OUTPUT FORMAT

While verifiers are in flight:
```
PLAN: <draft summary>

ASSUMPTIONS (verifiers running in parallel):
☐ A1: <assumption>
☐ A2: <assumption>
☐ A3: <assumption>
```

As verifiers return:
```
✓ A1 MEASURED: <result> (conditions: <where/when/setup>)
✓ A2 SOURCED: <URL> — "<quote>"
✗ A3 CONTRADICTED: <evidence>
   → STOPPING. Replanning around A3.
```

Final state:
```
VERIFIED PLAN:
<plan with every assumption marked ✓ or explicitly ⚠️>
```

## HARD RULES (no exceptions)

1. **No naked "it fits / it works" claims.** Never assert that a new piece integrates with the existing architecture — "Codex maps 1:1 to our session model", "this slots into the existing flow", "the SDK stores data the same way" — without backing from an existing test, the actual docs/source, or a new delegated test.
2. **No naked behavioral claims.** Never write "auto-updates", "propagates", "survives", "rolls back", "X just works" without MEASURED or SOURCED backing.
3. **Check for existing evidence FIRST.** Before commissioning a new test, have a subagent check whether a previous test run, doc, or the source already answers it. Don't re-test what's already proven.
4. **CONTRADICTED stops everything.** When a verifier contradicts an assumption, NO new content is written about the plan until the plan is revised and the verifier rerun.
5. **UNVERIFIABLE is loud.** Mark it ⚠️ in the output AND ask the user for explicit acceptance. Don't hide unverified parts in prose.
6. **Training-data intuition is forbidden as evidence.** "X typically works this way" is not a citation. Verify against a test, doc, or source — or skip.
7. **Timing/comparative claims are the least of it, but still bound:** don't write "fast"/"slow"/"X seconds"/"faster than Y" without a measurement + conditions. Just don't let speed-benchmarking crowd out the architectural-fit and integration checks, which are where the expensive surprises actually live.

## SUBAGENT SPAWNING PATTERNS

For timing/behavioral tests on real infra:
> Spawn Agent subagent with prompt: "Run <specific command> on <specific target>. Measure <specific metric>. Report back the measurement and the conditions (machine type, memory, network state, cold/warm cache). Do not attempt the broader task — only verify this one assumption."

For documentation lookups:
> Spawn Agent subagent with prompt: "Find authoritative source for <specific claim>. Return URL + verbatim quote. If multiple sources, prefer official docs > vendor blogs > Stack Overflow. If no source exists, return UNVERIFIABLE with reasoning."

For derivation:
> Spawn Agent subagent with prompt: "Given these established facts: <list>, can we derive <claim>? Return either the derivation chain OR 'cannot derive — gap at: <step>'."

For ripple-effect / architectural impact (HIGHEST priority):
> Spawn Agent subagent with prompt: "Trace all consumers / callers / dependencies of `<component being changed>` in the codebase. For each consumer, check whether the proposed change would break it. Report each potential break with file:line and the specific failure mode. Do not propose fixes — only enumerate breaks."

For integration testing (HIGH priority):
> Spawn Agent subagent with prompt: "End-to-end test: after the proposed change, exercise the connection between `<subsystem A>` and `<subsystem B>` on real infra. Specifically, verify `<concrete cross-system flow>`. Report MEASURED behavior and any divergence from the expected flow."

**Pattern**: invoke all Agent tools in a single response message so they run concurrently rather than sequentially. The Agent tool's `subagent_type` should be `general-purpose` or `Explore` (read-only) depending on what the verifier needs.

## PORTABILITY NOTES

This skill works in any Claude Agent SDK environment because:
- It only requires the Agent tool (standard SDK feature)
- The trigger logic is prose, not code
- No host-specific paths, IDs, or APIs

To deploy on another agent (e.g. osborn on a Fly machine), copy this SKILL.md to that agent's skills dir:
- Claude Code: `~/.claude/skills/ground-assumptions/SKILL.md`
- osborn on Fly: `/workspace/root-chroot/root/.claude/skills/ground-assumptions/SKILL.md`
- Other Claude Agent SDK hosts: their configured skills path

## EXIT CRITERIA

The skill releases its grip on a conversation when:
- All assumptions are verified and a committed plan exists, OR
- The user explicitly asks to skip verification ("just give me your best guess"), OR
- The conversation shifts away from planning to execution of an already-verified plan

In the second case, mark the response with "WARNING: Skipping verification at user request. The following is unverified intuition." so the lack of grounding is visible.
