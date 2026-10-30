import { Tabs } from 'expo-router'
import { Text } from 'react-native'

/**
 * Native iOS tab bar. Real UITabBar — frosted, haptic, system-rendered. The
 * glyphs are emoji for the Phase-0 scaffold (swap to SF Symbols / vector icons
 * in the polish phase). Three tabs mirror the web app's primary surfaces.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#3b82f6',
        tabBarInactiveTintColor: '#8e8e93',
        tabBarStyle: { backgroundColor: '#000' },
        headerStyle: { backgroundColor: '#0c0b09' },
        headerTintColor: '#fff',
        headerLargeTitle: true,
        headerLargeTitleStyle: { color: '#fff' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Sessions',
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 22 }}>💬</Text>,
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: 'Library',
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 22 }}>📚</Text>,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 22 }}>⚙️</Text>,
        }}
      />
    </Tabs>
  )
}
