/**
 * mic-permission.ts — pure rules for the microphone problem banner (bug 7cf00ae6).
 *
 * The old full-screen "Microphone blocked" overlay came back about every 60s:
 * each agent `listening` state (including the agent's direct-mode
 * auto-recovery) and each LiveKit signal reconnect called
 * setMicrophoneEnabled(true), the browser refused again, and the overlay was
 * re-raised over the Send/Close buttons. Now:
 *   - the warning is a small banner above the composer, shown once per browser
 *     session per problem (sessionStorage);
 *   - after a denial nothing re-requests the mic automatically; only the user's
 *     own "Try again" does;
 *   - the instructions match the browser and platform.
 * No DOM access here: callers pass the storage and the user agent.
 */

export type MicErrorKind = 'denied' | 'notfound' | 'busy'

/** Minimal Storage shape (sessionStorage in the app, a Map in tests). */
export interface KV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const MIC_BANNER_KEY_PREFIX = 'vn-mic-banner-shown:'
export const MIC_DENIED_KEY = 'vn-mic-denied'
/** Window event the app fires when the denial flag changes (provider listens). */
export const MIC_DENIED_EVENT = 'vn-mic-denied-changed'

export function micErrorKind(name: string | null | undefined): MicErrorKind | null {
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'notfound'
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'busy'
  return null
}

function read(store: KV, key: string): string | null {
  try { return store.getItem(key) } catch { return null }
}
function write(store: KV, key: string, value: string | null): void {
  try {
    if (value === null) store.removeItem(key)
    else store.setItem(key, value)
  } catch { /* private mode / quota: the in-page guard still holds */ }
}

/** Show the banner for this problem? Once per browser session, unless the user
 *  just pressed "Try again" (then they should see the result). */
export function shouldShowMicBanner(store: KV, kind: MicErrorKind | null, opts: { userRetry?: boolean } = {}): boolean {
  if (!kind) return false
  if (opts.userRetry) return true
  return read(store, MIC_BANNER_KEY_PREFIX + kind) === null
}

export function noteMicBannerShown(store: KV, kind: MicErrorKind): void {
  write(store, MIC_BANNER_KEY_PREFIX + kind, '1')
}

export function isMicDenied(store: KV): boolean {
  return read(store, MIC_DENIED_KEY) === '1'
}

export function setMicDenied(store: KV, denied: boolean): void {
  write(store, MIC_DENIED_KEY, denied ? '1' : null)
}

/** May the app turn the mic on by itself (agent listening, session gate,
 *  reconnect)? Never after a denial, never while the user muted. */
export function shouldAutoEnableMic(s: { denied: boolean; muted: boolean }): boolean {
  return !s.denied && !s.muted
}

/** PermissionStatus.state for 'microphone' (null: no Permissions API, or the
 *  browser does not know the 'microphone' name, e.g. older Firefox). */
export type MicPermissionState = 'granted' | 'prompt' | 'denied'

export interface MicBrowserCheck {
  permission: MicPermissionState | null
  /** PerformanceNavigationTiming.type of this document ('reload', 'navigate'…).
   *  Only consulted when there is no Permissions API answer. */
  navigationType?: string | null
}

/** Review MAJOR 1: the denial flag lives in sessionStorage, which survives a
 *  reload, so a user who later allowed the mic in site settings stayed muted.
 *  The browser's own answer wins: granted or prompt clears the flag, denied
 *  keeps it. Without the Permissions API, a page reload clears it (the help
 *  text tells the user to "reload this page" after allowing). */
export function micDeniedAfterCheck(denied: boolean, check: MicBrowserCheck): boolean {
  if (check.permission === 'granted' || check.permission === 'prompt') return false
  if (check.permission === 'denied') return denied
  if (check.navigationType === 'reload') return false
  return denied
}

/** Apply micDeniedAfterCheck to the stored flag; returns the new value. */
export function reconcileMicDenied(store: KV, check: MicBrowserCheck): boolean {
  const before = isMicDenied(store)
  const after = micDeniedAfterCheck(before, check)
  if (after !== before) setMicDenied(store, after)
  return after
}

/** The mute button must not claim "unmuted" while no audio is published
 *  (denied, joined without the mic, or not yet enabled). `micPublished`
 *  undefined = unknown (no local participant yet): trust the user's toggle. */
export function micShownMuted(s: { muted: boolean; micPublished: boolean | undefined }): boolean {
  return s.muted || s.micPublished === false
}

export type MicPlatform = 'ios' | 'android' | 'chrome' | 'edge' | 'safari' | 'firefox' | 'other'

export function micPlatform(env: { ua: string; maxTouchPoints?: number }): MicPlatform {
  const ua = env.ua || ''
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  // iPadOS 13+ reports a Mac UA; touch points give it away.
  if (/Macintosh/.test(ua) && (env.maxTouchPoints ?? 0) > 1) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Edg\//.test(ua)) return 'edge'
  if (/Chrome\/|Chromium\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}

function iosAppName(ua: string): string {
  if (/CriOS\//.test(ua)) return 'Chrome'
  if (/FxiOS\//.test(ua)) return 'Firefox'
  if (/EdgiOS\//.test(ua)) return 'Edge'
  return 'Safari'
}

const KEEP_TYPING = 'You can keep typing in the meantime.'

export function micHelp(kind: MicErrorKind, env: { ua: string; maxTouchPoints?: number }): { title: string; body: string } {
  if (kind === 'notfound') {
    return { title: 'No microphone found', body: `Connect a microphone, then tap Try again. ${KEEP_TYPING}` }
  }
  if (kind === 'busy') {
    return { title: 'Microphone busy', body: `Another app is using the microphone. Close it, then tap Try again. ${KEEP_TYPING}` }
  }
  const platform = micPlatform(env)
  let how: string
  switch (platform) {
    case 'ios': {
      const app = iosAppName(env.ua)
      how = app === 'Safari'
        ? 'Open Settings > Apps > Safari > Microphone and choose Allow (or tap aA in the address bar > Website Settings > Microphone), then reload this page.'
        : `Open Settings > Apps > ${app} > turn on Microphone, then reload this page.`
      break
    }
    case 'android':
      how = 'Tap the lock icon next to the address, open Permissions > Microphone and choose Allow, then reload.'
      break
    case 'chrome':
    case 'edge':
      how = 'Click the icon at the left of the address bar, set Microphone to Allow, then reload this page.'
      break
    case 'safari':
      how = 'In the menu bar choose Safari > Settings for This Website, set Microphone to Allow, then reload this page.'
      break
    case 'firefox':
      how = 'Click the microphone or lock icon in the address bar, clear the Blocked microphone permission, then reload this page.'
      break
    default:
      how = "Allow microphone access for this site in your browser's site settings, then reload this page."
  }
  return { title: 'Microphone blocked', body: `${how} ${KEEP_TYPING}` }
}
