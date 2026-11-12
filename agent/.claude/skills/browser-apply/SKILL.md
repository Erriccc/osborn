---
name: browser-apply
description: Interactively automate Workday and other multi-step JS-heavy job application forms using Playwright MCP browser tools, filling one page at a time with a screenshot and user confirmation before advancing. Use when applying to a Workday ATS or any staged online job application needing visible, confirmable progress.
---

# Skill: Browser Apply — Step-by-Step Workday Application

Automate Workday job applications interactively, one step at a time. Each step takes a screenshot, confirms what's on screen, fills the current page, and waits before proceeding.

**This skill uses the Playwright MCP tools** (`mcp__playwright__browser_*`) for direct browser control. The only script is the `fill.mjs` helper, used for secret fields (see "One-time setup").

## When to Use
- Any Workday ATS application (`*.wd1.myworkdayjobs.com`)
- Any multi-step JS-heavy job application form
- When you want visible, confirmable progress at each step

## Key Principle: Step-by-Step, Not One Big Script

Do NOT write a monolithic automation script. Instead:
1. Navigate to the URL
2. Take a screenshot — confirm what's on screen
3. Fill only the current step's fields
4. Take another screenshot — confirm fields filled correctly
5. Ask the user "Ready for next step?" before clicking Next
6. Click Next, wait for page load, screenshot again
7. Repeat for each step

This approach catches rendering issues, unexpected fields, and errors before they cascade.

## One-time setup (user does this once per machine)

Candidate values (email, password, phone, address, work history, education) are filled by the `fill.mjs` helper, not by the MCP tools. The helper and the Playwright MCP must drive the SAME browser, which means both attach to one Chrome over CDP on loopback.

1. Secret file. The user creates it and types the values in their own editor (never ask for the values in chat, never write them yourself):
   ```bash
   mkdir -p ~/.osborn
   cp ~/.claude/skills/browser-apply/candidate.example.env ~/.osborn/candidate.env
   chmod 600 ~/.osborn/candidate.env
   ```
   The helper refuses the file if it is a symlink, not owned by the current user, or not mode 600.
2. Playwright for the helper: `npm i -g playwright-core` (no browser download needed; it only attaches over CDP).
3. One headed browser with CDP on loopback:
   ```bash
   google-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.osborn/apply-profile"
   ```
4. Point the Playwright MCP server at that browser with `--cdp-endpoint http://127.0.0.1:9222` (a `@playwright/mcp` flag) in the user's MCP config. Osborn's built-in Playwright catalog entry does not pass this flag yet; without it the MCP launches its own browser and the helper cannot see it.
5. The helper reads NO environment variables and has no path or URL options. Its only config is the optional `CANDIDATE_CDP_URL=` line inside `~/.osborn/candidate.env` (default `http://127.0.0.1:9222`; non-loopback hosts are refused). Only the user edits that file; the model cannot change it.
6. There is no list of approved job sites. Every fill names ONE exact host that the user confirms out loud just before it (see "Filling secret fields").
7. Verify: `node ~/.claude/skills/browser-apply/fill.mjs check` should end with `cdp: reachable`.

## Step-by-Step Execution Pattern

### Step 0 — Check the helper, then open the browser
Run `node ~/.claude/skills/browser-apply/fill.mjs check` first. It prints variable names (including an `extra:` line listing every other `CANDIDATE_*` key the user set — work history, education, anything else) and `cdp: reachable` or `cdp: unreachable`, never values.
- File missing / refused: point the user at "One-time setup" step 1 and wait.
- `cdp: unreachable`: you can still navigate and fill the non-secret fields with the MCP tools, but for every secret field (email, password, phone, address) ask the user to type it into the browser themselves.

Use: `mcp__playwright__browser_navigate` with the applyManually URL

Then: `mcp__playwright__browser_take_screenshot` — show the user what loaded

### Step 1 — Create Account / Sign In
Take a snapshot with `mcp__playwright__browser_snapshot` to see element refs.
Ask the user to confirm the host, then fill the email and password fields with the helper (see "Filling secret fields" below), never by typing values through `mcp__playwright__browser_type` / `browser_fill_form`.
Screenshot to confirm. Then ask user before clicking Create Account / Sign In.

### Step 2 — Start Application
If "Start Your Application" screen appears with Apply Manually button:
Screenshot it. Click "Apply Manually" using `mcp__playwright__browser_click`.
Screenshot after.

### Step 3 — My Information
Snapshot → fill each field → screenshot → ask user before clicking Next.

Fields to fill:
- First Name, Last Name, Phone (via the helper)
- Address, City, Zip (via the helper)
- State (dropdown): ask the user which option to pick; do not read `$CANDIDATE_STATE` out
- Work authorization: Yes
- Sponsorship: No

### Step 4 — My Experience
Snapshot → click Add for each job entry → fill title/company/dates/description
with the helper from `CANDIDATE_JOB_N_*` (see "Candidate Data") → save each →
screenshot. Then add education entries from `CANDIDATE_EDUCATION_N_*`.
Never type a job, employer, school or date you were not given by the helper; if
one is missing, ask the user rather than filling anything.
Ask user before clicking Next.

### Step 5 — Application Questions
Snapshot to see all questions. Fill each one. **Always confirm salary expectation with user before filling** — never guess. Screenshot. Ask before Next.

### Step 6 — Voluntary Disclosures
Select "I do not wish to answer" / "Prefer not to disclose" for all. Screenshot. Ask before Next.

### Step 7 — Self Identify
Fill name and date. Select disability option. Screenshot. Ask before Next.

### Step 8 — Review
Screenshot the full review page. Confirm with user before clicking Submit.

### Step 9 — Confirm submission
Screenshot the confirmation dialog. Save it.

## Candidate Data

Personal values are NOT stored in this skill. They live in a local secret file that the model never reads:
`~/.osborn/candidate.env` (fixed path), `chmod 600`. Template: `candidate.example.env` next to this file.

| Value | Env name |
|---|---|
| Email | `$CANDIDATE_EMAIL` |
| Password | `$CANDIDATE_PASSWORD` |
| First / Last name | `$CANDIDATE_FIRST_NAME` / `$CANDIDATE_LAST_NAME` |
| Phone | `$CANDIDATE_PHONE` |
| Address line 1 | `$CANDIDATE_ADDRESS_LINE1` |
| City / State / Zip | `$CANDIDATE_CITY` / `$CANDIDATE_STATE` / `$CANDIDATE_ZIP` |
| Job N title / employer | `$CANDIDATE_JOB_N_TITLE` / `$CANDIDATE_JOB_N_COMPANY` |
| Job N dates | `$CANDIDATE_JOB_N_START` / `$CANDIDATE_JOB_N_END` |
| Job N description | `$CANDIDATE_JOB_N_DESCRIPTION` |
| Education N | `$CANDIDATE_EDUCATION_N_SCHOOL` / `$CANDIDATE_EDUCATION_N_DEGREE` / `$CANDIDATE_EDUCATION_N_FIELD` |

Work history and education go through the SAME mechanism as the fields above,
with `N` starting at 1 (`CANDIDATE_JOB_1_TITLE`, `CANDIDATE_JOB_2_TITLE`, …).
This skill ships NO employment or education values of its own, and you must
never supply one:

- Run `fill.mjs check` and read its `extra:` line: that is exactly which
  `CANDIDATE_JOB_*` / `CANDIDATE_EDUCATION_*` keys the user actually set. It
  prints names only, never values.
- Fill every one of them with the helper, exactly like the other fields — never
  by typing a value through `mcp__playwright__browser_type` / `browser_fill_form`.
- If a job or education entry the form asks for is not in the secret file, STOP
  and ask the user to type that entry themselves or add the key. Do NOT invent,
  infer, or carry over an employer, title, school, degree or date from anywhere
  — not from the user's repo, résumé file, an earlier application, or your own
  guess. A wrong employer on a submitted application is a false statement to
  that employer.
- Numbers are not contiguous promises: stop at the first N with no
  `CANDIDATE_JOB_N_TITLE`, and ask before adding more entries than the file has.

### Filling secret fields
Use the helper `fill.mjs` next to this SKILL.md (normally `~/.claude/skills/browser-apply/fill.mjs`). It reads `~/.osborn/candidate.env` itself (regular file, owned by you, mode 600) and attaches to the loopback CDP browser from "One-time setup". It fills only on an https page whose host EXACTLY equals `--confirm-host`. Inside the page, right before each field, it checks again that the field's own frame is https on that host. The password goes only into an `<input type="password">`. It prints `about to fill NAME on HOST` before each field and `filled NAME -> selector` after, never a value.

Before EVERY fill command:
1. Read the exact hostname of the current page (from the snapshot or URL), e.g. `acme.wd1.myworkdayjobs.com`.
2. Ask the user out loud: "Fill your password on acme.wd1.myworkdayjobs.com?" (name the fields you are about to fill). Wait for a clear yes. No yes, no fill.
3. Run the command with that same host. The Bash call goes through Osborn's permission prompt, so the user sees the host in the command before it runs.

```bash
node ~/.claude/skills/browser-apply/fill.mjs check
node ~/.claude/skills/browser-apply/fill.mjs fill --confirm-host acme.wd1.myworkdayjobs.com \
  CANDIDATE_EMAIL 'input[type="email"]' \
  CANDIDATE_PASSWORD 'input[type="password"]'
```

Rules:
- NEVER `cat`, `less`, `head`, `echo`, `printenv`, `env`, `grep`, `Read` or otherwise print the secret file or the `CANDIDATE_*` variables.
- NEVER pass a value to an MCP browser tool or put one in a command line; pass env NAMES only.
- If `check` reports the file missing or too open, tell the user to create it from `candidate.example.env` and run `chmod 600`; do not create it with values yourself.
- If `check` says `cdp: unreachable`, or `fill` refuses (no browser, wrong host, wrong field type), do not work around it: ask the user to type the secret fields themselves.
- Never edit `~/.osborn/candidate.env`. Only the user changes its values or its `CANDIDATE_CDP_URL` line.
- Never reuse an earlier confirmation for a different host or a later fill; ask again each time.

## Workday data-automation-id Selector Reference

| Field | Selector | Value from |
|---|---|---|
| Email | `input[type="email"]` | `CANDIDATE_EMAIL` (helper) |
| Password | `input[type="password"]` | `CANDIDATE_PASSWORD` (helper) |
| First name | `[data-automation-id="legalNameSection_firstName"]` | `CANDIDATE_FIRST_NAME` (helper) |
| Last name | `[data-automation-id="legalNameSection_lastName"]` | `CANDIDATE_LAST_NAME` (helper) |
| Phone | `[data-automation-id="phone-number"]` | `CANDIDATE_PHONE` (helper) |
| Address | `[data-automation-id="addressSection_addressLine1"]` | `CANDIDATE_ADDRESS_LINE1` (helper) |
| City | `[data-automation-id="addressSection_city"]` | `CANDIDATE_CITY` (helper) |
| Zip | `[data-automation-id="addressSection_postalCode"]` | `CANDIDATE_ZIP` (helper) |
| Job title | `[data-automation-id="jobTitle"]` | `CANDIDATE_JOB_N_TITLE` (helper) |
| Company | `[data-automation-id="company"]` | `CANDIDATE_JOB_N_COMPANY` (helper) |
| Description | `[data-automation-id="description"]` | `CANDIDATE_JOB_N_DESCRIPTION` (helper) |
| Next button | `[data-automation-id="bottom-navigation-next-btn"]` | - |
| Create Account | `[data-automation-id="click_filter"][aria-label="Create Account"]` | - |

## Critical Rules
- headless: false always (Workday renders blank in headless)
- Confirm salary with user before every submission — never auto-fill
- After "You already applied to this job" error — that confirms a previous submission worked
- Use `{ force: true }` on Workday buttons — overlay click filters block normal clicks
- Always wait for networkidle or waitForSelector after navigation before interacting
