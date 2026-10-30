import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { relativeTime } from '../../lib/agent'
import { supabase } from '../../lib/supabase'

/**
 * Library (Phase 4) — the content studio, REAL data. Reads the RLS-scoped
 * content_items table directly (same query the web library uses). Full editor /
 * publish flow is a later pass; this lists drafts & published pieces natively.
 */
type ContentItem = {
  id: string
  type: string
  status: string
  title: string | null
  hook: string | null
  slug: string | null
  created_at: string
  published_at: string | null
}

export default function Library() {
  const [items, setItems] = useState<ContentItem[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('content_items')
      .select('id, type, status, title, hook, slug, created_at, published_at')
      .order('created_at', { ascending: false })
    if (error) { setState('error'); return }
    setItems((data ?? []) as ContentItem[])
    setState('ready')
  }, [])

  useEffect(() => { load() }, [load])
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false) }, [load])

  if (state === 'loading') return <View style={styles.center}><ActivityIndicator color="#3b82f6" /></View>

  return (
    <FlatList
      style={styles.list}
      contentInsetAdjustmentBehavior="automatic"
      data={items}
      keyExtractor={(i) => i.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#8e8e93" />}
      ItemSeparatorComponent={() => <View style={styles.sep} />}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyEmoji}>📚</Text>
          <Text style={styles.emptyTitle}>{state === 'error' ? 'Couldn’t load' : 'Nothing here yet'}</Text>
          <Text style={styles.emptySub}>Content you draft from sessions shows up here.</Text>
        </View>
      }
      renderItem={({ item }) => <Item item={item} />}
      contentContainerStyle={styles.content}
    />
  )
}

function Item({ item }: { item: ContentItem }) {
  const published = item.status === 'published'
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={styles.rowText}>
        <Text style={styles.title} numberOfLines={1}>{item.title || 'Untitled'}</Text>
        {item.hook ? <Text style={styles.hook} numberOfLines={1}>{item.hook}</Text> : null}
        <Text style={styles.meta}>{item.type} · {relativeTime(item.published_at || item.created_at)}</Text>
      </View>
      <View style={[styles.badge, published ? styles.pub : styles.draft]}>
        <Text style={[styles.badgeText, published ? styles.pubText : styles.draftText]}>{published ? 'Live' : 'Draft'}</Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  list: { backgroundColor: '#0c0b09' },
  center: { flex: 1, backgroundColor: '#0c0b09', alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 14 },
  rowPressed: { backgroundColor: 'rgba(255,255,255,0.12)' },
  rowText: { flex: 1, minWidth: 0 },
  title: { color: '#fff', fontSize: 16, fontWeight: '600' },
  hook: { color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 2 },
  meta: { color: 'rgba(255,255,255,0.35)', fontSize: 12, marginTop: 4 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pub: { backgroundColor: 'rgba(34,197,94,0.15)' },
  draft: { backgroundColor: 'rgba(255,255,255,0.1)' },
  badgeText: { fontSize: 12, fontWeight: '600' },
  pubText: { color: '#22c55e' },
  draftText: { color: 'rgba(255,255,255,0.6)' },
  sep: { height: 8 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 8 },
  emptyEmoji: { fontSize: 44 },
  emptyTitle: { color: '#fff', fontSize: 18, fontWeight: '600' },
  emptySub: { color: 'rgba(255,255,255,0.4)', fontSize: 14, textAlign: 'center', paddingHorizontal: 32 },
})
