'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useState, useCallback } from 'react'
import 'highlight.js/styles/github-dark.css'

interface MarkdownMessageProps {
  content: string
}

export function MarkdownMessage({ content }: MarkdownMessageProps) {
  // Debug: log what we're rendering
  console.log(`📝 MarkdownMessage rendering: "${content?.substring(0, 50)}..."`)

  // Safety check
  if (!content || typeof content !== 'string' || !content.trim()) {
    console.warn('⚠️ MarkdownMessage: empty or invalid content')
    return null
  }

  return (
    <div className="markdown-content prose prose-invert prose-sm max-w-none text-gray-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // Code blocks with copy button
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

            return (
              <CodeBlock language={language}>
                {String(children).replace(/\n$/, '')}
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

// Separate CodeBlock component with copy functionality
function CodeBlock({ children, language }: { children: string; language: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(children)
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
