#!/usr/bin/env python3
"""PreToolUse gate: no branch is pushed until the steward has signed off on the
commit being pushed (so updating an open PR needs it too), and no pull request
is opened until the steward
(.claude/agents/steward.md) and the adversarial pre-PR review
(.claude/agents/pre-pr-reviewer.md) have both run on the exact commit being
proposed. Record a finished review with:
    git rev-parse HEAD > "$(git rev-parse --git-dir)/pre-pr-reviewed"
Fails open on anything unexpected, so a broken gate never blocks real work."""
import json, os, re, subprocess, sys

def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))
    sys.exit(0)

try:
    p = json.load(sys.stdin)
except Exception:
    sys.exit(0)
tool, inp = p.get("tool_name", ""), p.get("tool_input") or {}
if tool == "mcp__github__create_pull_request":
    ref = str(inp.get("head") or "HEAD").split(":")[-1]
elif tool == "Bash" and re.search(r"(^|[;&|(]\s*|\n\s*)gh\s+pr\s+create\b", str(inp.get("command", ""))):
    ref = "HEAD"  # only when the command RUNS it, not when the text appears in it
elif tool == "Bash" and re.search(r"(^|[;&|(]\s*|\n\s*)git\s+(-\S+\s+)*push\b", str(inp.get("command", ""))) \
        and not re.search(r"\s(--delete|-d)\b|\s:\S", str(inp.get("command", ""))):
    # a branch delete ships no commit: not gated
    tool, ref = "push", "HEAD"  # a push updates the branch (and any open PR on it): steward sign-off only
else:
    sys.exit(0)

PROJECT = os.environ.get("CLAUDE_PROJECT_DIR", ".")
def git(*a, cwd=PROJECT):
    return subprocess.run(["git", *a], capture_output=True, text=True, cwd=cwd).stdout.strip()

if tool == "push":
    # Which repo does it push? The agent's own command parser (steward-gate.ts gitActions)
    # follows `cd`, `git -C` and subshells. Only a push from this repo is gated; if the
    # parser cannot run, the push is treated as this repo's.
    try:
        out = subprocess.run(
            [os.path.join(PROJECT, "agent", "node_modules", ".bin", "tsx"), "-e",
             "import('./agent/src/steward-gate.ts').then(m => console.log(JSON.stringify(m.gitActions(process.env.GATE_CMD, process.cwd()))))"],
            capture_output=True, text=True, timeout=30, cwd=PROJECT, env={**os.environ, "GATE_CMD": str(inp.get("command", ""))})
        dirs = [h["dir"] for h in json.loads(out.stdout) if h.get("action") == "push"]
    except Exception:
        dirs = [PROJECT]
    top = git("rev-parse", "--show-toplevel")
    if not any(git("rev-parse", "--show-toplevel", cwd=d) == top for d in dirs if os.path.isdir(d)):
        sys.exit(0)

sha = git("rev-parse", ref) or git("rev-parse", f"origin/{ref}")
if not sha:
    sys.exit(0)
marker = os.path.join(git("rev-parse", "--absolute-git-dir"), "pre-pr-reviewed")
reviewed = open(marker).read().strip() if os.path.exists(marker) else ""
# The PR body is the decision record: every template section filled, the steward's verdict included.
body = str(inp.get("body") or "")
if tool == "mcp__github__create_pull_request":
    sections = dict(re.findall(r"^## (.+?)\s*$\n(.*?)(?=^## |\Z)", body, re.M | re.S))
    def empty(name):  # "## Tested (manual)" or "## net-new" still count as the section
        texts = [v for k, v in sections.items() if k.strip().lower().startswith(name.lower())]
        return not any(re.sub(r"<!--.*?-->", "", t, flags=re.S).strip() for t in texts)
    tpl = os.path.join(git("rev-parse", "--show-toplevel"), ".github", "pull_request_template.md")
    headings = re.findall(r"^## (.+?)\s*$", open(tpl).read(), re.M) if os.path.exists(tpl) else []
    missing = [h for h in headings if empty(h)]
    if missing:
        deny("Fill every PR template section (.github/pull_request_template.md) — empty or missing: " + ", ".join(missing) +
             ". Net-new and Removed come from the steward's lists; Steward is its verdict line. "
             "(Checked for PRs opened with the GitHub tool; `gh pr create` bodies are not inspected.)")
steward = os.path.join(git("rev-parse", "--absolute-git-dir"), "steward-reviewed")
if (open(steward).read().strip() if os.path.exists(steward) else "") != sha:
    if tool == "push":
        deny(f"Steward sign-off required before pushing {sha[:8]} (CLAUDE.md). Run the steward agent on origin/main...{sha[:8]}; "
             f"it records \"$(git rev-parse --git-dir)/steward-reviewed\". Commit first, then push in a separate command.")
    deny(f"Steward sign-off required (CLAUDE.md). Run the steward agent (.claude/agents/steward.md) on "
         f"origin/main...{sha[:8]} first; it records its CLEAN verdict in \"$(git rev-parse --git-dir)/steward-reviewed\". "
         f"Put its NET-NEW and REMOVED lists in the PR description.")
if reviewed != sha and tool != "push":
    deny(f"Pre-PR review required (CLAUDE.md). Run the pre-pr-reviewer agent (.claude/agents/pre-pr-reviewer.md) "
         f"on origin/main...{sha[:8]}, fix or answer its findings, then record it: "
         f"git rev-parse {ref} > \"$(git rev-parse --git-dir)/pre-pr-reviewed\" and retry.")
sys.exit(0)
