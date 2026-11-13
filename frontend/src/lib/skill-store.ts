'use client'

import { useState, useCallback } from 'react'
import { agentRequest } from './agent-read'

/** A skill as the machine lists it (agent/src/index.ts loadSkillsList). */
export interface SkillInfo {
  name: string
  description: string
  folder: string
  core?: boolean
  forkedFrom?: string
  installedFrom?: { source: string; repo: string; sha: string }
}

export type SkillOp = 'add' | 'fork' | 'remove'
type Reply = { error?: string; skills?: SkillInfo[]; name?: string; content?: string }

/** How the store reaches a machine. Both ends call the same agent-store.ts functions
 *  (agent/src/index.ts changeSkill / readUserSkill). */
export interface SkillTransport {
  view: (folder: string) => Promise<Reply>
  /** arg: the content for add, the new name for fork. */
  change: (op: SkillOp, name: string, arg?: string) => Promise<Reply>
}

const q = encodeURIComponent
const unreachable: Reply = { error: 'Could not reach your machine' }

/** Settings (no LiveKit room): the agent's /skills routes, through the /api/agent proxy in the cloud. */
export function httpSkills(agentUrl: string | null | undefined): SkillTransport & { list: () => Promise<SkillInfo[] | null> } {
  const request = agentRequest(agentUrl)
  return {
    list: () => request('skills').then(({ ok, d }) => (ok && Array.isArray(d?.skills) ? d.skills : null)).catch(() => null),
    view: (folder) => request(`skills/content?name=${q(folder)}`).then(({ d }) => d).catch(() => unreachable),
    change: (op, name, arg) => request(`skills/${op}?name=${q(name)}${op === 'fork' ? `&to=${q(arg ?? '')}` : ''}`, { method: 'POST', body: op === 'add' ? { content: arg } : {} })
      .then(({ ok, d }) => (ok ? d : { ...d, error: d?.error || 'Request failed' })).catch(() => unreachable),
  }
}

/** The machine's skills and the actions on them. The chat passes its data-channel
 *  transport (the agent it is connected to); Settings passes httpSkills. */
export function useSkillStore(transport: SkillTransport) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [viewed, setViewed] = useState<{ name: string; content: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** Resolves true when the machine applied the change. */
  const change = useCallback((op: SkillOp, name: string, arg?: string): Promise<boolean> => {
    setError(null)
    return transport.change(op, name, arg).then((d) => {
      if (Array.isArray(d.skills)) setSkills(d.skills)
      if (d.error) setError(d.error)
      return !d.error
    })
  }, [transport])

  return {
    skills, setSkills, viewed, error,
    closeView: useCallback(() => setViewed(null), []),
    view: useCallback((folder: string) => {
      setError(null)
      transport.view(folder).then((d) => (d.content != null ? setViewed({ name: d.name || folder, content: d.content }) : setError(d.error || 'Skill not found')))
    }, [transport]),
    add: useCallback((name: string, content: string) => change('add', name, content), [change]),
    fork: useCallback((folder: string, to: string) => change('fork', folder, to), [change]),
    remove: useCallback((folder: string) => change('remove', folder), [change]),
  }
}

export type SkillStoreApi = ReturnType<typeof useSkillStore>
