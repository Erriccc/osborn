import type { Metadata } from 'next'

// Throwaway comparison route — keep it out of search + sitemaps.
export const metadata: Metadata = {
  title: 'Native feel demo',
  robots: { index: false, follow: false },
}

export default function NativeDemoLayout({ children }: { children: React.ReactNode }) {
  return children
}
