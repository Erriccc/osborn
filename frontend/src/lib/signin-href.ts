/** Sign-in link that returns to a same-site path (the /login `next` rule). */
export function signInHref(path: string | null | undefined): string {
  const p = path ?? ''
  const ok = p.startsWith('/') && !p.startsWith('//') && !p.includes('\\') && !/[\u0000-\u001f]/.test(p)
  return '/login?next=' + encodeURIComponent(ok ? p : '/dashboard')
}
