#!/usr/bin/env python3
"""PreToolUse gate: no pull request is opened until the adversarial pre-PR
review (.claude/agents/pre-pr-reviewer.md) has run on the exact commit being
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
else:
    sys.exit(0)

def git(*a):
    return subprocess.run(["git", *a], capture_output=True, text=True, cwd=os.environ.get("CLAUDE_PROJECT_DIR", ".")).stdout.strip()

sha = git("rev-parse", ref) or git("rev-parse", f"origin/{ref}")
if not sha:
    sys.exit(0)
marker = os.path.join(git("rev-parse", "--absolute-git-dir"), "pre-pr-reviewed")
reviewed = open(marker).read().strip() if os.path.exists(marker) else ""
if reviewed != sha:
    deny(f"Pre-PR review required (CLAUDE.md). Run the pre-pr-reviewer agent (.claude/agents/pre-pr-reviewer.md) "
         f"on origin/main...{sha[:8]}, fix or answer its findings, then record it: "
         f"git rev-parse {ref} > \"$(git rev-parse --git-dir)/pre-pr-reviewed\" and retry.")
sys.exit(0)
