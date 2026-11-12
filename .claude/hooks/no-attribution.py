#!/usr/bin/env python3
"""PreToolUse guard: refuse git commits and GitHub PR/issue writes that carry
a session link or AI attribution. Founder's standing rule (see CLAUDE.md,
"Attribution rules"). Reads the hook payload on stdin; prints a deny decision
when it matches, nothing otherwise. Fails open on any parse error."""
import json, re, sys

SESSION = re.compile(r"claude\.ai/code/session_|^\s*Claude-Session\s*:", re.I | re.M)
CREDIT = re.compile(
    r"^\s*Co-Authored-By\s*:.*(claude|anthropic)|Generated (with|by) \[?Claude", re.I | re.M
)

def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    sys.exit(0)

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool = payload.get("tool_name", "")
inp = payload.get("tool_input") or {}

if tool == "Bash":
    cmd = str(inp.get("command", ""))
    if re.search(r"\bgit\b[^\n;&|]*\b(commit|merge|tag|notes)\b|\bgh\s+pr\s+(create|edit)\b", cmd):
        if SESSION.search(cmd) or CREDIT.search(cmd):
            deny("Blocked by repo rule: no session links or AI attribution in commits or PRs "
                 "(CLAUDE.md, Attribution rules). Remove the trailer/footer and retry.")
elif tool.startswith("mcp__github__"):
    text = "\n".join(str(inp.get(k, "")) for k in ("body", "title", "message", "commit_message"))
    # PR titles/descriptions and commit messages: no credit of any kind.
    if re.search(r"pull_request|push_files|create_or_update_file|merge", tool):
        if SESSION.search(text) or CREDIT.search(text):
            # Strip it instead of refusing, so the call goes through clean.
            FOOTER = re.compile(r"\n*(?:-{3,}\s*\n)?\s*_?(?:\U0001F916\s*)?Generated (?:with|by) \[?Claude[^\n]*\n?", re.I)
            clean = {}
            for k in ("body", "title", "message", "commit_message"):
                v = inp.get(k)
                if not isinstance(v, str):
                    continue
                v = FOOTER.sub("\n", v)
                v = re.sub(r"^\s*(Co-Authored-By\s*:.*(claude|anthropic).*|Claude-Session\s*:.*)$\n?", "", v, flags=re.I | re.M)
                v = re.sub(r"\S*claude\.ai/code/session_\S*", "", v)
                clean[k] = v.rstrip()
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow",
                              "updatedInput": {**inp, **clean},
                              "permissionDecisionReason": "Attribution stripped (CLAUDE.md, Attribution rules)."}}))
            sys.exit(0)
    # Everything else posted to GitHub: never a session link.
    elif SESSION.search(text):
        deny("Blocked by repo rule: no session links in anything posted to GitHub "
             "(CLAUDE.md, Attribution rules).")
sys.exit(0)
