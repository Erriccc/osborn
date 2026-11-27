import { notFound } from 'next/navigation'
import { StoreFixture } from './store-fixture'

// Dev-only fixture: the store Browse tab with sample catalog data and no
// machine, for screenshots (scripts/ui-shots.mjs). 404 in production builds.
export default function StoreFixturePage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <StoreFixture />
}
