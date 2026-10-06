/**
 * render-ws-data.ts — script, captions and screen definitions for render-ws-story.ts.
 * Narration is TOPIC-ONLY (no first person), per user decision.
 * Code lines: verbatim from agent/src/index.ts (before = git a4388ca^ i.e. 0.9.152; after = current tree).
 * Log lines: verbatim from session recall rows (agent-ad1edf68 L98, agent-a346e43a L36), hostname -> <app>.
 */
import { codeScreen, termScreen, pathDiagram, compareDiagram, headerDiagram, editorScreen, lsScreen, endCard, type Line } from './render-ws-screens.js'

// Voice text (numbers spelled for TTS). CAPTIONS below are the on-screen form of the same words.
export const SCRIPT: string[] = [
  'One missing header killed this terminal. The editor loaded, but the terminal and file tree died instantly. Error ten-oh-six.',
  'Browser, Fly edge, a custom reverse proxy, then code-server.',
  'A hand-rolled tunnel got swapped for http-proxy. Still ten-oh-six.',
  'Yet a Cloudflare tunnel to code-server worked. So the proxy was the bug.',
  "code-server checks the browser's Origin against its own host.",
  "The proxy's changeOrigin rewrote Host to a local port, while Origin kept the public domain.",
  'Mismatch: four-oh-three, which the browser shows as ten-oh-six.',
  'code-server reads X-Forwarded-Host first. The proxy never sent it. The fix: set it to the original Host.',
  'Four-oh-three became one-oh-one. The terminal opened, and ls ran.',
  'The twist: tests without an Origin header passed, and fooled the debugging twice.',
  'One missing header. Fixed in osborn zero point nine point one fifty-three.',
]
export const CAPTIONS: string[] = SCRIPT.map((s) =>
  s.replace(/ten-oh-six/gi, '1006').replace(/four-oh-three/gi, '403').replace(/one-oh-one/gi, '101')
    .replace('zero point nine point one fifty-three', '0.9.153'))

const BEFORE: Line[] = [
  { n: 320, text: 'const wsProxy = httpProxy.createProxyServer({ target: IDE_TARGET, ws: true, changeOrigin: true })' },
  { n: '', text: '' },
  { n: 1610, text: "server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {" },
  { n: '…', text: '  // (path + agent-route checks)', hl: 'dim' },
  { n: 1613, text: '  if (ideProxyEnabled && hasValidIdeCookie(req) && !isAgentRoute) {' },
  { n: 1614, text: '    ideLastProxiedActivity = Date.now()' },
  { n: 1615, text: '    wsProxy.ws(req, socket, head, { target: IDE_TARGET })' },
  { n: 1616, text: '    return' },
  { n: 1617, text: '  }' },
  { n: 1618, text: '  socket.destroy()' },
  { n: 1619, text: '})' },
]
const AFTER = (hl: boolean): Line[] => [
  { n: 364, text: 'const wsProxy = httpProxy.createProxyServer({ target: IDE_TARGET, ws: true, changeOrigin: true })', hl: hl ? 'warn' : undefined },
  { n: '', text: '' },
  { n: 1813, text: '  if (ideProxyEnabled && hasValidIdeCookie(req) && !isAgentRoute) {' },
  { n: 1814, text: '    ideLastProxiedActivity = Date.now()' },
  { n: 1815, text: "    // code-server's authenticateOrigin() compares Origin against the effective host" },
  { n: 1816, text: '    // (X-Forwarded-Host first). changeOrigin:true rewrites Host→127.0.0.1:8300 while the' },
  { n: 1817, text: "    // browser's Origin stays the public hostname, causing a 403 → WS 1006. Preserve the" },
  { n: 1818, text: '    // real public host so the origin check matches.' },
  { n: 1819, text: "    if (!req.headers['x-forwarded-host'] && req.headers.host) {", hl: hl ? 'add' : undefined },
  { n: 1820, text: "      req.headers['x-forwarded-host'] = req.headers.host", hl: hl ? 'add' : undefined },
  { n: 1821, text: '    }', hl: hl ? 'add' : undefined },
  { n: 1822, text: '    wsProxy.ws(req, socket, head, { target: IDE_TARGET })' },
  { n: 1823, text: '    return' },
]

const RED = '#ff7b72', GREEN = '#3fb950', AMBER = '#d29922'
const T_HEAD: Line = { text: '=== WS host/origin matching tests ===', color: '#8b949e' }
const T_A: Line[] = [
  { text: 'Test A: host=127.0.0.1:8300 (what our proxy sends), origin=fly.dev (what browser sends)' },
  { text: "  Host='127.0.0.1:8300', X-Forwarded-Host=None: HTTP/1.1 403 Forbidden", color: RED, hl: 'bad' },
]
const T_B: Line[] = [
  { text: '' },
  { text: 'Test B: host=127.0.0.1:8300, X-Forwarded-Host=<app>.fly.dev (proposed fix)' },
  { text: "  Host='127.0.0.1:8300', X-Forwarded-Host='<app>.fly.dev': HTTP/1.1 101 Switching Protocols", color: GREEN, hl: 'add' },
]
const T_EDGE: Line[] = [{ text: '' }, { n: '#', text: 'after deploy, live over the public Fly edge:' }, { text: 'FLY-EDGE HTTP status: 101', color: GREEN, hl: 'add' }]
const T_D: Line[] = [
  { text: '' },
  { text: 'Test D: no origin (should pass per code-server)' },
  { text: "  Host='127.0.0.1:8300', X-Forwarded-Host=None: HTTP/1.1 101 Switching Protocols", color: AMBER, hl: 'warn' },
  { text: '' }, { n: '#', text: 'no Origin header → passes → false "it works"' },
]
const LOGTAG = 'REAL LOG · hostname redacted'

/** name -> svg. */
export const SCREENS: Record<string, () => string> = {
  editor: () => editorScreen(false),
  editorErr: () => editorScreen(true),
  path1: () => pathDiagram(1),
  path2: () => pathDiagram(2),
  before: () => codeScreen('agent/src/index.ts', 'before · 0.9.152 (http-proxy swap, still 1006)', BEFORE),
  beforeHl: () => codeScreen('agent/src/index.ts', 'before · 0.9.152 (http-proxy swap, still 1006)',
    BEFORE.map((l) => (l.n === 1615 ? { ...l, hl: 'bad' } : l.n === 320 ? { ...l, hl: 'warn' } : l))),
  compare: () => compareDiagram(),
  hdr1: () => headerDiagram(1),
  hdr2: () => headerDiagram(2),
  hdr3: () => headerDiagram(3),
  after: () => codeScreen('agent/src/index.ts', 'after · shipped in 0.9.153', AFTER(false)),
  afterHl: () => codeScreen('agent/src/index.ts', 'after · shipped in 0.9.153', AFTER(true)),
  termA: () => termScreen('verification run · node ws client', [T_HEAD, ...T_A], LOGTAG),
  termB: () => termScreen('verification run · node ws client', [T_HEAD, ...T_A, ...T_B], LOGTAG),
  termEdge: () => termScreen('verification run · node ws client', [T_HEAD, ...T_A, ...T_B, ...T_EDGE], LOGTAG),
  ls: () => lsScreen(),
  termD: () => termScreen('verification run · node ws client', [T_HEAD, ...T_A, ...T_D], LOGTAG),
  end: () => endCard(),
}

/** Per narration line: the screens shown during it (split evenly across the line's duration). */
export const LINE_SCREENS: string[][] = [
  ['editor', 'editorErr'], ['path1', 'path2'], ['before', 'beforeHl'], ['compare'], ['hdr1'], ['hdr2'], ['hdr3'],
  ['after', 'afterHl', 'afterHl'], ['termA', 'termB', 'termEdge', 'ls'], ['termD'], ['end'],
]

/** Artifact provenance per screen (for the report / shotlist). */
export const PROVENANCE: Record<string, string> = {
  editor: 'REENACTMENT (abstract workbench)', editorErr: 'REENACTMENT, modal text verbatim from user screenshot (recall agent-ad1edf68 L119)',
  path1: 'diagram of real topology (Fly edge -> agent :8741 -> code-server 127.0.0.1:8300)', path2: 'same',
  before: 'REAL code: index.ts @ a4388ca^ (0.9.152) lines 320, 1610-1619', beforeHl: 'same, highlighted',
  compare: 'diagram; Cloudflare-worked fact from editor-followups-and-origin-fix.md + code comment line 363',
  hdr1: 'diagram of real headers (root cause in recall + note)', hdr2: 'same', hdr3: 'same',
  after: 'REAL code: current index.ts lines 364, 1813-1823 (fix added in a4388ca)', afterHl: 'same, fix lines highlighted',
  termA: 'REAL log: recall agent-ad1edf68 L98 (Test A)', termB: 'REAL log: Test A+B', termEdge: 'REAL log: + recall agent-a346e43a L36 FLY-EDGE 101',
  ls: 'REENACTMENT: `$ ls` prompt only; outcome user-confirmed (editor-followups note), no output fabricated',
  termD: 'REAL log: Test D (no-Origin false pass)', end: 'end card (fix line verbatim from index.ts 1820)',
}
