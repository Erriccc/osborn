/**
 * Resolve the public origin (scheme + host) a caller used to reach a route handler.
 *
 * Why this exists: on Railway / any reverse-proxy host, `new URL(request.url).origin`
 * returns the INTERNAL container URL (e.g. `http://localhost:8080`) instead of the
 * public one (`https://www.voice-native.com`). We trust the `x-forwarded-host` header
 * (set by Railway's edge proxy) and fall back to the standard `host` header, then to
 * the request URL as a last resort for local dev.
 */
export function getPublicOrigin(request: Request, h: Headers = request.headers): string {
  const forwardedHost = h.get('x-forwarded-host') || h.get('host')
  const forwardedProto = h.get('x-forwarded-proto') || (forwardedHost?.startsWith('localhost') ? 'http' : 'https')
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`
  return new URL(request.url).origin
}
