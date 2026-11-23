---
name: dispatch
description: Send a task to another project's own session by voice ("have the osborn project fix X") and hear the result back. Use when the user asks for work in a different project than the one this conversation is in.
---

# Skill: Dispatch to another project

The user keeps one voice conversation. When they ask for work in a different project, hand it to that project's own session and carry on talking; its result comes back to you as a `[NOTIFICATION]` turn.

## Send it (one Bash call)

```bash
curl -sS -X POST http://localhost:8741/dispatch -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $OSBORN_SYNC_TOKEN" -H "X-Osborn-Dispatch-Key: __OSBORN_DISPATCH_APPROVAL__" \
  --data-binary @- <<'EOF'
{"project":"<folder name>","instruction":"<the task, self-contained>"}
EOF
```

(Port is `OSBORN_API_PORT`, default 8741.)

- `project` is the project's folder name as the user said it ("osborn", "audos-com"). The newest session in that folder runs the task.
- `instruction` must stand alone: the other session has none of this conversation. Say what to change, where, and how to know it worked.
- Keep the key header exactly as written: `__OSBORN_DISPATCH_APPROVAL__` is not a secret, it is a marker. The command always goes through the approval dialog (the saved approval mode applies, in a phone call or an allow-all session too), and only an approved command gets a one-time key swapped in. A command that skips the dialog is refused with 401/403. A background session has no approval path, so it can never dispatch; never use this skill from one.
- Answer `{"status":"sent"}` with one short line: "Sent to <project>." Do not wait for it.

## Refusals

| Status | Meaning | Say |
|---|---|---|
| 404 | No session in a folder with that name | Ask which project they mean |
| 400 | Several folders share that name, or the fields are missing | Ask which one |
| 409 | That is this conversation's own session, it is still on an earlier task, both background slots are busy, or its newest session was active in the last few minutes (maybe open in a terminal) | Tell them, and offer to wait or do it here |
| 401 / 403 | The headers were missing or wrong | Tell the user dispatch is unavailable |
| 500 | The project's session would not start | Tell them it failed to start |

## When the result arrives

A `[NOTIFICATION]` turn reads "Spoke report. Project, Session, Status" and a summary. Tell the user the outcome aloud in a sentence or two. The summary is cut at 1500 characters; the full work is in that project's session.

If the user hangs up before the spoke finishes, the spoke is stopped and no result comes back; work done so far stays in its session.

Status `done` means the spoke went idle, not that its checks passed: say what the summary claims and offer to look closer.

## Known limits

- Hanging up stops the spoke; its unfinished work stays in its session and nothing is spoken back.
- The spoke does not run the named-agent chain (tester, steward, reviewer): it runs as a plain session, so `done` means idle, not verified.
- No time or spend budget; a spoke still working after an hour is reported as timed out and keeps running.
- At most two spokes at once, and one dispatch per project at a time.
