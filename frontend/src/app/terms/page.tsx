/**
 * Terms of Service — /terms
 *
 * SERVER component. Static legal page wrapped in the shared MarketingShell.
 * Typography mirrors the public article page (/p/[handle]/[slug]): font-display
 * headings, ~72ch prose column, generous line-height, design-token colors.
 */

import type { Metadata } from 'next'
import MarketingShell from '@/components/marketing/MarketingShell'

export const metadata: Metadata = {
  title: 'Terms of Service — Voice Native',
  description:
    'The terms that govern your use of Voice Native, the voice-native AI coding agent — including accounts, publishing, bring-your-own API keys, and disclaimers.',
}

export default function TermsPage() {
  return (
    <MarketingShell>
      <article className="w-full max-w-[72ch] mx-auto px-5 py-12 sm:py-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
          Last updated: October 22, 2026
        </p>

        <h1 className="mt-4 font-display text-3xl sm:text-4xl font-medium text-[var(--text-primary)] leading-[1.15] tracking-tight">
          Terms of Service
        </h1>

        <p className="mt-4 text-[15px] italic text-[var(--text-secondary)] leading-relaxed">
          These are general terms of service written in plain language. Please read them
          carefully — by using Voice Native you are agreeing to them.
        </p>

        <div className="mt-8 h-px bg-[var(--border-subtle)]" />

        <div className="mt-8 prose-osborn text-[16px] text-[var(--text-secondary)] leading-[1.75] space-y-8">
          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Agreement
            </h2>
            <p className="mt-3">
              These Terms of Service (the &ldquo;Terms&rdquo;) govern your use of Voice
              Native. By accessing or using the service, you agree to be bound by these
              Terms. If you do not agree, please do not use Voice Native.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              The service
            </h2>
            <p className="mt-3">
              Voice Native is a voice-native AI coding agent. You talk to it, and it writes,
              runs, and debugs code on your own machine or in your own cloud sandbox. Voice
              runs as real-time audio over LiveKit, and your code executes in your own
              environment rather than on our servers.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Accounts and the no-account mode
            </h2>
            <p className="mt-3">
              You can sign in with Google, or you can use the no-account &ldquo;connect
              without account&rdquo; mode. If you create an account, you are responsible for
              the activity that happens under it and for keeping access to it secure. If you
              use the no-account mode, some features — such as saved history across devices —
              may not be available.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Acceptable use
            </h2>
            <p className="mt-3">
              You agree not to use Voice Native for anything illegal, abusive, or harmful,
              and not to interfere with or attempt to disrupt the service. Because the agent
              runs on your own machine or sandbox, you are responsible for the code you ask it
              to run, for the effects of running that code, and for the API keys you provide.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Your content and publishing
            </h2>
            <p className="mt-3">
              You own your content. Voice Native does not claim ownership of the code you
              write or the material you create. If you choose to publish something, it becomes
              publicly available at a URL like{' '}
              <code className="text-[var(--accent)]">/p/&#123;handle&#125;/&#123;slug&#125;</code>,
              and anyone with the link can view it. By publishing, you grant Voice Native a
              non-exclusive license to host, store, and display that published content so we
              can serve the public page. You can unpublish or delete published content at any
              time, and that license ends for the removed content. We do not use your content
              to train AI models.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              API keys and third-party services
            </h2>
            <p className="mt-3">
              Voice Native uses a bring-your-own-keys model: you supply your own API keys for
              the underlying model providers. Your use of those providers is governed by their
              own terms, and any costs they charge are your responsibility. We also rely on
              third-party services such as Supabase, LiveKit, and Railway to operate; their
              terms may apply to the parts of the service they power.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Disclaimers
            </h2>
            <p className="mt-3">
              AI output can be wrong, incomplete, or misleading. Always review what the agent
              produces before you rely on it — especially before running code or shipping it to
              production. Voice Native is provided &ldquo;as is&rdquo; and &ldquo;as
              available,&rdquo; without warranties of any kind, whether express or implied, to
              the fullest extent permitted by law.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Limitation of liability
            </h2>
            <p className="mt-3">
              To the fullest extent permitted by law, Voice Native and its operators will not
              be liable for any indirect, incidental, special, consequential, or punitive
              damages, or for any loss of data, profits, or revenue, arising out of or related
              to your use of the service — including any code the agent writes or runs, or any
              actions you take based on its output.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Termination
            </h2>
            <p className="mt-3">
              You may stop using Voice Native at any time. We may suspend or terminate access
              if you violate these Terms or if we need to protect the service or other users.
              Sections that by their nature should survive termination — such as content
              licenses for still-published material, disclaimers, and limitations of liability
              — will continue to apply.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Governing law
            </h2>
            <p className="mt-3">
              These Terms are governed by the laws applicable to Voice Native, without regard
              to conflict-of-laws principles. Any disputes will be resolved under those
              applicable laws.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Changes
            </h2>
            <p className="mt-3">
              We may update these Terms from time to time. When we make material changes, we
              will update the &ldquo;Last updated&rdquo; date above. Your continued use of
              Voice Native after a change means you accept the updated Terms.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Contact
            </h2>
            <p className="mt-3">
              Questions about these Terms? Email us at{' '}
              <a
                href="mailto:hello@voice-native.com"
                className="text-[var(--accent)] hover:opacity-80 transition-opacity"
              >
                hello@voice-native.com
              </a>
              .
            </p>
          </section>
        </div>
      </article>
    </MarketingShell>
  )
}
