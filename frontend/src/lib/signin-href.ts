/** A `next` value as a path on `origin`, else `fallback`. A path that starts with `//` (for example
 *  from `/.//evil.com`) is refused: navigating to it would leave the site. */
export function sameSitePath(next: string | null | undefined, origin: string, fallback = '/dashboard'): string {
  if (!next) return fallback
  try {
    const u = new URL(next, origin)
    const path = u.pathname + u.search + u.hash
    return u.origin === new URL(origin).origin && !path.startsWith('//') ? path : fallback
  } catch { return fallback }
}

/** Sign-in link that returns to `path` afterwards; /login applies `sameSitePath`. */
export function signInHref(path: string): string {
  return '/login?next=' + encodeURIComponent(path)
}
