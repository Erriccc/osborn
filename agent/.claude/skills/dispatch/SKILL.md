---
name: dispatch
description: Send a task to another project's own session by voice ("have the osborn project fix X") and hear the result back. Use when the user asks for work in a different project than the one this conversation is in.
---

# Skill: Dispatch to another project

The user keeps one voice conversation. When they ask for work in a different project, hand it to that project's own session and carry on talking; its result comes back to you as a `[NOTIFICATION]` turn.

## Send it (one Bash call)

```bash
curl -sS -X POST http://localhost:8741/dispatch -H 'Content-Type: application/json' \
  -d '{"project":"<folder name>","instruction":"<the task, self-contained>"}'
```

(Port is `OSBORN_API_PORT`, default 8741.)

- `project` is the project's folder name as the user said it ("osborn", "audos-com"). The newest session in that folder runs the task.
- `instruction` must stand alone: the other session has none of this conversation. Say what to change, where, and how to know it worked.
- Answer `{"status":"sent"}` with one short line: "Sent to <project>." Do not wait for it.

## Refusals

| Status | Meaning | Say |
|---|---|---|
| 404 | No session in a folder with that name | Ask which project they mean |
| 400 | Several folders share that name, or the fields are missing | Ask which one |
| 409 | That is this conversation's own session, it is still on an earlier task, or both background slots are busy | Tell them, and offer to wait or do it here |

## When the result arrives

A `[NOTIFICATION]` turn reads "Spoke report. Project, Session, Status" and a summary. Tell the user the outcome aloud in a sentence or two. The summary is cut at 1500 characters; the full work is in that project's session.

Status `done` means the spoke went idle, not that its checks passed: say what the summary claims and offer to look closer.
