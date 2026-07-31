import { redirect } from 'next/navigation'

// Legacy alias — the voice-e2e skill landing page moved to
// /browser-screen-recorder. Human-facing, so a real redirect is fine here
// (the API routes re-export instead, since installed clients curl without -L).
export default function TestSkillLandingRedirect() {
  redirect('/browser-screen-recorder')
}
