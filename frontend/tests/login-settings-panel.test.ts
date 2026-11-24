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
process.exit(failed ? 1 : 0)
