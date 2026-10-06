/**
 * render-ws-screens.ts — builds the screen-style PNGs for render-ws-story.ts.
 * Every code line / log line here is copied from a real artifact:
 *   - code: agent/src/index.ts at a4388ca^ (0.9.152, before) and the current tree (after)
 *   - logs: session recall rows (WS host/origin matching tests, FLY-EDGE status), hostname redacted
 * Anything not backed by a real artifact carries a visible REENACTMENT corner tag.
 * Requires FONTCONFIG_FILE pointing at a fonts.conf listing JetBrains Mono + Roboto (set by caller).
 */
import path from 'node:path'

export const W = 1080, H = 1920, OW = 1160, OH = 2062 // render oversize for pan/zoom headroom
const MONO = 'JetBrains Mono', SANS = 'Roboto'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type Hl = 'add' | 'bad' | 'warn' | 'dim' | undefined
export interface Line { n?: number | string; text: string; hl?: Hl; color?: string }

function wrap(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const indent = (text.match(/^\s*/)?.[0] || '') + '    '
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max)
    if (cut <= indent.length) cut = max
    out.push(rest.slice(0, cut))
    rest = indent + rest.slice(cut).trimStart()
  }
  out.push(rest)
  return out
}

// Minimal TS syntax colouring -> <tspan>s.
function colorize(src: string): string {
  if (/^\s*\/\//.test(src)) return `<tspan fill="#6a9955">${esc(src)}</tspan>`
  const re = /('[^']*'|`[^`]*`|\b(?:const|if|return|true|new)\b|\b\d[\d.]*\b)/g
  let out = '', last = 0, m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index))
    const t = m[0]
    const c = /^['`]/.test(t) ? '#ce9178' : /^\d/.test(t) ? '#b5cea8' : '#569cd6'
    out += `<tspan fill="${c}">${esc(t)}</tspan>`
    last = m.index + t.length
  }
  return out + esc(src.slice(last))
}

const HL_FILL: Record<string, string> = {
  add: 'rgba(46,160,67,0.28)', bad: 'rgba(248,81,73,0.26)', warn: 'rgba(210,153,34,0.28)',
}

function chrome(body: string, opts: { tag?: string; tagColor?: string; kicker?: string } = {}): string {
  const tag = opts.tag
    ? `<rect x="${W - 40 - opts.tag.length * 17 - 34}" y="150" width="${opts.tag.length * 17 + 34}" height="50" rx="8" fill="${opts.tagColor || '#d29922'}"/>` +
      `<text x="${W - 55}" y="184" text-anchor="end" font-family="${SANS}" font-weight="500" font-size="26" fill="#0d1117">${esc(opts.tag)}</text>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OW}" height="${OH}" viewBox="0 0 ${W} ${H}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1117"/><stop offset="1" stop-color="#05070a"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#g)"/>` +
    `<text x="48" y="110" font-family="${SANS}" font-weight="500" font-size="34" fill="#8b949e">${esc(opts.kicker || 'code-server  ·  WebSocket 1006')}</text>` +
    tag + body + `</svg>`
}

/** Editor-style code panel with optional per-line highlight. */
export function codeScreen(file: string, sub: string, lines: Line[], tag?: string): string {
  const FS = 28, LH = 46, MAX = 50, x0 = 40, top = 240
  const rows: { n: string; t: string; hl: Hl }[] = []
  for (const l of lines) wrap(l.text, MAX).forEach((t, i) => rows.push({ n: i ? '' : String(l.n ?? ''), t, hl: l.hl }))
  const h = 120 + rows.length * LH + 40
  let body = `<rect x="${x0}" y="${top}" width="${W - 2 * x0}" height="${h}" rx="18" fill="#1e1e1e" stroke="#30363d" stroke-width="2"/>` +
    [0, 1, 2].map((i) => `<circle cx="${x0 + 36 + i * 32}" cy="${top + 38}" r="10" fill="${['#f85149', '#d29922', '#3fb950'][i]}"/>`).join('') +
    `<text x="${x0 + 140}" y="${top + 47}" font-family="${MONO}" font-size="26" fill="#c9d1d9">${esc(file)}</text>` +
    `<text x="${x0 + 30}" y="${top + 98}" font-family="${SANS}" font-weight="500" font-size="28" fill="#8b949e">${esc(sub)}</text>`
  rows.forEach((r, i) => {
    const y = top + 150 + i * LH
    if (r.hl && HL_FILL[r.hl]) body += `<rect x="${x0 + 2}" y="${y - 34}" width="${W - 2 * x0 - 4}" height="${LH}" fill="${HL_FILL[r.hl]}"/>`
    if (r.hl === 'add' && r.n) body += `<text x="${x0 + 14}" y="${y}" font-family="${MONO}" font-size="${FS}" fill="#3fb950">+</text>`
    body += `<text x="${x0 + 92}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="22" fill="#6e7681">${esc(r.n)}</text>`
    body += `<text x="${x0 + 108}" y="${y}" font-family="${MONO}" font-size="${FS}" fill="#d4d4d4" xml:space="preserve"${r.hl === 'dim' ? ' opacity="0.45"' : ''}>${colorize(r.t)}</text>`
  })
  return chrome(body, { tag })
}

/** Terminal panel. Lines with `color` are rendered as-is; `label` lines (n='#') are sans annotations outside the log. */
export function termScreen(title: string, lines: Line[], tag: string, tagColor?: string): string {
  const FS = 28, LH = 46, MAX = 52, x0 = 40, top = 240
  const rows: { t: string; c: string; hl: Hl; label: boolean }[] = []
  for (const l of lines) {
    const label = l.n === '#'
    ;(label ? [l.text] : wrap(l.text, MAX)).forEach((t) => rows.push({ t, c: l.color || '#c9d1d9', hl: l.hl, label }))
  }
  const h = 100 + rows.length * LH + 40
  let body = `<rect x="${x0}" y="${top}" width="${W - 2 * x0}" height="${h}" rx="18" fill="#010409" stroke="#30363d" stroke-width="2"/>` +
    `<text x="${x0 + 30}" y="${top + 52}" font-family="${MONO}" font-size="24" fill="#8b949e">${esc(title)}</text>`
  rows.forEach((r, i) => {
    const y = top + 120 + i * LH
    if (r.hl && HL_FILL[r.hl]) body += `<rect x="${x0 + 2}" y="${y - 34}" width="${W - 2 * x0 - 4}" height="${LH}" fill="${HL_FILL[r.hl]}"/>`
    body += r.label
      ? `<text x="${x0 + 30}" y="${y}" font-family="${MONO}" font-size="26" fill="#d29922">${esc(r.t)}</text>`
      : `<text x="${x0 + 30}" y="${y}" font-family="${MONO}" font-size="${FS}" fill="${r.c}" xml:space="preserve">${esc(r.t)}</text>`
  })
  return chrome(body, { tag, tagColor })
}

function box(x: number, y: number, w: number, h: number, title: string, sub: string, stroke = '#30363d', fill = '#161b22'): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${fill}" stroke="${stroke}" stroke-width="3"/>` +
    `<text x="${x + w / 2}" y="${y + h / 2 - 4}" text-anchor="middle" font-family="${SANS}" font-weight="500" font-size="40" fill="#e6edf3">${esc(title)}</text>` +
    `<text x="${x + w / 2}" y="${y + h / 2 + 40}" text-anchor="middle" font-family="${MONO}" font-size="24" fill="#8b949e">${esc(sub)}</text>`
}
function arrow(x: number, y1: number, y2: number, color = '#8b949e', label = ''): string {
  return `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2 - 18}" stroke="${color}" stroke-width="5"/>` +
    `<polygon points="${x - 16},${y2 - 22} ${x + 16},${y2 - 22} ${x},${y2}" fill="${color}"/>` +
    (label ? `<text x="${x + 34}" y="${(y1 + y2) / 2 + 10}" font-family="${MONO}" font-size="24" fill="${color}">${esc(label)}</text>` : '')
}
const hdr = (x: number, y: number, s: string, c = '#c9d1d9', strike = false) =>
  `<text x="${x}" y="${y}" font-family="${MONO}" font-size="27" fill="${c}"${strike ? ' text-decoration="line-through"' : ''}>${esc(s)}</text>`

/** Request path diagram. step 1 = first two hops, 2 = all four hops. */
export function pathDiagram(step: number): string {
  const X = 190, BW = 700, BH = 170, ys = [250, 530, 810, 1090]
  const nodes: [string, string][] = [['Browser', 'Origin: https://<app>.fly.dev'], ['Fly edge', 'public TLS'], ['Agent reverse proxy', 'node http-proxy · :8741'], ['code-server', '127.0.0.1:8300']]
  let b = ''
  nodes.forEach(([t, s], i) => {
    if (step === 1 && i > 1) return
    b += box(X, ys[i], BW, BH, t, s)
    if (i < 3 && !(step === 1 && i >= 1)) b += arrow(W / 2, ys[i] + BH, ys[i + 1], '#58a6ff', i === 2 ? 'WebSocket upgrade' : '')
  })
  return chrome(b, { kicker: 'the request path' })
}

/** Cloudflare tunnel (worked) vs. the proxy path (1006). */
export function compareDiagram(): string {
  const row = (y: number, label: string, hops: string[], ok: boolean) => {
    const c = ok ? '#3fb950' : '#f85149'
    let s = `<text x="60" y="${y}" font-family="${SANS}" font-weight="500" font-size="36" fill="${c}">${esc(label)}</text>`
    hops.forEach((h, i) => { s += box(60, y + 40 + i * 140, 960, 110, h, '', ok ? '#238636' : '#30363d') })
    const endY = y + 40 + hops.length * 140
    s += `<rect x="60" y="${endY}" width="960" height="80" rx="14" fill="${ok ? 'rgba(46,160,67,0.2)' : 'rgba(248,81,73,0.2)'}"/>` +
      `<text x="540" y="${endY + 54}" text-anchor="middle" font-family="${MONO}" font-size="34" fill="${c}">${ok ? 'terminal works' : 'WebSocket close 1006'}</text>`
    return s
  }
  return chrome(row(250, 'Cloudflare quick tunnel', ['Browser', 'Cloudflare', 'code-server'], true) +
    row(830, 'Own reverse proxy', ['Browser', 'Fly edge', 'Agent proxy', 'code-server'], false), { kicker: 'same code-server, two paths' })
}

/** Header drop. step 1 = browser headers, 2 = proxy rewrite, 3 = 403. */
export function headerDiagram(step: number): string {
  let b = box(60, 240, 960, 110, 'Browser sends', '') +
    hdr(100, 410, 'Origin: https://<app>.fly.dev', '#58a6ff') + hdr(100, 455, 'Host:   <app>.fly.dev')
  if (step >= 2) {
    b += arrow(W / 2, 480, 580, '#d29922', 'changeOrigin: true') + box(60, 580, 960, 110, 'Proxy forwards', '', '#d29922') +
      hdr(100, 750, 'Origin: https://<app>.fly.dev', '#58a6ff') + hdr(100, 795, 'Host:   127.0.0.1:8300', '#d29922') +
      hdr(100, 840, 'X-Forwarded-Host: (never sent)', '#f85149', true)
  }
  if (step >= 3) {
    b += arrow(W / 2, 870, 970, '#f85149') + box(60, 970, 960, 140, 'code-server', 'authenticateOrigin()', '#f85149') +
      `<text x="540" y="1200" text-anchor="middle" font-family="${MONO}" font-size="30" fill="#e6edf3">&lt;app&gt;.fly.dev  ≠  127.0.0.1:8300</text>` +
      `<rect x="290" y="1240" width="500" height="110" rx="16" fill="#f85149"/>` +
      `<text x="540" y="1313" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="54" fill="#0d1117">403 → 1006</text>`
  }
  return chrome(b, { kicker: 'why the socket dies' })
}

/** Reenacted code-server workbench; modal text is verbatim from the user's screenshot. */
export function editorScreen(modal: boolean): string {
  let b = `<rect x="40" y="240" width="1000" height="1150" rx="14" fill="#1e1e1e" stroke="#30363d" stroke-width="2"/>` +
    `<rect x="40" y="240" width="70" height="1150" fill="#2c2c2c"/><rect x="110" y="240" width="260" height="1150" fill="#252526"/>` +
    `<text x="130" y="290" font-family="${SANS}" font-size="22" fill="#8b949e">EXPLORER</text>` +
    `<rect x="370" y="1000" width="670" height="390" fill="#181818"/><text x="390" y="1040" font-family="${SANS}" font-size="22" fill="#8b949e">TERMINAL</text>`
  for (let i = 0; i < 9; i++) b += `<rect x="130" y="${320 + i * 46}" width="${120 + ((i * 53) % 110)}" height="18" rx="9" fill="#3a3a3a"/>`
  for (let i = 0; i < 12; i++) b += `<rect x="400" y="${300 + i * 50}" width="${160 + ((i * 97) % 420)}" height="18" rx="9" fill="#333"/>`
  if (modal) {
    b += `<rect x="40" y="240" width="1000" height="1150" fill="rgba(0,0,0,0.55)"/>` +
      `<rect x="90" y="560" width="900" height="470" rx="16" fill="#252526" stroke="#f85149" stroke-width="3"/>`
    const t = ['An unexpected error occurred that requires a', 'reload of this page.', '', 'The workbench failed to connect to the server', '(Error: WebSocket close with status code 1006)']
    t.forEach((s, i) => { b += `<text x="130" y="${640 + i * 50}" font-family="${SANS}" font-size="${i > 2 ? 32 : 30}" fill="${i === 4 ? '#ff7b72' : '#e6edf3'}">${esc(s)}</text>` })
    b += `<rect x="770" y="930" width="180" height="64" rx="8" fill="#0e639c"/><text x="860" y="972" text-anchor="middle" font-family="${SANS}" font-size="28" fill="#fff">Reload</text>`
  }
  return chrome(b, { tag: modal ? 'REENACTMENT · error text verbatim' : 'REENACTMENT', kicker: 'browser code editor (code-server)' })
}

/** Reenacted terminal running ls (user-confirmed outcome; no output is shown because none was logged). */
export function lsScreen(): string {
  return termScreen('code-server terminal', [{ text: '$ ls', color: '#3fb950' }, { text: '_', color: '#c9d1d9' }],
    'REENACTMENT · outcome user-confirmed')
}

export function endCard(): string {
  const b = `<text x="540" y="560" text-anchor="middle" font-family="${SANS}" font-weight="500" font-size="88" fill="#e6edf3">One missing header.</text>` +
    `<rect x="60" y="680" width="960" height="150" rx="16" fill="#1e1e1e" stroke="#3fb950" stroke-width="3"/>` +
    `<text x="540" y="745" text-anchor="middle" font-family="${MONO}" font-size="30" fill="#ce9178">req.headers['x-forwarded-host']</text>` +
    `<text x="540" y="795" text-anchor="middle" font-family="${MONO}" font-size="30" fill="#d4d4d4">= req.headers.host</text>` +
    `<text x="540" y="990" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="96"><tspan fill="#f85149">403</tspan><tspan fill="#8b949e"> → </tspan><tspan fill="#3fb950">101</tspan></text>` +
    `<text x="540" y="1130" text-anchor="middle" font-family="${SANS}" font-weight="500" font-size="40" fill="#8b949e">fixed in osborn 0.9.153</text>`
  return chrome(b, { kicker: 'code-server behind a reverse proxy' })
}

export const pngPath = (dir: string, name: string) => path.join(dir, 'screens', `${name}.png`)
