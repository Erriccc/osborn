# Where session research lives: `docs/research/` markdown by PR (#689)

Status: **design / not built.** Design pass for #621 (with #451, #653, #663, #685).

## Requirement

Findings must be durable, indexable and reusable by us and by other people. A session links to the project's existing repo (#653, #685). Incognito means no GitHub writes by the research writer (#663).

Two axes are kept apart throughout: **project mode** (#663: incognito or public, `readPublicSince`) and **repo visibility** (private or public on GitHub). Both must allow a write. Unknown repo visibility counts as public (`repoAccess` fails closed).

## Options compared

| Option | Verdict |
|---|---|
| (a) Issues only | Closed looks stale. Noisiest. Saves nothing in incognito or before a repo is linked. |
| (b) Discussions or Wiki | Discussions must be enabled per repo, need an extra token scope, are GraphQL only and not in the clone. Private wikis need a paid plan and are a separate repo agents miss. Neither saves anything in incognito. Deferred; later an opt-in layer for public conversation, never the record. |
| (c) `docs/` committed by PR | Right format. On its own it cannot cover incognito, folder projects or the public/private split. |
| **(d) Hybrid (chosen)** | A markdown file is the record. Issues carry work and links only. The same file is written locally when there is no repo or the project is incognito. |

## Design

1. **Format.** One file per finding: `docs/research/YYYY-MM-DD-<slug>.md`. Frontmatter: `title`, `date`, `session`, `id` (a stable key, so a rewritten finding updates its file), `sources`, and `superseded_by` when replaced. Review state is not stored in the file: an open PR is under review, a merged PR is accepted. The file's repo decides visibility.
2. **Index.** No committed INDEX.md in v1 (concurrent PRs would conflict on it). Reading back greps the frontmatter; an index can be generated on merge later.
3. **Public/private split.** Each file has a `Findings` section (sourced facts) and a `Private` section (strategy, margins, legal-risk analysis). A private repo in a public-mode project commits both. A public repo never gets the Private section in the diff (v1 keeps it in a local, git-ignored file), needs explicit approval, and holds security-sounding findings with the same rule as follow-through (`mayFile` / `looksSecurityRelated`).
4. **Write path.**
   - Public-mode project with a linked repo: branch `osborn/research/<slug>`, then a PR labelled `research`, then at most one link comment on the related issue. The owner merges. Only findings recorded at or after the project's `since` are written; nothing is back-filled.
   - Incognito or no repo: write the same file locally. No commits. The session panel shows the path.
5. **Guards.**
   - Check repo visibility live before every write (`repoAccess`).
   - Scan for secrets before committing; any hit blocks the commit.
   - Never make a repo public to publish. Publishing is a separate PR with only the Findings section.
6. **Reading back.** Grep the local clone first, then fetch the folder through the Contents API, then fall back to code search.
7. **Migration.** Offer one import PR per project after linking. The owner picks the files. Leaving incognito never imports on its own.

## Reuse (do not rebuild)

- Project mode: `readPublicSince` (`agent/src/config.ts`), as used by `flushSession` (`agent/src/loops-flush.ts`) and `issueGate` (`agent/src/issue-gate.ts`).
- Repo visibility: `repoAccess` (`frontend/src/lib/github-issue-mirror.ts`, returns `{canPush, isPrivate}`, fails closed). Public-repo hold: `mayFile` / `looksSecurityRelated` (`frontend/src/lib/follow-through.ts`).
- Repo resolution: `repoFromCwd` (`loops-ledger.ts`) and the `no-repo` outcome. `OSBORN_FOLLOW_THROUGH_DEFAULT_REPO` is documented as the repo follow-through files into; research gets its own setting rather than widening it.
- Secret scan: `detectSecrets` (`agent/src/content/secret-rules.ts`, the same rules as `redactSecrets`). The guard rejects on any hit; it does not rewrite the file.
- Frontend-held GitHub token: `postFollowThrough` goes through `/api/follow-through`, which uses one server-wide token and answers 403 to non-admins (per-user GitHub is #463). The PR path would be a sibling route with the same limits. Non-admin users get the local file only until #463.
- Stable `id`: #451's fingerprint is a content hash (`loopKey`, `reportFingerprint` style) and changes when the finding is rewritten, so it only detects exact duplicates. `id` is the slug (or session plus topic) and survives edits.

## Gaps to close first

- `git push` and `gh pr create` are gated by `issueGate` (#689): refused in incognito, approval mode in public. It guides the agent and is not a sandbox (`gh api`, `GH_REPO=` and a push from a script are not parsed), and the model has the user's own git credentials.
- The session panel has no artifact-status surface today; showing the PR or file link and its status is new UI work.

## v1 acceptance

- Public-mode project, private linked repo (admin user): a finding opens a `research`-labelled PR adding the file. No new issue, at most one link comment.
- Public repo: the Private section is not in the diff, a security-sounding finding is held, and the PR waits for explicit approval.
- A fake token planted in a finding is blocked before commit.
- Incognito: the file is written locally and the research writer makes zero GitHub write calls.
- A new session with recall off finds and quotes the merged finding through a local grep or one API call.
- The session panel shows the PR or file link and its status.

## Smallest experiment

Take one real finding in a repo that is a clone of a connected repo. Write it as a `docs/research/` PR with a fake token planted. Confirm the token is blocked and the Private section is not in the diff. Merge, then ask a new session with recall off about it. Repeat in incognito and confirm the writer sends nothing to GitHub.

## Open questions

- Where the Private section lives locally (a git-ignored `docs/research/.private/` is the proposal).
- Personal-data scanning beyond `detectSecrets` (emails and paths are scrubbed by the frontend today; names are not).

## User time

Saves time: a finding is written once and found again in any later session, with no re-research. Costs one approval click on a public repo and one PR merge per finding on a linked repo; both are the point of the review step. Non-admin users get local files only until #463.
