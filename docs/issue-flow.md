# Issue flow

The issue is the ledger. State is a label; a claim is one comment.

- States: `q:open` (default on file), `q:claimed`, `q:done` (PR merged, not yet verified), `q:delivered` (verified on the deployed build, issue closed).
- Source: every filer adds one of `src:muse`, `src:loop`, `src:osborn`, `src:founder` (the author field is always the founder's login, so it cannot tell sources apart). The issue template asks for it.
- Claim comment: `claim: <agent> <session> <expiry-iso>`, with the `q:claimed` label. Refresh it every 4 hours while working; the latest claim comment counts.
- Claim order: the main agent and local specialists claim first. Cloud agents (the hourly loop, Muse) claim only items `q:open` for over 24 hours, or `q:claimed` with an expired claim.
- Parked and founder-decision issues are listed in `docs/issue-sweep-config.json` and left out of the sweep's action lists.

## Sweep

`node scripts/issue-sweep.mjs [--json]` (needs `gh` logged in, or `GITHUB_TOKEN`; `OSBORN_REPO` overrides `Erriccc/osborn`) prints a report: age buckets, unlabelled, unclaimed, stale 7d+, open issues a merged PR mentions (close candidates), likely duplicates, expired claims. It is report-only: it never labels, comments or closes. A daily schedule and the labels themselves are follow-ups.
