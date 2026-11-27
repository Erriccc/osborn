'use client'

import { StoreBrowse } from '@/components/StoreBrowse'
import type { AgentRequest } from '@/lib/agent-read'

const sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
const entry = (e: { id: string; source: string; kind: 'agent' | 'skill'; name: string; description: string; trust: 'anthropic' | 'community'; plugin?: string; model?: string; tools?: string[]; scripts?: string[]; files?: string[] }) => ({
  tools: [], scripts: [], files: ['SKILL.md'], repo: 'example/repo', path: `${e.name}/SKILL.md`, sha, rev: sha, license: 'MIT', ...e,
})

// Sample /store/catalog response with an Anthropic and a community source.
const catalog = {
  sources: [
    { id: 'anthropic-skills', label: 'Anthropic skills', repo: 'anthropics/skills', trust: 'anthropic', sha, fetchedAt: 0, count: 2 },
    { id: 'wshobson-agents', label: 'wshobson/agents', repo: 'wshobson/agents', trust: 'community', sha, fetchedAt: 0, count: 1 },
    { id: 'iart-b-roll', label: 'iart-ai/b-roll-skills', repo: 'iart-ai/b-roll-skills', trust: 'community', sha, fetchedAt: 0, count: 1 },
  ],
  entries: [
    entry({ id: 'anthropic-skills:skills/pdf/SKILL.md', source: 'anthropic-skills', kind: 'skill', name: 'pdf', description: 'Read, fill and merge PDF files.', trust: 'anthropic', files: ['SKILL.md', 'scripts/fill.py'], scripts: ['scripts/fill.py'] }),
    entry({ id: 'anthropic-skills:skills/docx/SKILL.md', source: 'anthropic-skills', kind: 'skill', name: 'docx', description: 'Create and edit Word documents.', trust: 'anthropic' }),
    entry({ id: 'wshobson-agents:plugins/review/agents/code-reviewer.md', source: 'wshobson-agents', kind: 'agent', name: 'code-reviewer', description: 'Reviews diffs for bugs and style.', trust: 'community', plugin: 'review', model: 'sonnet', tools: ['Read', 'Grep', 'Glob'], files: ['code-reviewer.md'] }),
    entry({ id: 'iart-b-roll:skills/b-roll/SKILL.md', source: 'iart-b-roll', kind: 'skill', name: 'b-roll', description: 'Find and cut b-roll clips for a video script.', trust: 'community', files: ['SKILL.md', 'scripts/cut.sh'], scripts: ['scripts/cut.sh'] }),
  ],
  installed: ['anthropic-skills:skills/docx/SKILL.md'],
  recommended: [{ id: 'iart-b-roll:skills/b-roll/SKILL.md', score: 1, reason: 'matches your video work' }],
}

const request: AgentRequest = async (path) => {
  if (path.startsWith('store/catalog')) return { ok: true, status: 200, d: catalog }
  if (path.startsWith('store/entry')) return { ok: true, status: 200, d: { content: '# Sample\n\nFixture content.' } }
  return { ok: false, status: 503, d: { error: 'Fixture: no machine' } }
}

export function StoreFixture() {
  return (
    <main className="mx-auto max-w-3xl p-4">
      <StoreBrowse request={request} yours={[]} takenAgentNames={new Set()} onInstallAgent={async () => null} />
    </main>
  )
}
