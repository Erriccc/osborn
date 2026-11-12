# Contributing to Voice Native (Osborn)

Thanks for being here. Voice Native is an open-source, voice-first AI coding
agent — you talk, it researches your code, plans, and builds. Contributions of
any size are welcome, from a typo fix to a new voice mode.

## Ways to help

- **Pick an open issue.** Start with ones labelled
  [`good first issue`](https://github.com/Erriccc/osborn/labels/good%20first%20issue)
  when available — they're scoped so you can land one cold.
- **Report a bug or request a feature.** Use the in-app **Report** button at
  [voice-native.com](https://www.voice-native.com) or open a
  [GitHub issue](https://github.com/Erriccc/osborn/issues/new). In-app reports are
  automatically mirrored to Issues here (no account/session details are shared), so
  you can pick one up and open a PR.
- **Improve the docs.** The `docs/` folder holds runbooks and design notes; the
  README is the front door.

## Repo layout

| Path | What it is |
|------|------------|
| `agent/` | The LiveKit voice agent (Node/TypeScript) — Claude Agent SDK session, fast brain, meeting bot. |
| `frontend/` | The Next.js web app (Railway) — dashboard, voice room, auth, APIs. |
| `mobile/` | The Expo / React Native app (iOS). |
| `frontend/native/` | The Capacitor iOS shell (thin WKWebView wrapper). |
| `docs/` | Runbooks, parity maps, design notes. |

## Local setup

See **Local Development** in the [README](README.md#option-2-local-development) for
the full agent + frontend setup (LiveKit, Anthropic/Google keys). The fastest
way to *try* the product without any setup is to just
[talk to it live](https://www.voice-native.com).

## Before you open a PR

This repo has no monorepo test runner — checks are per-app and lightweight:

- **Type-check** the app(s) you touched:
  ```bash
  cd frontend && npx tsc --noEmit      # and/or
  cd agent && npx tsc --noEmit
  ```
- **Run the relevant tests.** Tests are standalone and run directly with `tsx`:
  ```bash
  cd frontend && npx tsx tests/<name>.test.ts
  cd agent && npx tsx tests/<name>.test.ts
  ```
  `cd frontend && npm test` runs the whole frontend suite, and CI runs it on
  every PR touching `frontend/**`, so a failure there blocks the merge. The
  runner and two of the suites need deps that are deliberately NOT in
  `package.json` (they would ship to production for test-only use) — install
  them once with
  `cd frontend && npm i --no-save --no-package-lock tsx@4.23.15 @electric-sql/pglite@0.5.16`.
  Add a test in the same style (`node:assert`, a tiny `t()` harness) when you change
  behavior — see `frontend/tests/bug-report.test.ts` for the pattern.
- CI runs `frontend-lint` (tsc + the frontend suite + the shipped-skill secret
  scanner) on every PR, and the iOS workflows run build
  + Maestro UI smoke flows on changes to `mobile/**` or `frontend/native/**`.

## PR conventions

- **Keep PRs small and focused** — one issue/behavior per PR.
- **Reference the issue** (`Closes #NN`).
- **Conventional-ish commit subjects** (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- **Keep the build green** — don't merge red CI.
- Describe the user-visible change and how you verified it.

## Code of conduct

Be kind, assume good faith, and keep it constructive. Harassment or demeaning
behavior isn't welcome. Maintainers may remove comments/commits and block accounts
that don't follow this.

## Roadmap

Curious where things are headed? See [ROADMAP.md](ROADMAP.md).
