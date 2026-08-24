'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useState, useCallback, useEffect, useRef } from 'react'
import 'highlight.js/styles/github-dark.css'

interface MarkdownMessageProps {
  content: string
}

export function MarkdownMessage({ content }: MarkdownMessageProps) {
  // Safety check
  if (!content || typeof content !== 'string' || !content.trim()) {
    return null
  }

  return (
    <div className="markdown-content prose prose-invert prose-sm max-w-none text-gray-100 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // Code blocks with copy button — Mermaid blocks get visual rendering
          code({ node, className, children, ...props }) {
            const isInline = !className
            const match = /language-(\w+)/.exec(className || '')
            const language = match ? match[1] : ''

            if (isInline) {
              return (
                <code className="bg-gray-800 px-1.5 py-0.5 rounded text-sm font-mono text-blue-300" {...props}>
                  {children}
                </code>
              )
            }

            // Mermaid code blocks → render as visual diagrams
            if (language === 'mermaid') {
              const code = extractText(children).replace(/\n$/, '')
              return <MermaidBlock code={code} />
            }

            return (
              <CodeBlock language={language}>
                {children}
              </CodeBlock>
            )
          },

          // Links
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
              >
                {children}
              </a>
            )
          },

          // Lists
          ul({ children }) {
            return <ul className="list-disc ml-4 space-y-1 my-2">{children}</ul>
          },
          ol({ children }) {
            return <ol className="list-decimal ml-4 space-y-1 my-2">{children}</ol>
          },
          li({ children }) {
            return <li className="text-gray-200">{children}</li>
          },

          // Headings
          h1({ children }) {
            return <h1 className="text-xl font-bold text-white mt-4 mb-2">{children}</h1>
          },
          h2({ children }) {
            return <h2 className="text-lg font-semibold text-white mt-3 mb-2">{children}</h2>
          },
          h3({ children }) {
            return <h3 className="text-base font-semibold text-gray-100 mt-2 mb-1">{children}</h3>
          },

          // Paragraphs
          p({ children }) {
            return <p className="text-gray-200 my-2 leading-relaxed">{children}</p>
          },

          // Blockquotes
          blockquote({ children }) {
            return (
              <blockquote className="border-l-4 border-blue-500 pl-4 my-2 text-gray-300 italic">
                {children}
              </blockquote>
            )
          },

          // Tables
          table({ children }) {
            return (
              <div className="overflow-x-auto my-2">
                <table className="min-w-full border-collapse border border-gray-700">
                  {children}
                </table>
              </div>
            )
          },
          th({ children }) {
            return (
              <th className="border border-gray-700 px-3 py-2 bg-gray-800 text-left text-gray-200 font-semibold">
                {children}
              </th>
            )
          },
          td({ children }) {
            return (
              <td className="border border-gray-700 px-3 py-2 text-gray-300">
                {children}
              </td>
            )
          },

          // Bold and italic
          strong({ children }) {
            return <strong className="font-semibold text-white">{children}</strong>
          },
          em({ children }) {
            return <em className="italic text-gray-300">{children}</em>
          },

          // Horizontal rule
          hr() {
            return <hr className="my-4 border-gray-700" />
          },

          // Pre (for code blocks wrapper)
          pre({ children }) {
            return <>{children}</>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

// Extract plain text from React children tree (for copy button)
function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as React.ReactElement).props.children)
  }
  return ''
}

// Sanitize common mermaid syntax issues generated by LLMs
function sanitizeMermaid(code: string): string {
  // Strip trailing non-Mermaid lines (safety net for unclosed fences where
  // markdown text leaks into the code block)
  const rawLines = code.split('\n')
  let lastMermaidLine = rawLines.length - 1
  while (lastMermaidLine >= 0) {
    const t = rawLines[lastMermaidLine].trim()
    if (t === '' || /^(\*\*|[-*+]\s|#{1,6}\s|>\s|!\[)/.test(t)) {
      lastMermaidLine--
    } else {
      break
    }
  }
  const lines = rawLines.slice(0, lastMermaidLine + 1)

  // Track node ID replacements so edges/styles stay consistent
  const idMap: Record<string, string> = {}
  const sanitizeId = (id: string) => {
    if (!id.includes('.') && !id.includes('-')) return id
    if (!idMap[id]) idMap[id] = id.replace(/[.-]/g, '_')
    return idMap[id]
  }

  // Protect quoted label text from ID sanitization — extract "..." regions,
  // apply the transform, then restore them
  const withQuotesPreserved = (line: string, transform: (safe: string) => string): string => {
    const labels: string[] = []
    const safe = line.replace(/"[^"]*"/g, (m) => { labels.push(m); return `__Q${labels.length - 1}__` })
    let result = transform(safe)
    labels.forEach((lbl, i) => { result = result.replace(`__Q${i}__`, lbl) })
    return result
  }

  const idRegex = /\b([\w][\w.\-]*\.[\w]+|[\w]+\-[\w.\-]*[\w]+)\b/g

  return lines.map(line => {
    // Auto-quote bracket labels containing special chars that Mermaid
    // would otherwise interpret as syntax: A[text: (parens)] → A["text: (parens)"]
    line = line.replace(/\[([^\]"]+)\]/g, (_match, label: string) => {
      if (/[:()\{\}]/.test(label)) return `["${label}"]`
      return _match
    })

    // Auto-quote edge labels with special chars: -- text (1008) --> → -- "text (1008)" -->
    line = line.replace(/--\s+([^">\|][^>\|]*?)\s+-->/g, (_match, label: string) => {
      if (/[:()\{\}]/.test(label.trim())) return `-- "${label.trim()}" -->`
      return _match
    })

    const trimmed = line.trim()
    const indent = line.match(/^\s*/)?.[0] || ''

    // subgraph lines: fix parens in bracket labels, sanitize ID
    if (trimmed.startsWith('subgraph ')) {
      let fixed = line
      // Strip parens inside bracket labels: [Label (v1.0)] → [Label v1.0]
      fixed = fixed.replace(/(\[.*?)\(([^)]*)\)(.*?\])/g, '$1$2$3')
      return fixed
    }

    // Edge lines (-->  ---  -.->  ==>): sanitize node IDs on both sides
    if (/-->|---|-.->|==>/.test(trimmed) && !trimmed.startsWith('style') && !trimmed.startsWith('class')) {
      return withQuotesPreserved(line, (safe) =>
        safe.replace(idRegex, (match) => sanitizeId(match))
      )
    }

    // style lines: sanitize target ID, handle spaces in subgraph names
    if (trimmed.startsWith('style ')) {
      const m = trimmed.match(/^style\s+(.+?)\s+(fill:.*)$/)
      if (m) {
        const target = m[1].includes('.') || m[1].includes('-') ? sanitizeId(m[1]) : m[1]
        return `${indent}style ${target} ${m[2]}`
      }
    }

    // class lines: sanitize member IDs
    if (trimmed.startsWith('class ') && !trimmed.startsWith('classDef ')) {
      return withQuotesPreserved(line, (safe) =>
        safe.replace(idRegex, (match) => sanitizeId(match))
      )
    }

    // Node definitions with labels: NodeId[Label] or NodeId(Label) — sanitize the ID part
    const nodeDefMatch = trimmed.match(/^([\w][\w.\-]*[\w])\s*[\[\(]/)
    if (nodeDefMatch) {
      const origId = nodeDefMatch[1]
      if (origId.includes('.') || origId.includes('-')) {
        return line.replace(origId, sanitizeId(origId))
      }
    }

    return line
  }).join('\n')
}

// Lazy singleton — initialize mermaid once, reuse across all MermaidBlock instances
let mermaidReady: Promise<typeof import('mermaid').default> | null = null
function getMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then(m => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
          darkMode: true,
          background: '#1e293b',
          primaryColor: '#6366f1',
          primaryTextColor: '#e2e8f0',
          primaryBorderColor: '#4f46e5',
          lineColor: '#64748b',
          secondaryColor: '#334155',
          tertiaryColor: '#1e293b',
          noteTextColor: '#e2e8f0',
          noteBkgColor: '#334155',
          fontSize: '14px',
        },
        flowchart: { curve: 'basis', padding: 12 },
        securityLevel: 'strict',
      })
      return m.default
    })
  }
  return mermaidReady
}

// Mermaid diagram renderer — converts Mermaid syntax to visual SVG
let mermaidId = 0
export function MermaidBlock({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const id = `mermaid-${++mermaidId}`

    async function render() {
      try {
        const mermaid = await getMermaid()

        // Sanitize common mermaid syntax issues generated by LLMs
        const sanitized = sanitizeMermaid(code)

        // Parse first — throws on syntax error without touching the DOM
        await mermaid.parse(sanitized)

        // Render into an offscreen container to prevent DOM leaks on error
        const offscreen = document.createElement('div')
        offscreen.style.position = 'absolute'
        offscreen.style.left = '-9999px'
        offscreen.style.top = '-9999px'
        document.body.appendChild(offscreen)
        try {
          const { svg: rendered } = await mermaid.render(id, sanitized, offscreen)
          if (!cancelled) setSvg(rendered)
        } finally {
          document.body.removeChild(offscreen)
        }
      } catch (err) {
        // Clean up any leaked mermaid error elements
        const leaked = document.getElementById(id)
        if (leaked) leaked.remove()
        const errorEl = document.getElementById('d' + id)
        if (errorEl) errorEl.remove()
        if (!cancelled) setError((err as Error).message)
      }
    }

    render()
    return () => { cancelled = true }
  }, [code])

  if (error) {
    return (
      <div className="my-3">
        <div className="text-xs text-red-400 mb-1">Mermaid syntax error</div>
        <pre className="bg-gray-900 rounded-lg p-4 overflow-x-auto border border-gray-700 text-sm text-gray-300">
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="my-3 flex items-center justify-center py-8 bg-gray-900/50 rounded-lg border border-gray-700">
        <svg className="w-5 h-5 animate-spin mr-2 text-gray-500" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-xs text-gray-500">Rendering diagram...</span>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="my-3 overflow-x-auto bg-gray-900/50 rounded-lg border border-gray-700 p-4"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

// Separate CodeBlock component with copy functionality
function CodeBlock({ children, language }: { children: React.ReactNode; language: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    const text = extractText(children).replace(/\n$/, '')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [children])

  return (
    <div className="relative group my-3">
      {/* Language badge */}
      {language && (
        <div className="absolute top-0 left-0 px-2 py-1 text-xs text-gray-400 bg-gray-800 rounded-tl-lg rounded-br-lg border-b border-r border-gray-700">
          {language}
        </div>
      )}

      {/* Copy button */}
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>

      {/* Code content */}
      <pre className="bg-gray-900 rounded-lg p-4 pt-8 overflow-x-auto border border-gray-700">
        <code className={`language-${language} text-sm`}>{children}</code>
      </pre>
    </div>
  )
}

export default MarkdownMessage
