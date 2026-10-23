import type { Metadata } from 'next'
import LandingNav from '@/components/landing/LandingNav'
import Hero from '@/components/landing/Hero'
import CredibilityBar from '@/components/landing/CredibilityBar'
import HowItWorks from '@/components/landing/HowItWorks'
import SubAgentTeam from '@/components/landing/SubAgentTeam'
import FeatureMemory from '@/components/landing/FeatureMemory'
import FeatureSkills from '@/components/landing/FeatureSkills'
import FeatureMeetings from '@/components/landing/FeatureMeetings'
import FeatureLiveActivity from '@/components/landing/FeatureLiveActivity'
import SecurityTrust from '@/components/landing/SecurityTrust'
import SocialProof from '@/components/landing/SocialProof'
import PricingTeaser from '@/components/landing/PricingTeaser'
import FAQ from '@/components/landing/FAQ'
import FinalCTA from '@/components/landing/FinalCTA'
import LandingFooter from '@/components/landing/LandingFooter'

export const metadata: Metadata = {
  title: 'Voice Native — The AI Coding Agent You Talk To',
  description:
    'Talk to Voice Native and it writes, runs, and debugs code on your own machine. A team of Claude sub-agents, persistent memory, live activity. Your code, your keys.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Voice Native',
    url: 'https://www.voice-native.com',
    title: 'Voice Native — Talk to it. It ships.',
    description:
      'A voice-native AI engineer that writes and runs code on your machine, with a team of Claude sub-agents you watch work in real time. Your code, your keys.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Voice Native — Talk to it. It ships.',
    description:
      'Voice-native AI engineer. Speak to it; it writes and runs code on your machine with a team of Claude sub-agents. Your code, your keys.',
  },
}

// JSON-LD SoftwareApplication structured data for rich results.
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Voice Native',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Web, macOS, Linux',
  description:
    'Voice-native AI coding agent. Talk to it and it writes, runs, and debugs code on your own machine with a team of Claude sub-agents.',
  url: 'https://www.voice-native.com',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
}

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <main className="bg-[var(--background)] text-[var(--text-primary)] overflow-x-hidden">
        <LandingNav />
        <Hero />
        <CredibilityBar />
        <HowItWorks />
        <SubAgentTeam />
        <FeatureMemory />
        <FeatureSkills />
        <FeatureMeetings />
        <FeatureLiveActivity />
        <SecurityTrust />
        <SocialProof />
        <PricingTeaser />
        <FAQ />
        <FinalCTA />
        <LandingFooter />
      </main>
    </>
  )
}
