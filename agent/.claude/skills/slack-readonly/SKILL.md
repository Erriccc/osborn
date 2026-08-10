# Slack (read-only) — search and read Slack from the shell

> 📅 **Last updated: 2026-08-09.** Recreated from scratch after the Mac data-loss events wiped the
> original global install. READ-ONLY by design: no posting, no reactions, no edits.

Use this skill when asked to find, read, or summarize Slack messages, threads, or channels.

## Auth
Requires a Slack token in `SLACK_TOKEN` (bot `xoxb-…` or user `xoxp-…`).
Load it from `/workspace/.claude/slack.env` if present:
```bash
[ -f /workspace/.claude/slack.env ] && export $(grep -v '^#' /workspace/.claude/slack.env | xargs)
```
If `SLACK_TOKEN` is unset, STOP and tell the user: "No Slack token on this machine — add one to
/workspace/.claude/slack.env (SLACK_TOKEN=xoxb-…). Create at api.slack.com/apps with read scopes:
channels:history channels:read groups:history groups:read search:read users:read."

## Read-only rules (hard)
- ONLY call GET/read Slack Web API methods listed below. NEVER `chat.postMessage`, `reactions.add`,
  or any method that writes. If asked to send/post, refuse and suggest the user do it themselves.

## Core calls (curl; all return JSON)
```bash
H="Authorization: Bearer $SLACK_TOKEN"
# list channels (public + private the token can see)
curl -s -H "$H" "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200"
# channel history (channel id from list)
curl -s -H "$H" "https://slack.com/api/conversations.history?channel=C0XXXX&limit=50"
# a thread
curl -s -H "$H" "https://slack.com/api/conversations.replies?channel=C0XXXX&ts=1234567890.123456"
# search (user tokens only; bot tokens can't search)
curl -s -H "$H" --get --data-urlencode "query=from:@nick linkedin" "https://slack.com/api/search.messages"
# user lookup
curl -s -H "$H" "https://slack.com/api/users.list?limit=200"
```

## Output discipline
- Summarize; quote only the messages that matter, with author + date.
- `ok:false` → report the exact `error` field (common: `missing_scope`, `not_in_channel` — the bot
  must be invited to a channel to read it; `search.messages` needs a USER token).
- Never echo the token into output or files.
