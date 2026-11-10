# Mirroring in-app reports to GitHub Issues

_Implements [#44](https://github.com/Erriccc/osborn/issues/44)._

In-app "Report a bug / feature" submissions land in the private `bug_reports`
Supabase table (migration 003). Because this project is open source, each report
is now **also mirrored to GitHub Issues** on this repo, so outside developers and
external agents — not just the local agent reading `bug_reports` — can pick one up
and open a PR. The scheduled UI-test automation already posts its traced findings
here; user reports now arrive in the same place and shape.

## Flow

```
Report form (modal)  ─┐
                      ├─►  submitBugReport()  ──►  POST /api/report  ──►  insert into bug_reports (RLS, as the user)
Voice bug-reporter   ─┘        (client)            (server)                 └─►  mirrorReportToGitHub()  ──►  GitHub Issue / comment
```

- **`frontend/src/app/api/report/route.ts`** — the single server choke point.
  Inserts the row as the signed-in user (their cookies → RLS), then runs the
  mirror. The insert is authoritative; the mirror is best-effort and never blocks
  or fails the user's report.
- **`frontend/src/lib/github-issue-mirror.ts`** — the mirror itself (server-only;
  holds `GITHUB_TOKEN`).
- Both entry points (the modal and the voice/agent data-channel path in
  `VoiceRoom.tsx`) go through `submitBugReport`, so there is exactly one live
  mirror point.

## Privacy

The mirror function accepts **only** a `MirrorReport`, which is the allowlist:
`type`, `severity`, `title`, `description`, `reproduction_notes`, `tags`,
`osborn_version`, `voice_mode`. Account/session/machine internals —
`reporter_email`, `reporter_user_id`, `session_id`, `sandbox_id`, `log_url`, and
free-form `metadata` — are **not** on the type, so they cannot reach GitHub by
construction. `tests/github-issue-mirror.test.ts` asserts this directly (a report
carrying sentinel secrets produces a body that contains none of them).

The row in `bug_reports` still keeps the full context for internal triage; only
the GitHub mirror is stripped.

## Dedup

Every mirrored issue body carries a stable, searchable marker
`osborn-fp-<fingerprint>`, where the fingerprint is `sha256(type + normalized
title)`. Before opening a new issue the mirror searches for an **open** issue with
the same marker:

- **match found** → it adds a comment to that issue instead of filing a duplicate.
- **no match** → it opens a new issue, labeled `bug`/`enhancement` + `user-report`.

A recurrence after the issue was *closed* opens a fresh issue (the intended "it's
back" signal). Dedup relies on GitHub's search index, which can lag a minute or
two, so two near-simultaneous identical reports may rarely both open — acceptable
per the issue's "dedupe where possible".

## Setup (one env var)

The mirror is a **no-op** until a token is present, so nothing breaks in dev or on
un-configured deploys.

- Set **`GITHUB_TOKEN`** on the frontend (Railway) to a token with `issues:write`
  (and `repo` read) on this repository. A fine-grained PAT or a GitHub App
  installation token both work. The issues are authored by whatever identity owns
  the token — not the reporter.
- Optional **`GITHUB_REPO`** (default `Erriccc/osborn`) to retarget a fork/staging
  repo.
- The `user-report` label is created automatically on first use (best-effort).

## Notes / future

- Any signed-in user can cause a public issue to be filed; dedup collapses repeats
  of the same title, but spam rate-limiting is out of scope here and can be added
  at `/api/report` if needed.
- Storing the resulting issue number/URL back on the `bug_reports` row (to show a
  "view on GitHub" link) is a natural follow-up; it needs a service-role write,
  which Railway does not currently hold, so it was left out of this change.
