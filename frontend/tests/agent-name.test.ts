// Run: cd frontend && npx --yes tsx tests/agent-name.test.ts
// agentName (the editor's live preview, also what Supabase saves without an agent)
// must give the name the machine stores (agent/src/store-name.ts storeName).
import assert from 'node:assert'
import { agentName } from '../src/lib/agent-name'
import { storeName } from '../../agent/src/store-name'

const inputs = ['writer', 'My Writer', '  padded  ', 'UPPER_case', 'dots.and/slashes', 'ünïcödé', 'a--b', '', 'x'.repeat(50), 'emoji 🤖 bot', 'tab\tname']
for (const raw of inputs) assert.equal(agentName(raw), storeName(raw), JSON.stringify(raw))
console.log(`agent-name: ${inputs.length} inputs match storeName`)
