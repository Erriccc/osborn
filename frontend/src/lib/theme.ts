// Light / dark theme. The choice ("system" | "light" | "dark") lives in
// localStorage; the resolved theme is written to <html data-theme="…"> by an
// inline script in the root layout before first paint, so there is no flash.
// globals.css holds the light values of every colour token, and tailwind.config
// routes the gray scales and Tailwind colour shades through those tokens, so
// the same class names flip with the attribute.
export type ThemePref = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'osborn-theme'
/** Pages that are always dark (the meeting canvas is a camera feed). */
const ALWAYS_DARK_PATHS = ['/meeting-canvas', '/v2'] // camera feed; landing preview built on dark photo scrims
/** Browser chrome colour per theme (matches --background in globals.css,
 *  which CSS cannot import; the light page shade in tailwind.config uses it). */
export const THEME_COLOR: Record<ResolvedTheme, string> = { dark: '#0c0b09', light: '#faf9f6' }

export function parseThemePref(v: unknown): ThemePref {
  return v === 'light' || v === 'dark' ? v : 'system'
}

/**
 * Runs in <head> before paint, and again on every change; the one place the
 * choice is resolved. Kept as plain ES5 source text (no imports) because it is
 * inlined as a string. It re-reads the
 * stored choice, so the system-change listener it installs always applies the
 * latest choice.
 */
export const THEME_INIT_SCRIPT = `(function(){
var K=${JSON.stringify(THEME_STORAGE_KEY)},D=${JSON.stringify(ALWAYS_DARK_PATHS)},C=${JSON.stringify(THEME_COLOR)};
function apply(){
  var p='system';try{p=localStorage.getItem(K)||'system'}catch(e){}
  if(p!=='light'&&p!=='dark')p='system';
  var mq=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)');
  var t=p==='system'?(mq&&mq.matches?'light':'dark'):p;
  var path=location.pathname;
  for(var i=0;i<D.length;i++){if(path===D[i]||path.indexOf(D[i]+'/')===0)t='dark'}
  var r=document.documentElement;r.setAttribute('data-theme',t);
  var m=document.querySelectorAll('meta[name="theme-color"]');for(var j=0;j<m.length;j++)m[j].setAttribute('content',C[t]);
}
window.__osbornApplyTheme=apply;apply();
document.addEventListener('DOMContentLoaded',apply);
try{window.matchMedia('(prefers-color-scheme: light)').addEventListener('change',apply)}catch(e){}
window.addEventListener('storage',function(e){if(e.key===K)apply()});
})();`

declare global {
  interface Window { __osbornApplyTheme?: () => void }
}

export function readThemePref(): ThemePref {
  try { return parseThemePref(localStorage.getItem(THEME_STORAGE_KEY)) } catch { return 'system' }
}

export function readResolvedTheme(): ResolvedTheme {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
    else localStorage.setItem(THEME_STORAGE_KEY, pref)
  } catch { /* storage blocked: nothing is saved and the theme stays as it is */ }
  window.__osbornApplyTheme?.()
}
