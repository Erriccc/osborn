/**
 * env-key.ts — reading model keys from the environment. Dependency-free so the
 * content workers can share it with claude-auth.ts (which pulls in node-pty).
 */

/** Trim whitespace and strip one layer of surrounding quotes from an env value. */
export function cleanEnvKey(value: string | undefined | null): string {
  if (!value) return ''
  let v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim()
  }
  return v
}

/** The z.ai GLM Coding Plan key: Z_AI_PERSONAL_API_KEY, then ZAI_API_KEY. Empty when neither is set. */
export function zaiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return cleanEnvKey(env.Z_AI_PERSONAL_API_KEY) || cleanEnvKey(env.ZAI_API_KEY)
}
