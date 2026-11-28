# Where session research lives: `docs/research/` markdown by PR (#689)

Status: **design / not built.** Design pass for #621 (with #451, #653, #663, #685).

## Requirement

Findings must be durable, indexable and reusable by us and by other people. A session links to the project's existing repo (#653, #685). Repos are private by default. Incognito means no GitHub writes at all (#663).

## Options compared

| Option | Verdict |
|---|---|
| (a) Issues only | Closed looks stale. Noisiest. Saves nothing in incognito or before a repo is linked. |
| (b) Discussions for research | Must be enabled per repo, extra token scope, GraphQL only, not in the clone. Saves nothing in incognito. |
| (c) `docs/` committed by PR | Right format. On its own it cannot cover incognito, folder projects or the public/private split. |
| **(d) Hybrid (chosen)** | A markdown file is the record. Issues carry work and links only. The same file is written locally when there is no repo or the project is incognito. |
| Wiki | Private wikis need a paid plan, and the wiki is a separate repo agents miss. |

## Design

1. **Format.** One file per finding: `docs/research/YYYY-MM-DD-<slug>.md`. Frontmatter: `title`, `date`, `session`, `fingerprint` (the #451 dedup key), `visibility`, `status` (`under-review` | `accepted` | `superseded`), `sources`. `docs/research/INDEX.md` has one row per finding. An open PR means under review, a merged PR means accepted.
2. **Public/private split.** Each file has a `Findings` section (sourced facts) and a `Private` section (strategy, margins, legal-risk analysis). Private repos commit both. Public repos never get the Private section in the diff (v1 keeps it in a local, git-ignored file) and need explicit approval.
3. **Write path.**
   - Linked repo: branch `osborn/research/<slug>`, then a PR labelled `research`, then at most one link comment on the related issue. The owner merges.
   - Incognito or no repo: write the same file locally. No commits. The session panel shows the path.
4. **Guards.**
   - Check repo visibility live before every write.
   - Scan locally for secrets and personal data before committing.
   - Never make a repo public to publish. Publishing is a separate PR with only the Findings section.
5. **Reading back.** Grep the local clone first, then fetch `INDEX.md` through the Contents API, then fall back to code search.
6. **Migration.** Offer one import PR per project after linking. The owner picks the files. Nothing is backfilled automatically. Leaving incognito never imports on its own.
7. **Discussions.** Deferred. Later an opt-in layer for public conversation, never the record.

## Reuse (do not rebuild)

- Incognito and public mode: `readPublicSince` (`agent/src/config.ts`), as used by `flushSession` (`agent/src/loops-flush.ts`) and `issueGate` (`agent/src/issue-gate.ts`). The research writer calls the same check, so there is one definition of "may write to GitHub".
- Repo resolution: `repoFromCwd` (`loops-ledger.ts`) and the `OSBORN_FOLLOW_THROUGH_DEFAULT_REPO` fallback (`loops-flush.ts`), same `no-repo` outcome.
- Secret scan: `redactSecrets` (`agent/src/content/secret-rules.ts`). The pre-commit guard uses it as a blocker (reject if the redacted text differs), not as a rewriter.
- Frontend-held GitHub token: `postFollowThrough` goes through `/api/follow-through`. The PR path adds a sibling route with Contents and PRs scope on the linked repo only. Neither the agent nor the model holds the token.
- Dedup: the #451 fingerprint is the filename-independent key, so a rewritten finding updates its file instead of adding a second one.

## v1 acceptance (from #689)

- Private linked repo: a finding opens a `research`-labelled PR adding the file and an INDEX row. No new issue, at most one link comment.
- Public repo: the Private section is not in the diff, and the PR waits for explicit approval.
- A fake token planted in a finding is blocked before commit.
- Incognito: the file is written locally and the logs show zero GitHub write calls.
- A new session with recall off finds and quotes the merged finding through a local grep or one API call.
- The session panel shows the PR or file link and its status.

## Smallest experiment

Take the 28 Nov competitor map in a repo that is a clone of a connected repo (it already has a hand-written `docs/research-notes.md`). Write it as a `docs/research/` PR with a fake token planted. Confirm the token is blocked and the Private section is not in the diff. Merge, then ask a new session with recall off about competitors. Repeat in incognito and confirm nothing is sent to GitHub.

## Open questions

- Where the Private section lives locally (a git-ignored `docs/research/.private/` is the proposal).
- Personal-data scanning beyond `redactSecrets` (emails and paths are scrubbed by the frontend today, `frontend/src/lib/follow-through.ts`; names are not).
- Whether INDEX.md rows conflict across concurrent PRs: proposal is one row per file, sorted by date, with the owner resolving on merge.

## User time

Saves time: a finding is written once and found again in any later session, with no re-research. Costs one approval click on a public repo and one PR merge per finding on a linked repo; both are the point of the review step.
