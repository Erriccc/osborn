// The name a user agent is saved under: the editor's live preview, and what Supabase stores
// when no agent is connected. Must equal agent/src/store-name.ts (tests/agent-name.test.ts).
// Dependency-free so the test can import it without a Supabase client.
export const agentName = (raw: string) => raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
