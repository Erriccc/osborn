// The name a user agent or skill is stored under. Dependency-free so the frontend's
// copy (frontend/src/lib/user-agents.ts agentName) can be tested against it.
export const storeName = (raw: unknown): string =>
  String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
