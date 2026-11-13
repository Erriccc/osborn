'use client'

import { useState, useCallback, useMemo } from 'react'
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

const q = encodeURIComponent

/** The machine's skills and the actions on them, over the agent's /skills routes.
 *  Used by the chat popovers and Settings alike. */
export function useSkillStore(agentUrl: string | null | undefined) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [viewed, setViewed] = useState<{ name: string; content: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useMemo(() => agentRequest(agentUrl), [agentUrl])

  /** Resolves true when the machine applied the change. */
  const change = useCallback((path: string, body?: unknown): Promise<boolean> => {
    setError(null)
    return request(path, { method: 'POST', body })
      .then(({ ok, d }) => {
        if (Array.isArray(d?.skills)) setSkills(d.skills)
        if (!ok) setError(d?.error || 'Request failed')
        return ok
      })
      .catch(() => { setError('Could not reach your machine'); return false })
  }, [request])

  return {
    skills, setSkills, viewed, error,
    closeView: () => setViewed(null),
    load: useCallback(() => request('skills').then(({ ok, d }) => { if (ok && Array.isArray(d?.skills)) setSkills(d.skills) }).catch(() => {}), [request]),
    view: useCallback((folder: string) => {
      setError(null)
      request(`skills/content?name=${q(folder)}`)
        .then(({ ok, d }) => (ok ? setViewed({ name: d.name, content: d.content }) : setError(d?.error || 'Skill not found')))
        .catch(() => setError('Could not reach your machine'))
    }, [request]),
    add: useCallback((name: string, content: string) => change(`skills/add?name=${q(name)}`, { content }), [change]),
    fork: useCallback((folder: string, to: string) => change(`skills/fork?name=${q(folder)}&to=${q(to)}`), [change]),
    remove: useCallback((folder: string) => change(`skills/remove?name=${q(folder)}`), [change]),
  }
}

export type SkillStoreApi = ReturnType<typeof useSkillStore>
