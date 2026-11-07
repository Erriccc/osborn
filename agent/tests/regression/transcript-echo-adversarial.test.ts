import { userEchoText } from '../../src/transcript-wiring.js'
import { checkControlSender, CONTROL_MESSAGE_TYPES, READ_ONLY_MESSAGE_TYPES } from '../../src/data-sender-auth.js'
let f=0,n=0; const ok=(name:string,c:boolean)=>{n++;console.log((c?'PASS ':'FAIL ')+name);if(!c)f++}
const BAD=['[time:','[INTERRUPTED]','[CONTEXT]','<system-reminder>']
const leaks=(s:string|null)=>s!==null&&BAD.some(b=>s.includes(b))
const inputs=[
 '[time: 2026-11-07 10:00] hello there',
 '[time: Fri 10:00]\n[time: again] what is up',
 '[INTERRUPTED] user cut off. [CONTEXT] prior stuff\nreal question here',
 '[CONTEXT] only context',
 '[INTERRUPTED]',
 '<system-reminder>secret</system-reminder> real words',
 'real words <system-reminder>unclosed secret',
 '[time: x] <system-reminder>a</system-reminder>',
 '[time: x] [INTERRUPTED] [CONTEXT] <system-reminder>y</system-reminder> ok go',
 '[TIME: x] hi there', '[ time: x] hi there',
 '[time: [nested]] hi there',
 '[favorited] The user favorited the file X.',
]
for (const i of inputs){ const o=userEchoText(i); ok('no leak: '+JSON.stringify(i).slice(0,50)+' -> '+JSON.stringify(o), !leaks(o)) }
ok('real text preserved', (userEchoText('[time: z] hello there')||'').includes('hello there'))
ok('favorite notice dropped', userEchoText('[time: z] [favorited] The user favorited the file X.')===null)
ok('attachments path no leak', !leaks(userEchoText('[time: z] hi there','file block')))
ok('favorite_changed in CONTROL', CONTROL_MESSAGE_TYPES.has('favorite_changed'))
ok('favorite_changed not read-only', !READ_ONLY_MESSAGE_TYPES.has('favorite_changed'))
ok('controller allowed', checkControlSender('favorite_changed','user-a','user-a').ok)
ok('non-controller user denied', !checkControlSender('favorite_changed','user-b','user-a').ok)
ok('no controller denied', !checkControlSender('favorite_changed','user-a',null).ok)
ok('no sender denied', !checkControlSender('favorite_changed',undefined,'user-a').ok)
ok('agent self denied', !checkControlSender('favorite_changed','osborn-agent','user-a').ok)
ok('non-user identity denied', !checkControlSender('favorite_changed','guest-1','guest-1').ok)
console.log(`${n-f}/${n}`); process.exit(f?1:0)
