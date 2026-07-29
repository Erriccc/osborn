'use client'

import { useState } from 'react'

const AGENT_MESSAGE = `Install the Voice-E2E testing skill — it gives you ears, a mouth, hands and a brain for testing any voice or web app in a real browser (speak into the mic, hear and verify replies, click via natural language, get video+audio replays).

1. Fetch https://www.voice-native.com/api/test-skill and save it to ~/.claude/skills/voice-e2e/SKILL.md
2. Follow its INSTALLATION section exactly (downloads the harness bundle, installs deps, sets up keys).
3. I'll provide a GOOGLE_API_KEY (Gemini) when you ask — it's required for the brain. OPENAI_API_KEY and DEEPGRAM_API_KEY are recommended for the voice mouth and audible verification.
4. Before any test run, always execute the skill's MANDATORY VERSION CHECK so you're on the latest version.

Then run a first smoke test against a site I give you and show me the replay video.`

export default function TestSkillLanding() {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(AGENT_MESSAGE)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <main className="min-h-screen bg-black text-gray-200 flex flex-col items-center px-6 py-16">
      <div className="max-w-2xl w-full space-y-10">
        <header className="space-y-3 text-center">
          <div className="text-4xl">🎙️🧠</div>
          <h1 className="text-3xl font-semibold text-white">Voice-E2E</h1>
          <p className="text-lg text-amber-400">Ears, a mouth, hands and a brain — for testing any voice or web app</p>
        </header>

        <section className="space-y-4 text-sm leading-relaxed text-gray-300">
          <p>
            Voice-E2E is an agent-attachable testing skill. Your coding agent opens a real browser,
            <span className="text-white"> speaks into the page&apos;s microphone</span> (synthesized on the fly),
            <span className="text-white"> hears and transcribes everything the app plays back</span>, clicks around using a
            natural-language brain (no selectors, self-healing action cache), improvises multi-turn conversations toward a
            goal you write in plain YAML — and hands you back <span className="text-white">video + audio replays</span>,
            DevTools diagnostics, and structured metrics for every run.
          </p>
          <p>
            Nothing is injected into the page and no backend access is assumed — it works on any website. Versioned and
            self-updating: the skill checks this server for updates before every major run.
          </p>
          <ul className="list-disc pl-5 space-y-1 text-gray-400">
            <li>Requires: a Gemini API key (<code className="text-amber-300">GOOGLE_API_KEY</code>) for the brain</li>
            <li>Recommended: OpenAI (voice mouth + conversation tester) and Deepgram (verify speech by ear)</li>
            <li>Optional: one-command self-stopping cloud runner on Fly.io (config included)</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-white font-medium">Install: copy this message to your coding agent</h2>
          <div className="relative rounded-xl border border-gray-800 bg-gray-950 p-4">
            <pre className="whitespace-pre-wrap text-xs text-gray-300 leading-relaxed">{AGENT_MESSAGE}</pre>
            <button
              onClick={copy}
              className="absolute top-3 right-3 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-medium px-3 py-1.5 transition"
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Skill source: <a className="text-amber-400 underline" href="/api/test-skill">/api/test-skill</a> · Harness bundle:{' '}
            <a className="text-amber-400 underline" href="/api/test-skill/bundle">/api/test-skill/bundle</a>
          </p>
        </section>
      </div>
    </main>
  )
}
