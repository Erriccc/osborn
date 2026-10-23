'use client'

import { useState } from 'react'

const QA = [
  {
    q: 'Where does my code run?',
    a: 'On your own machine — a cloud box you control or your local computer. Voice Native reads, writes, and executes code where it already lives. It is never uploaded to or stored on our servers.',
  },
  {
    q: 'Which AI models does it use?',
    a: 'Voice Native runs on Anthropic Claude — a team of Opus and Sonnet sub-agents for research, reasoning, writing, testing, and review. You bring your own model keys, so you control which models run and what they cost.',
  },
  {
    q: 'Can I bring my own keys?',
    a: 'Yes. Plug in your own Anthropic, OpenRouter, Fireworks, or Recall keys. They are stored encrypted on your own machine and never shown back — not to you, not to us. You control the models, the spend, and the data path.',
  },
  {
    q: 'Do I have to talk to it, or can I type?',
    a: 'Voice is the native way to work with Voice Native — you speak to it like a teammate and it plans out loud. You can still type when you need to, and you always see every file change and agent action on screen.',
  },
  {
    q: 'How is this different from a coding chatbot?',
    a: 'A chatbot hands you text to copy and paste. Voice Native is a voice-native engineer that actually runs on your machine — editing files, running tests, and hitting your services — while dispatching a team of specialist sub-agents you watch work in real time.',
  },
]

export default function FAQ() {
  const [open, setOpen] = useState<number | null>(0)

  return (
    <section aria-labelledby="faq-heading">
      <div className="mx-auto max-w-[800px] px-6 py-20 md:py-28">
        <div className="max-w-[40rem]">
          <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
            FAQ
          </span>
          <h2
            id="faq-heading"
            className="font-display mt-4 text-[var(--text-primary)] text-[clamp(2rem,4.5vw,3rem)] leading-[1.05] tracking-[-0.02em] font-semibold"
          >
            Questions, answered.
          </h2>
        </div>

        <div className="mt-12 flex flex-col">
          {QA.map((item, i) => {
            const isOpen = open === i
            return (
              <div key={item.q} className="border-b border-[var(--border-subtle)]">
                <h3>
                  <button
                    type="button"
                    className="w-full flex items-center justify-between gap-4 py-5 text-left"
                    aria-expanded={isOpen}
                    aria-controls={`faq-panel-${i}`}
                    onClick={() => setOpen(isOpen ? null : i)}
                  >
                    <span className="font-display text-[var(--text-primary)] text-[18px] md:text-[20px] tracking-[-0.01em]">
                      {item.q}
                    </span>
                    <span
                      className="flex-shrink-0 text-[var(--accent)] text-[20px] leading-none transition-transform duration-200"
                      style={{ transform: isOpen ? 'rotate(45deg)' : 'none' }}
                      aria-hidden="true"
                    >
                      +
                    </span>
                  </button>
                </h3>
                {/* Answer stays in the DOM for SEO; visually collapsed when closed */}
                <div
                  id={`faq-panel-${i}`}
                  className="overflow-hidden transition-all duration-200"
                  style={{
                    maxHeight: isOpen ? 320 : 0,
                    opacity: isOpen ? 1 : 0,
                  }}
                >
                  <p className="pb-5 pr-8 text-[var(--text-secondary)] text-[15px] leading-[1.65]">
                    {item.a}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
