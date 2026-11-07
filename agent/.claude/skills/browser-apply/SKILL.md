---
name: browser-apply
description: Interactively automate Workday and other multi-step JS-heavy job application forms using Playwright MCP browser tools, filling one page at a time with a screenshot and user confirmation before advancing. Use when applying to a Workday ATS or any staged online job application needing visible, confirmable progress.
---

# Skill: Browser Apply — Step-by-Step Workday Application

Automate Workday job applications interactively, one step at a time. Each step takes a screenshot, confirms what's on screen, fills the current page, and waits before proceeding.

**This skill uses the Playwright MCP tools** (`mcp__playwright__browser_*`) for direct browser control — no scripts needed.

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

## Step-by-Step Execution Pattern

### Step 0 — Open the browser
Use: `mcp__playwright__browser_navigate` with the applyManually URL

Then: `mcp__playwright__browser_take_screenshot` — show the user what loaded

### Step 1 — Create Account / Sign In
Take a snapshot with `mcp__playwright__browser_snapshot` to see element refs.
Fill the email and password fields with the helper (see "Filling secret fields" below), never by typing values through `mcp__playwright__browser_type` / `browser_fill_form`.
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
Snapshot → click Add for each job entry → fill title/company/dates/description → save each → screenshot.
Then add education entries.
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
`~/.osborn/candidate.env` (or the path in `$CANDIDATE_ENV_FILE`), `chmod 600`. Template: `candidate.example.env` next to this file.

| Value | Env name |
|---|---|
| Email | `$CANDIDATE_EMAIL` |
| Password | `$CANDIDATE_PASSWORD` |
| First / Last name | `$CANDIDATE_FIRST_NAME` / `$CANDIDATE_LAST_NAME` |
| Phone | `$CANDIDATE_PHONE` |
| Address line 1 | `$CANDIDATE_ADDRESS_LINE1` |
| City / State / Zip | `$CANDIDATE_CITY` / `$CANDIDATE_STATE` / `$CANDIDATE_ZIP` |

Jobs:
1. Meta API Consultant at Prehype / Audos — April 2024 to Present
2. Full Stack Developer, Freelance — January 2016 to Present

Education:
1. A.S. Information Systems
2. B.S. Psychology

### Filling secret fields
Use the helper `fill.mjs` next to this SKILL.md (normally `~/.claude/skills/browser-apply/fill.mjs`). It reads the secret file itself, refuses to run unless the file is mode 600, connects to the open browser over CDP (`$CANDIDATE_CDP_URL`, default `http://127.0.0.1:9222`) and fills the fields in its own process. It prints only `filled NAME -> selector`, never a value.

```bash
node ~/.claude/skills/browser-apply/fill.mjs check
node ~/.claude/skills/browser-apply/fill.mjs fill --url-contains myworkdayjobs \
  CANDIDATE_EMAIL 'input[type="email"]' \
  CANDIDATE_PASSWORD 'input[type="password"]'
```

Rules:
- NEVER `cat`, `less`, `head`, `echo`, `printenv`, `env`, `grep`, `Read` or otherwise print the secret file or the `CANDIDATE_*` variables.
- NEVER pass a value to an MCP browser tool or put one in a command line; pass env NAMES only.
- If `check` reports the file missing or too open, tell the user to create it from `candidate.example.env` and run `chmod 600`; do not create it with values yourself.
- If no browser is reachable over CDP (the Playwright MCP must be attached to a CDP browser, e.g. `--cdp-endpoint`), stop and ask the user to type the secret fields themselves.

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
| Job title | `[data-automation-id="jobTitle"]` | Jobs list above |
| Company | `[data-automation-id="company"]` | Jobs list above |
| Description | `[data-automation-id="description"]` | Jobs list above |
| Next button | `[data-automation-id="bottom-navigation-next-btn"]` | - |
| Create Account | `[data-automation-id="click_filter"][aria-label="Create Account"]` | - |

## Critical Rules
- headless: false always (Workday renders blank in headless)
- Confirm salary with user before every submission — never auto-fill
- After "You already applied to this job" error — that confirms a previous submission worked
- Use `{ force: true }` on Workday buttons — overlay click filters block normal clicks
- Always wait for networkidle or waitForSelector after navigation before interacting

## Playwright Install Location
Run scripts from: `/Users/newupgrade/Desktop/Developer/osborn/frontend`
(playwright is in `node_modules` there)
