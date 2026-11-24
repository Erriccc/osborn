/** A `next` value as a path on `origin`, else `fallback`. Refused: a path starting with `//` (from
 *  `/.//evil.com`; it would leave the site) and /login (a nested ?next would chain redirects). */
export function sameSitePath(next: string | null | undefined, origin: string, fallback = '/dashboard'): string {
  if (!next) return fallback
  try {
    const u = new URL(next, origin)
    const path = u.pathname + u.search + u.hash
    return u.origin === new URL(origin).origin && !path.startsWith('//') && !/^\/login\/*$/.test(u.pathname) ? path : fallback
  } catch { return fallback }
}

/** Sign-in link that returns to `path` afterwards; /login applies `sameSitePath`. */
export function signInHref(path: string): string {
  return '/login?next=' + encodeURIComponent(path)
}

/** Sign-in link that returns to the current page. Client-only (reads `window`): call it in an event
 *  handler or effect, never during render. */
export function signInHere(): string {
  return signInHref(window.location.pathname + window.location.search)
}
