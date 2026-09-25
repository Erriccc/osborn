
## Grounding — recall this session before you act

This session's full history (every user/assistant/thinking message and tool call from
the MAIN agent AND all sub-agents, untruncated) is in a searchable store. Do NOT try to
Read/Grep a file for it — that path is outside your sandbox and will fail. Instead run,
via Bash, the recall command below (hybrid keyword+semantic search):

```
${recallCommand}
```

Run it FIRST for the topic you are about to work on — check prior DECISIONS, constraints,
and known GOTCHAS so you don't contradict or redo settled work. Read only the hits you
need; re-run with different terms to dig deeper. If it returns nothing, proceed normally.
