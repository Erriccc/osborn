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
Fill fields using `mcp__playwright__browser_fill_form` or individual `mcp__playwright__browser_type` calls.
Screenshot to confirm. Then ask user before clicking Create Account / Sign In.

### Step 2 — Start Application
If "Start Your Application" screen appears with Apply Manually button:
Screenshot it. Click "Apply Manually" using `mcp__playwright__browser_click`.
Screenshot after.

### Step 3 — My Information
Snapshot → fill each field → screenshot → ask user before clicking Next.

Fields to fill:
- First Name, Last Name, Phone
- Address, City, State (dropdown), Zip
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

## Candidate Data (Osborn Ojure)

- Email: osbornojure@gmail.com
- Password: Workday2026!
- First: Osborn, Last: Ojure
- Phone: 3127185561
- Address: 1234 N Michigan Ave, Chicago, IL 60601

Jobs:
1. Meta API Consultant at Prehype / Audos — April 2024 to Present
2. Full Stack Developer, Freelance — January 2016 to Present

Education:
1. A.S. Information Systems
2. B.S. Psychology

## Workday data-automation-id Selector Reference

| Field | Selector |
|---|---|
| Email | `input[type="email"]` |
| Password | `input[type="password"]` |
| First name | `[data-automation-id="legalNameSection_firstName"]` |
| Last name | `[data-automation-id="legalNameSection_lastName"]` |
| Phone | `[data-automation-id="phone-number"]` |
| Address | `[data-automation-id="addressSection_addressLine1"]` |
| City | `[data-automation-id="addressSection_city"]` |
| Zip | `[data-automation-id="addressSection_postalCode"]` |
| Job title | `[data-automation-id="jobTitle"]` |
| Company | `[data-automation-id="company"]` |
| Description | `[data-automation-id="description"]` |
| Next button | `[data-automation-id="bottom-navigation-next-btn"]` |
| Create Account | `[data-automation-id="click_filter"][aria-label="Create Account"]` |

## Critical Rules
- headless: false always (Workday renders blank in headless)
- Confirm salary with user before every submission — never auto-fill
- After "You already applied to this job" error — that confirms a previous submission worked
- Use `{ force: true }` on Workday buttons — overlay click filters block normal clicks
- Always wait for networkidle or waitForSelector after navigation before interacting

## Playwright Install Location
Run scripts from: `/Users/newupgrade/Desktop/Developer/osborn/frontend`
(playwright is in `node_modules` there)
