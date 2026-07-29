# Skill: Playwright Browser Automation

Automate web browser interactions — navigate pages, click buttons, fill forms, take screenshots, and extract content.

## When to use
- Navigate to a - URL and interact with it
- Click buttons or links by their text or role
- Fill form fields and submit data
- Take screenshots of web pages
- Extract text or structured data from pages
- Automate multi-step web workflows (e.g. join a room, test a UI flow)

## How to execute

Uses `@playwright/cli` via npx — no global install needed. Token-efficient: uses element references (e.g. `e15`) instead of pixel coordinates.

### First time only — install browser binaries
```bash
npx playwright install chromium
```

### Step 1 — Open a URL
```bash
npx @playwright/cli open https://localhost:3000
```

### Step 2 — Get page structure and element references
```bash
npx @playwright/cli snapshot
```
Returns an accessibility tree with element IDs like e1, e2, e15. Use these in subsequent commands.

### Step 3 — Interact with elements
```bash
npx @playwright/cli click e15
npx @playwright/cli fill e3 "some text"
npx @playwright/cli press e3 Enter
npx @playwright/cli select e7 "optionValue"
npx @playwright/cli check e9
npx @playwright/cli hover e12
```

### Take a screenshot
```bash
npx @playwright/cli screenshot --path=/tmp/page.png
```

### Take a screenshot at a specific viewport size (mobile check)
```bash
npx @playwright/cli screenshot --viewport-size=375,812 --path=/tmp/page-mobile.png
```
Common mobile sizes: `375,812` (iPhone 14), `390,844` (iPhone 14 Pro), `412,915` (Pixel 7), `768,1024` (iPad).

### Close the browser
```bash
npx @playwright/cli close
```

### Named sessions (persistent state across commands)
```bash
npx @playwright/cli -s=myflow open https://localhost:3000
npx @playwright/cli -s=myflow snapshot
npx @playwright/cli -s=myflow fill e3 "abc123"
npx @playwright/cli -s=myflow click e5
npx @playwright/cli -s=myflow close
```

## Complete example — join Osborn voice room
```bash
npx @playwright/cli open http://localhost:3000
npx @playwright/cli snapshot
npx @playwright/cli fill e3 "abc123"
npx @playwright/cli click e4
npx @playwright/cli screenshot --path=/tmp/osborn-joined.png
npx @playwright/cli close
```

## Complete example — check mobile layout
```bash
npx @playwright/cli open http://localhost:3000
npx @playwright/cli screenshot --viewport-size=375,812 --path=/tmp/mobile-375.png
npx @playwright/cli close
```

## Notes
- Runs headless by default. Add --headed to see the browser window.
- Install browsers first if needed: npx playwright install chromium
- Element IDs are session-scoped — run snapshot again after page changes
- Use `--viewport-size=WIDTH,HEIGHT` to simulate mobile screen sizes (e.g. `375,812` for iPhone 14)
- Use `--storage-state=/tmp/state.json` to save and restore session state (cookies, localStorage) across runs
