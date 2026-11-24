// English stopwords and speech terms, shared by the content lens (transcripts), the long-turn
// points (#455) and the store catalog's recommendations. No imports, so any can use it without pulling the others in.
export const STOPWORDS: ReadonlySet<string> = new Set(
  ('the and for that this with you your are was were have has had not but just like what when then them they there ' +
    'their about from into would could should will can its so also well even still want need ' +
    'here more some only very much make made does did doing done been being which where while because since each ' +
    'other than over our out all any one two who how why way get got see say said now back').split(/\s+/),
)

/** STOPWORDS plus what speech transcripts are full of (fillers, contractions, vague nouns). */
export const SPEECH_STOPWORDS: ReadonlySet<string> = new Set([
  ...STOPWORDS,
  ...("it's i'm don't that's okay yeah yes um uh know mean really actually basically right going gonna wanna let's lets " +
    'thing things sure think time kind sort something maybe stuff look looks good same work working').split(/\s+/),
])

/** Lower-cased content terms (3+ chars, no speech stopwords). Keeps tokens like x-forwarded-host, 1006, 0.9.153. */
export function terms(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9._'-]*[a-z0-9]/g)) {
    const t = m[0]
    if (t.length >= 3 && !SPEECH_STOPWORDS.has(t) && !/^\d{1,2}$/.test(t)) out.add(t)
  }
  return out
}
