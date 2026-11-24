// English stopwords for term matching, shared by the content lens (transcripts) and the
// store catalog's recommendations. No imports, so either can use it without pulling the other in.
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
