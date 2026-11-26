# Issue flow

The issue is the ledger. State is a label; a claim is the label plus a comment, branch or PR.

- States: `q:open` (the issue template sets it), `q:claimed`, `q:done` (PR merged, not yet verified), `q:delivered` (verified on the deployed build, issue closed).
- Source: every filer adds one of `src:muse`, `src:loop`, `src:osborn`, `src:founder` (the author field is always the founder's login, so it cannot tell sources apart). The issue template asks for it; Osborn's own filers (`frontend/src/lib/github-issue-mirror.ts`) do not add it yet.
- Claim: for the autopilot network, the `q:claimed` label plus an `auto/<n>-*` branch or an open PR naming the issue (it runs as Claude Code cloud sessions, which post no GitHub text (CLAUDE.md), so there is no claim comment; the sweep does not list it as expired while the branch or PR exists). Agents that post as the owner (local agents, and the hourly loop and Muse, a separate worker that posts through an owner-identity gateway, not a Claude Code session) use a claim comment `claim: <agent> <session> <expiry-iso>` (exactly three tokens after `claim:`, the shape `scripts/issue-sweep.ts` parses), refreshed every 4 hours; the sweep reads the latest one.
- Claim order: the main agent and local specialists claim first. The hourly loop and Muse claim only items `q:open` for over 24 hours, or `q:claimed` with an expired claim. The network hub claims immediately unless a live claim, branch or open PR exists.
- Parked and founder-decision issues are the JSON lists in `docs/issue-sweep-config.json` (`parked`, `founderDecision`); labels for them do not exist yet. They are left out of the sweep's action lists, as are issues labelled `follow-through` (notes, not work orders) in Unclaimed, Claimable and Stale.

## Sweep

`npx tsx scripts/issue-sweep.ts [--json]` (needs the `gh` CLI, logged in or with `GH_TOKEN`; `GITHUB_REPO` overrides `Erriccc/osborn`, as for the report mirror) prints a report: age buckets, unlabelled, unclaimed, stale 7d+, open issues a merged PR mentions anywhere in its title or body (close candidates: any `#N` counts, not only closing keywords, so check each before closing), likely duplicates (similar titles), expired claims. It is report-only: it never labels, comments or closes. A daily schedule and the labels themselves are follow-ups.

## Not enforced yet

- Of the `q:*` and `src:*` labels only `q:claimed` exists in the repo; the sweep reads `q:claimed` only.
- The 24-hour cloud-claim window is a process rule. The sweep only lists "claimable by cloud agents": open issues with no `q:claimed` label and no open PR, created over 24 hours ago.
- Unclaimed means no `q:claimed` label and no OPEN PR mentioning the issue (a merged PR that mentioned it is not a claim: it shows under close candidates instead). Comment counts are not a claim signal.
- A claim with an expiry that is not a full ISO time with `Z` or an offset counts as expired ("bad expiry").
- Duplicates are pairs sharing at least 2 title terms with Jaccard similarity of 0.5 or more.
- No scheduled workflow runs the sweep: workflow files cannot be pushed from the cloud session that built it.
- `--slurp` needs `gh` 2.48 or newer.
