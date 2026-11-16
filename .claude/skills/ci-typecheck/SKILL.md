---
name: ci-typecheck
description: Type-check agent/ and frontend/ on GitHub instead of installing and building locally. Use when you need tsc results for your changes and the machine has no node_modules, or a local install would be slow or heavy.
---

# Type checks on GitHub

The `typecheck` workflow (`.github/workflows/typecheck.yml`) runs `tsc --noEmit` for
`agent/` and `frontend/` on GitHub, with npm's cache. Nothing is installed or built here.

## Run it

Pick one:

1. Push the work to a `check/` branch. Every push there starts the workflow:
   ```bash
   git push origin HEAD:check/<topic>
   ```
2. Start it on a branch that is already pushed (`packages` is both, agent or frontend; default both):
   ```bash
   gh workflow run typecheck.yml --ref <branch> -f packages="agent"
   ```

A pull request that changes `agent/src` TypeScript or its package files runs the agent check by itself. `frontend-lint.yml`
already checks the frontend on pull requests.

Both ways need a push, and every `git push` (a `check/` branch too) is refused until the
steward has signed off that commit (`.claude/hooks/pre-pr-gate.py` here,
`agent/src/steward-gate.ts` in Osborn). `gh workflow run` only works once this workflow is
on the default branch.

## Read the result

```bash
gh run list --workflow typecheck.yml --branch <branch> --limit 1
gh run watch <run-id> --exit-status
gh run view <run-id> --log-failed | grep -E "error TS[0-9]+" | head -50
```

Each package is its own job (`tsc (agent)`, `tsc (frontend)`), so one failing does not hide
the other. Errors print as `file(line,col): error TSxxxx: message`, one per line.

## Rules

- A run takes about one to three minutes. Push once with everything you want checked,
  rather than once per edit.
- `check/` branches are scratch: delete them when you are done
  (`git push origin --delete check/<topic>`).
- Do not push secrets or unreviewed work to a shared branch to get a check. Use `check/`.
