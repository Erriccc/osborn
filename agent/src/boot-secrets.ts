/**
 * boot-secrets.ts — side-effect module that hydrates user secrets from the Fly
 * volume into process.env at the EARLIEST possible point.
 *
 * Why a separate module instead of a call in index.ts: ES module imports are
 * hoisted and their bodies run in source order BEFORE any statement in the
 * importing module. Some consumers read their keys at module-load time
 * (recall-client.ts reads RECALL_REGION into a top-level const; claude-auth is
 * called later but still expects env present). Importing THIS module
 * immediately after `dotenv/config` — and before every other agent import —
 * guarantees hydrateSecretsIntoEnv() runs before those bodies evaluate, so the
 * volume-persisted user keys win over machine-env defaults.
 *
 * Keep this import positioned second in index.ts (right after dotenv/config).
 */

import { hydrateSecretsIntoEnv } from './secrets-store.js'

hydrateSecretsIntoEnv()
