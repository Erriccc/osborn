// Public client config — the Supabase anon key is RLS-protected and designed to
// ship in client apps (same keys the Next.js web app exposes via NEXT_PUBLIC_*).
export const SUPABASE_URL = 'https://frzbawsadhmmltokvexj.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyemJhd3NhZGhtbWx0b2t2ZXhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE2Nzg3MzgxMjcsImV4cCI6MTk5NDMxNDEyN30.KAHO-apaXL3G7mBTZ17r8GN0vXoOZIL7d_HzKr7hJjc'

// Public LiveKit URL (browser client uses the same via NEXT_PUBLIC_LIVEKIT_URL).
export const LIVEKIT_URL = 'wss://osborn-live-agent-kkjwjvfr.livekit.cloud'

// Frontend origin — where the token endpoint lives (/api/token mints LiveKit
// JWTs and requires no auth, so native can call it directly).
export const FRONTEND_URL = 'https://www.voice-native.com'

// Connect defaults matching the web app (login/page.tsx): pipeline voice arch,
// Claude coding agent, OpenAI provider.
export const CONNECT_DEFAULTS = { provider: 'openai', voiceArch: 'pipeline', codingAgent: 'claude' }
