'use client'

import { useState, useEffect, useCallback } from 'react'
import { isSupabaseConfigured } from './supabase'
import { createSupabaseBrowser } from './supabase-browser'

// The signed-in user's own agents (Supabase user_agents). Built-in agents are
// never stored here: they are core and locked, and a fork is a new row whose
// forked_from names the built-in it came from.
export interface UserAgentDraft {
  name: string
  description: string
  prompt: string
  model: string
  tools: string[]
  forked_from?: string | null
  /** Null = inherit the parent's role or infer it from the tools (agent-store.ts). */
  role?: string | null
}
export interface UserAgentRow extends UserAgentDraft {
  enabled: boolean
}

export const agentName = (raw: string) => raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')

/** rows is null until loaded, and stays null for guests (no store). */
export function useUserAgents() {
  const [rows, setRows] = useState<UserAgentRow[] | null>(null)

  const withUser = useCallback(<T,>(fn: (sb: ReturnType<typeof createSupabaseBrowser>, userId: string) => T | PromiseLike<T>): Promise<T | undefined> => {
    if (!isSupabaseConfigured()) return Promise.resolve(undefined)
    const sb = createSupabaseBrowser()
    return sb.auth.getUser().then(({ data }) => (data?.user ? fn(sb, data.user.id) : undefined)).catch(() => undefined)
  }, [])

  useEffect(() => {
    withUser((sb) => {
      sb.from('user_agents').select('*').then(({ data, error }) => {
        if (error) { console.error('user_agents load failed:', error.message); return }
        setRows((data || []) as UserAgentRow[])
      })
    })
  }, [withUser])

  /** Resolves to an error message, or null once saved. */
  const save = useCallback(async (a: UserAgentDraft): Promise<string | null> => {
    const name = agentName(a.name)
    const err = await withUser((sb, userId) => {
      const row = {
        name, description: a.description.trim(), prompt: a.prompt.trim(), model: a.model, tools: a.tools,
        ...(a.forked_from ? { forked_from: a.forked_from } : {}),
        // Omitted unless set or cleared, so a database without migration 016 still saves.
        ...(a.role !== undefined ? { role: a.role || null } : {}),
      }
      return sb.from('user_agents')
        .upsert({ user_id: userId, ...row, enabled: true, updated_at: new Date().toISOString() }, { onConflict: 'user_id,name' })
        .then(({ error }) => {
          if (error) { console.error('user_agents upsert failed:', error.message); return error.message }
          setRows((prev) => {
            const old = (prev || []).find((r) => r.name === name)
            return [...(prev || []).filter((r) => r.name !== name), { ...old, ...row, enabled: true }]
          })
          return null
        })
    })
    return err === undefined ? 'Sign in to save agents.' : err
  }, [withUser])

  const remove = useCallback((name: string) => {
    withUser((sb, userId) => {
      sb.from('user_agents').delete().eq('user_id', userId).eq('name', name).then(({ error }) => {
        if (error) { console.error('user_agents delete failed:', error.message); return }
        setRows((prev) => (prev || []).filter((r) => r.name !== name))
      })
    })
  }, [withUser])

  const setEnabled = useCallback((name: string, enabled: boolean) => {
    withUser((sb, userId) => {
      sb.from('user_agents').update({ enabled, updated_at: new Date().toISOString() }).eq('user_id', userId).eq('name', name)
        .then(({ error }) => {
          if (error) { console.error('user_agents update failed:', error.message); return }
          setRows((prev) => (prev || []).map((r) => (r.name === name ? { ...r, enabled } : r)))
        })
    })
  }, [withUser])

  return { rows, save, remove, setEnabled }
}
