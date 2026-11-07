// Run: cd frontend && npx --yes tsx tests/mic-banner.test.ts
// Spec (bug 7cf00ae6): the mic warning is a small dismissible banner above the
// composer, shown ONCE per browser session (sessionStorage), never a blocking
// overlay. After a denial nothing re-requests the mic automatically (agent
// 'listening', session gate, LiveKit signal reconnect); only the user's own
// "Try again" does. Instructions are platform-specific (desktop Chrome / Edge /
// Safari / Firefox, iOS, Android) and never say "iPhone" on a desktop.
import {
  micErrorKind, shouldShowMicBanner, noteMicBannerShown, isMicDenied, setMicDenied,
  shouldAutoEnableMic, micPlatform, micHelp, MIC_BANNER_KEY_PREFIX, MIC_DENIED_KEY,
  micDeniedAfterCheck, reconcileMicDenied, micShownMuted,
  type KV,
} from '../src/lib/mic-permission'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, String(e?.message || e).slice(0, 400)) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

function mem(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, String(v)) }, removeItem: (k) => { data.delete(k) } }
}
const throwing: KV = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
}

t('DOMException names map to kinds', () => {
  eq(micErrorKind('NotAllowedError'), 'denied', 'denied')
  eq(micErrorKind('SecurityError'), 'denied', 'security = denied')
  eq(micErrorKind('NotFoundError'), 'notfound', 'notfound')
  eq(micErrorKind('NotReadableError'), 'busy', 'busy')
  eq(micErrorKind('AbortError'), null, 'other')
  eq(micErrorKind(undefined), null, 'none')
})

t('banner shows once per browser session', () => {
  const s = mem()
  ok(shouldShowMicBanner(s, 'denied'), 'first time')
  noteMicBannerShown(s, 'denied')
  ok(!shouldShowMicBanner(s, 'denied'), 'second time (reconnect / reload / retry loop)')
  ok(s.data.has(`${MIC_BANNER_KEY_PREFIX}denied`), 'stored in the given (session) storage')
})

t('a different problem still gets its own one banner', () => {
  const s = mem()
  noteMicBannerShown(s, 'denied')
  ok(shouldShowMicBanner(s, 'busy'), 'busy after denied')
})

t('user-initiated retry may show it again', () => {
  const s = mem()
  noteMicBannerShown(s, 'denied')
  ok(shouldShowMicBanner(s, 'denied', { userRetry: true }), 'explicit Try again')
})

t('no kind -> no banner', () => ok(!shouldShowMicBanner(mem(), null), 'null'))

t('storage failure (private mode) never throws and shows at most... once per page', () => {
  ok(shouldShowMicBanner(throwing, 'denied'), 'shows')
  noteMicBannerShown(throwing, 'denied') // must not throw
  ok(!isMicDenied(throwing), 'denied read is safe')
  setMicDenied(throwing, true) // must not throw
})

t('denial flag round-trips and clears', () => {
  const s = mem()
  ok(!isMicDenied(s), 'initially false')
  setMicDenied(s, true)
  ok(isMicDenied(s), 'set')
  ok(s.data.has(MIC_DENIED_KEY), 'key')
  setMicDenied(s, false)
  ok(!isMicDenied(s), 'cleared')
})

t('no automatic mic re-request after a denial or while muted', () => {
  ok(shouldAutoEnableMic({ denied: false, muted: false }), 'normal')
  ok(!shouldAutoEnableMic({ denied: true, muted: false }), 'denied')
  ok(!shouldAutoEnableMic({ denied: false, muted: true }), 'muted')
})

t('platform detection', () => {
  eq(micPlatform({ ua: UA.chromeMac }), 'chrome', 'chrome mac')
  eq(micPlatform({ ua: UA.chromeWin }), 'chrome', 'chrome win')
  eq(micPlatform({ ua: UA.edge }), 'edge', 'edge')
  eq(micPlatform({ ua: UA.safariMac }), 'safari', 'safari mac')
  eq(micPlatform({ ua: UA.firefox }), 'firefox', 'firefox')
  eq(micPlatform({ ua: UA.iphone }), 'ios', 'iphone')
  eq(micPlatform({ ua: UA.iphoneChrome }), 'ios', 'iphone chrome')
  eq(micPlatform({ ua: UA.safariMac, maxTouchPoints: 5 }), 'ios', 'iPadOS desktop-class UA')
  eq(micPlatform({ ua: UA.android }), 'android', 'android')
  eq(micPlatform({ ua: '' }), 'other', 'unknown')
})

t('desktop instructions never mention iPhone Settings', () => {
  for (const ua of [UA.chromeMac, UA.chromeWin, UA.edge, UA.safariMac, UA.firefox]) {
    const h = micHelp('denied', { ua })
    ok(!/iPhone|iOS Settings/i.test(h.body), `desktop body mentions iPhone: ${h.body}`)
    ok(h.title === 'Microphone blocked', 'title')
  }
})

t('per-browser instructions name the right control', () => {
  ok(/address bar/i.test(micHelp('denied', { ua: UA.chromeMac }).body), 'chrome: address bar')
  ok(/Settings for/i.test(micHelp('denied', { ua: UA.safariMac }).body), 'safari: Settings for this website')
  ok(/permission/i.test(micHelp('denied', { ua: UA.firefox }).body), 'firefox: permissions')
  ok(/Settings/.test(micHelp('denied', { ua: UA.iphone }).body) && /Safari/.test(micHelp('denied', { ua: UA.iphone }).body), 'ios safari')
  ok(/Chrome/.test(micHelp('denied', { ua: UA.iphoneChrome }).body), 'ios chrome names Chrome')
  ok(/lock|Permissions/i.test(micHelp('denied', { ua: UA.android }).body), 'android')
})

t('not-found and busy have their own copy', () => {
  eq(micHelp('notfound', { ua: UA.chromeMac }).title, 'No microphone found', 'notfound')
  eq(micHelp('busy', { ua: UA.chromeMac }).title, 'Microphone busy', 'busy')
})

t('every message says you can keep typing', () => {
  for (const k of ['denied', 'notfound', 'busy'] as const) ok(/typ/i.test(micHelp(k, { ua: UA.chromeMac }).body), k)
})

// Review MAJOR 1: the stored denial must not outlive the browser's answer.
t('deny, then grant, then reload: flag cleared and auto-enable allowed', () => {
  const s = mem()
  setMicDenied(s, true) // LiveKit MediaDevicesError NotAllowedError
  eq(reconcileMicDenied(s, { permission: 'denied', navigationType: 'navigate' }), true, 'denied keeps it')
  ok(!shouldAutoEnableMic({ denied: isMicDenied(s), muted: false }), 'no auto-enable while denied')
  // User allows the mic in site settings: PermissionStatus 'change' -> granted.
  eq(reconcileMicDenied(s, { permission: 'granted' }), false, 'granted clears it')
  eq(s.data.has(MIC_DENIED_KEY), false, 'storage key removed')
  // Reload in the same tab (sessionStorage survives): mount check, still granted.
  eq(reconcileMicDenied(s, { permission: 'granted', navigationType: 'reload' }), false, 'stays clear after reload')
  ok(shouldAutoEnableMic({ denied: isMicDenied(s), muted: false }), 'auto-enable allowed')
})
t('Permissions API answers: granted/prompt clear, denied keeps', () => {
  eq(micDeniedAfterCheck(true, { permission: 'granted' }), false, 'granted')
  eq(micDeniedAfterCheck(true, { permission: 'prompt' }), false, 'prompt (reset to ask)')
  eq(micDeniedAfterCheck(true, { permission: 'denied', navigationType: 'reload' }), true, 'denied wins over reload')
  eq(micDeniedAfterCheck(false, { permission: 'denied' }), false, 'denied does not invent a flag')
})
t('no Permissions API: only a page reload clears the flag', () => {
  eq(micDeniedAfterCheck(true, { permission: null, navigationType: 'reload' }), false, 'reload')
  eq(micDeniedAfterCheck(true, { permission: null, navigationType: 'navigate' }), true, 'navigate keeps')
  eq(micDeniedAfterCheck(true, { permission: null, navigationType: 'back_forward' }), true, 'bfcache keeps')
  eq(micDeniedAfterCheck(true, { permission: null }), true, 'unknown keeps')
  const s = mem(); setMicDenied(s, true)
  eq(reconcileMicDenied(s, { permission: null, navigationType: 'reload' }), false, 'store cleared')
  eq(isMicDenied(s), false, 'read back')
})
t('reconcile survives blocked storage', () => {
  eq(reconcileMicDenied(throwing, { permission: 'granted' }), false, 'no throw')
})
t('mute UI is honest: unpublished audio never shows unmuted', () => {
  eq(micShownMuted({ muted: false, micPublished: false }), true, 'joined without the mic')
  eq(micShownMuted({ muted: false, micPublished: true }), false, 'live mic')
  eq(micShownMuted({ muted: true, micPublished: true }), true, 'user muted')
  eq(micShownMuted({ muted: false, micPublished: undefined }), false, 'unknown: trust the toggle')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
