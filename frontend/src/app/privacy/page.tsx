/**
 * Privacy Policy — /privacy
 *
 * SERVER component. Static legal page wrapped in the shared MarketingShell.
 * Typography mirrors the public article page (/p/[handle]/[slug]): font-display
 * headings, ~72ch prose column, generous line-height, design-token colors.
 */

import type { Metadata } from 'next'
import MarketingShell from '@/components/marketing/MarketingShell'

export const metadata: Metadata = {
  title: 'Privacy Policy — Voice Native',
  description:
    'How Voice Native handles your data: your code runs on your own machine, you bring your own API keys, and we never train models on your code or content.',
}

export default function PrivacyPage() {
  return (
    <MarketingShell>
      <article className="w-full max-w-[72ch] mx-auto px-5 py-12 sm:py-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
          Last updated: October 22, 2026
        </p>

        <h1 className="mt-4 font-display text-3xl sm:text-4xl font-medium text-[var(--text-primary)] leading-[1.15] tracking-tight">
          Privacy Policy
        </h1>

        <p className="mt-4 text-[15px] italic text-[var(--text-secondary)] leading-relaxed">
          This is a general privacy policy written in plain language. Please read it
          carefully so you understand how your information is handled when you use
          Voice Native.
        </p>

        <div className="mt-8 h-px bg-[var(--border-subtle)]" />

        <div className="mt-8 prose-osborn text-[16px] text-[var(--text-secondary)] leading-[1.75] space-y-8">
          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Overview
            </h2>
            <p className="mt-3">
              Voice Native is a voice-native AI coding agent. You talk to it, and it
              writes, runs, and debugs code — on your own machine or in your own cloud
              sandbox. Our core promise is simple: your code stays where you put it.
              This policy explains what information we collect, why, and the choices you
              have. It applies to the Voice Native app and website.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Information we collect
            </h2>
            <p className="mt-3">
              We try to collect as little as possible. Depending on how you use Voice
              Native, this may include:
            </p>
            <ul className="mt-3 list-disc pl-6 space-y-2 marker:text-[var(--text-muted)]">
              <li>
                <strong className="text-[var(--text-primary)] font-medium">Account information.</strong>{' '}
                If you sign in with Google, we store your email address (via our auth
                provider) so we can identify your account. If you use the no-account
                &ldquo;connect without account&rdquo; mode, we do not collect account
                information.
              </li>
              <li>
                <strong className="text-[var(--text-primary)] font-medium">Voice and session data.</strong>{' '}
                Voice runs as real-time audio over LiveKit. To power session resume and
                history, we may store transcripts and session metadata (such as timing
                and the structure of a session). We do not store your source code as part
                of this — your code lives on your machine.
              </li>
              <li>
                <strong className="text-[var(--text-primary)] font-medium">Published content.</strong>{' '}
                If you explicitly choose to publish something, that content becomes public
                at a URL like <code className="text-[var(--accent)]">/p/&#123;handle&#125;/&#123;slug&#125;</code>.
                Nothing is published unless you choose to publish it.
              </li>
              <li>
                <strong className="text-[var(--text-primary)] font-medium">Usage analytics.</strong>{' '}
                We may collect basic, aggregate usage information (such as feature usage
                and error reports) to keep the product working and improve it.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              How we use it
            </h2>
            <p className="mt-3">
              We use the information above to operate the service: to authenticate you,
              to run and resume your voice sessions, to show your session history, to
              display content you choose to publish, and to diagnose and fix problems. We
              do not sell your personal information, and we do not use your code or your
              content to train AI models.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Where your code lives
            </h2>
            <p className="mt-3">
              This is the heart of Voice Native. The agent executes on your own machine or
              in your own cloud sandbox, so your source code and the files it touches never
              leave your environment as a core promise of the product. You also bring your
              own API keys for the underlying model providers, so your prompts and the
              agent&rsquo;s model calls flow directly between your environment and the
              provider you chose. There is no lock-in.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Third-party processors
            </h2>
            <p className="mt-3">
              We rely on a small number of trusted services to run Voice Native. Each
              processes only what it needs to do its job:
            </p>
            <ul className="mt-3 list-disc pl-6 space-y-2 marker:text-[var(--text-muted)]">
              <li>
                <strong className="text-[var(--text-primary)] font-medium">Supabase</strong>{' '}
                — authentication and database (your account email, session metadata, and
                published content).
              </li>
              <li>
                <strong className="text-[var(--text-primary)] font-medium">LiveKit</strong>{' '}
                — real-time voice audio transport.
              </li>
              <li>
                <strong className="text-[var(--text-primary)] font-medium">Model providers</strong>{' '}
                — accessed through the API keys you provide. Your use of them is governed
                by that provider&rsquo;s own terms and privacy policy.
              </li>
              <li>
                <strong className="text-[var(--text-primary)] font-medium">Railway</strong>{' '}
                — application hosting.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Data retention
            </h2>
            <p className="mt-3">
              We keep account information and session metadata for as long as your account
              is active, so that features like session resume and history work. Published
              content remains available until you unpublish or delete it. If you delete your
              account, we remove the associated personal data, except where we are required
              to retain it to comply with the law.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Your rights
            </h2>
            <p className="mt-3">
              You can access or delete the data associated with your account by contacting
              us. Signing out clears local session state on your device. If you published
              something and later want it gone, you can unpublish or delete it, and the
              public page will no longer be served.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Children
            </h2>
            <p className="mt-3">
              Voice Native is not directed to children under 13, and we do not knowingly
              collect personal information from them. If you believe a child has provided us
              with personal information, please contact us and we will delete it.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Changes
            </h2>
            <p className="mt-3">
              We may update this policy from time to time. When we make material changes, we
              will update the &ldquo;Last updated&rdquo; date above. Your continued use of
              Voice Native after a change means you accept the updated policy.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight">
              Contact
            </h2>
            <p className="mt-3">
              Questions about this policy or your data? Email us at{' '}
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
