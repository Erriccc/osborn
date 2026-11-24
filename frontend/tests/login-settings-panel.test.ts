// Run: cd frontend && npx --yes tsx tests/login-settings-panel.test.ts
// Spec (#533): the /login connection-settings panel must not be reachable by
// keyboard or assistive tech while collapsed, and guests (no gear) never get it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', 'src', 'app', 'login', 'page.tsx'), 'utf8')
const i = src.indexOf('id="login-settings-panel"')
let failed = 0
const t = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) failed++ }
t('panel exists', i > 0)
const block = src.slice(i, i + 400)
t('collapsed panel is visibility:hidden', /visibility:\s*showSettings \? 'visible' : 'hidden'/.test(block))
t('collapsed panel is aria-hidden', /aria-hidden=\{!showSettings\}/.test(block))
t('panel only rendered for signed-in users', /\{user && \(\s*\n\s*<div id="login-settings-panel"/.test(src))
t('gear has accessible name and expanded state', /aria-label="Connection settings" aria-expanded=\{showSettings\} aria-controls="login-settings-panel"/.test(src))
// Structural guard: every settings control lives after the signed-in gate, so a guest never gets one.
const gate = src.indexOf('{user && (')
const settingsMarks = ['Agent URL', '<ToggleRow', 'Browse sessions', '<input']
for (const m of settingsMarks) {
  const idx: number[] = []
  for (let k = src.indexOf(m); k >= 0; k = src.indexOf(m, k + 1)) idx.push(k)
  t(`every "${m}" is inside the signed-in settings panel`, gate > 0 && idx.length > 0 && idx.every(k => k > gate))
}
t('gear toggles the panel open and closed', /setShowSettings\(s => !s\)/.test(src))
process.exit(failed ? 1 : 0)
