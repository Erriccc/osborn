// The name a user agent or skill is stored under. Dependency-free so the frontend's
// copy (frontend/src/lib/agent-name.ts agentName) can be tested against it.
// A name with no letter or digit ('---') is no name: ''.
export const storeName = (raw: unknown): string => {
  const n = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
  return /[a-z0-9]/.test(n) ? n : ''
}
