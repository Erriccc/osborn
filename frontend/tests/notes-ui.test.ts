// Run: cd frontend && npx --yes tsx tests/notes-ui.test.ts
// Static checks for UI item 26 gaps 2, 4, 5 (lane L20): no <button> nested in a
// <button> in the notes shelf, note cards open NoteSheet, the sheet deletes via
// DELETE /api/notes?id= behind one confirm step, and attachments reach the row.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')
const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 300)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }

// Max nesting depth of interactive elements (<button>, or any tag with
// role="button"). Brace-aware tag scan so `=>` inside onClick={...} does not end
// a tag early. Strips {/* */} comments first.
function interactiveDepth(src: string): number {
  const s = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  const stack: boolean[] = []
  let depth = 0, max = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '<' || !/[a-zA-Z/]/.test(s[i + 1] || '')) continue
    // read the whole tag, skipping over {...} expressions and quoted strings
    let j = i + 1, braces = 0, quote = ''
    for (; j < s.length; j++) {
      const c = s[j]
      if (quote) { if (c === quote) quote = ''; continue }
      if (c === '"' || c === "'" || c === '`') { if (braces === 0 && c !== '`') { quote = c; continue } }
      if (c === '{') braces++
      else if (c === '}') braces--
      else if (c === '>' && braces === 0) break
    }
    const tag = s.slice(i, j + 1)
    const name = (tag.match(/^<\/?([a-zA-Z][\w.]*)/) || [])[1]
    if (!name || !/^[a-z]/.test(name)) { i = j; continue } // skip components / generics
    if (tag.startsWith('</')) {
      const was = stack.pop()
      if (was) depth--
      i = j; continue
    }
    const interactive = name === 'button' || /role="button"/.test(tag)
    const selfClose = /\/>$/.test(tag)
    if (interactive) max = Math.max(max, depth + 1)
    if (!selfClose) { stack.push(interactive); if (interactive) depth++ }
    i = j
  }
  return max
}

const feed = read('src/components/dashboard/ActivityFeed.tsx')
const sheet = read('src/components/dashboard/NoteSheet.tsx')

t('ActivityFeed: no button nested inside a button', () => {
  ok(!/role="button"/.test(feed), 'role="button" wrapper would still nest the Copy button (axe nested-interactive)')
  ok(interactiveDepth(feed) === 1, `interactive nesting depth ${interactiveDepth(feed)}`)
})
t('NoteSheet: no button nested inside a button', () => ok(interactiveDepth(sheet) === 1, `depth ${interactiveDepth(sheet)}`))
t('ActivityFeed: note rows carry attachments', () => ok(/kind: 'note' as const[^\n]*attachments/.test(feed), 'attachments dropped from note rows'))
t('ActivityFeed: note card opens NoteSheet', () => {
  ok(/<NoteSheet\b/.test(feed), 'NoteSheet not rendered')
  ok(/setOpenNote\(n\)/.test(feed), 'card click does not open the sheet')
})
t('ActivityFeed: deleted note leaves the list', () => ok(/onDeleted=\{[^}]*setNotes\(ns => ns\.filter/.test(feed), 'no list removal on delete'))
t('NoteSheet: DELETE /api/notes?id= only after a confirm step', () => {
  ok(/fetch\(`\/api\/notes\?id=\$\{encodeURIComponent\(note\.id\)\}`, \{ method: 'DELETE' \}\)/.test(sheet), 'no DELETE call')
  ok(/onClick=\{\(\) => setConfirming\(true\)\}/.test(sheet), 'first Delete does not arm a confirm')
  ok(/onClick=\{doDelete\}/.test(sheet) && /confirming \?/.test(sheet), 'doDelete not gated by confirming')
})
t('NoteSheet: no client-supplied user id is sent', () => ok(!/user_id|userId/.test(sheet), 'sheet sends a user id'))
t('NoteSheet: shows the full text (no line clamp) and a dialog role', () => {
  ok(!/line-clamp/.test(sheet), 'text clamped in sheet')
  ok(/role="dialog"/.test(sheet) && /aria-modal="true"/.test(sheet), 'not a modal dialog')
})

async function behaviour() {
  const m: any = await import('../src/components/dashboard/NoteSheet')
  const { safeAttachmentHref, attachmentLabel } = m
  t('safeAttachmentHref: javascript: attachment is not a link', () => {
    ok(safeAttachmentHref('javascript:alert(1)') === null, 'javascript: produced an href')
    ok(safeAttachmentHref('JavaScript:alert(1)') === null, 'mixed-case javascript: produced an href')
    ok(safeAttachmentHref('data:text/html,<script>1</script>') === null, 'data: produced an href')
    ok(safeAttachmentHref('not a url') === null, 'unparseable string produced an href')
  })
  t('safeAttachmentHref: http(s) attachments stay links', () => {
    ok(safeAttachmentHref('https://x.supabase.co/storage/a.png') === 'https://x.supabase.co/storage/a.png', 'https dropped')
    ok(safeAttachmentHref('http://x/a.png') === 'http://x/a.png', 'http dropped')
  })
  t('attachmentLabel: malformed % does not throw and falls back to the raw segment', () => {
    let out = ''
    try { out = attachmentLabel('https://x/files/100%25%E0%A4%A.png') } catch (e: any) { throw new Error('threw: ' + e.message) }
    ok(out === '100%25%E0%A4%A.png', `label ${out}`)
    ok(attachmentLabel('https://x/my%20file.png') === 'my file.png', 'valid encoding not decoded')
  })
  t('NoteSheet: only safe hrefs are rendered as links', () => {
    ok(!/<a href=\{u\}/.test(sheet), 'raw attachment string used as href')
    ok(/href \? \(\s*<a href=\{href\}/.test(sheet), 'link not gated on safeAttachmentHref')
  })
  t('NoteSheet: focus restored to the opener on close', () => {
    ok(/const prev = document\.activeElement/.test(sheet) && /return \(\) => \{[^}]*prev\.focus\(\)/.test(sheet), 'no save/restore of activeElement')
  })
}

behaviour().then(() => {
  let fail = 0
  for (const [n, p, m] of results) { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${m ? '\n      ' + m : ''}`); if (!p) fail++ }
  console.log(`\n${results.length - fail}/${results.length} passed`)
  process.exit(fail ? 1 : 0)
}, e => { console.error(e); process.exit(1) })
