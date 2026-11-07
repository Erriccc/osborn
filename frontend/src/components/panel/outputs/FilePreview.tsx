'use client'

// One file preview used by the Outputs drawer and the expanded Files view, so
// both render the same honest states (UI#20): images by extension, no literal
// "Empty file", no infrastructure text, and a retry on errors.
import { MarkdownMessage, MermaidBlock } from '../../MarkdownMessage'
import { previewKind, imageSrc, isSensitivePath, LOAD_ERROR_DENIED, LOAD_ERROR_OUTSIDE, type OutputFile } from '@/lib/outputs-model'

const HTML_DOC = (body: string) => `<!DOCTYPE html><html><head><style>html{font-size:16px}body{margin:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#e2e8f0;background:#1a1a2e}table{border-collapse:collapse;width:100%}th,td{border:1px solid #475569;padding:8px 12px;text-align:left}th{background:#334155}h1,h2,h3{color:#f1f5f9}a{color:#60a5fa}code{background:#334155;padding:2px 6px;border-radius:4px;font-size:14px}pre{background:#0f172a;padding:16px;border-radius:8px;overflow-x:auto}</style></head><body>${body}</body></html>`
const SVG_DOC = (body: string) => `<!DOCTYPE html><html><head><style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#1a1a2e;overflow:hidden}svg{width:100%;height:100%;max-width:100vw;max-height:100vh}</style></head><body>${body}</body></html>`

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center text-gray-500 text-xs gap-2 px-6">
      <div className="font-medium text-gray-400">{title}</div>
      {children}
    </div>
  )
}

function OpenLink({ url, label }: { url: string; label: string }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border border-amber-500/30 text-xs font-medium">
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
      {label}
    </a>
  )
}

export function FilePreview({ file, onRetry, compact }: { file: OutputFile; onRetry?: () => void; compact?: boolean }) {
  // Dotfiles and secret-looking names (.env, *.pem, id_rsa…) and paths the
  // browser refused to request are never rendered, whatever is cached.
  if (file.loadError === LOAD_ERROR_DENIED || isSensitivePath(file.filePath)) {
    return <Notice title="Preview not available" />
  }
  const kind = previewKind(file)
  const frameMin = compact ? 'min-h-[320px]' : 'min-h-[500px]'
  switch (kind) {
    case 'loading':
      return (
        <div className="flex items-center justify-center py-12 text-gray-500 text-xs" role="status">
          <svg className="w-5 h-5 animate-spin motion-reduce:animate-none mr-2" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading…
        </div>
      )
    case 'error':
      if (file.loadError === LOAD_ERROR_OUTSIDE) {
        return (
          <Notice title="Preview not available yet">
            <div className="max-w-xs leading-relaxed">
              Osborn saved this file outside the session folder, at <span className="font-mono break-all text-gray-400">{file.filePath}</span>. Ask Osborn to show it, or open it on the machine.
            </div>
          </Notice>
        )
      }
      return (
        <Notice title="Couldn't load this file">
          {onRetry && (
            <button onClick={onRetry} className="mt-1 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-200 hover:border-amber-500/40">Retry</button>
          )}
        </Notice>
      )
    case 'unavailable':
      return (
        <Notice title="Preview not available">
          <div className="max-w-xs leading-relaxed">
            This file is too large to preview here{file.originalSize ? ` (${Math.round(file.originalSize / 1024)} KB)` : ''}.
          </div>
          {file.url && <OpenLink url={file.url} label={`Open ${file.fileName}`} />}
        </Notice>
      )
    case 'empty':
      return <Notice title="This file is empty" />
    case 'link':
      return <div className="py-4"><OpenLink url={file.url!} label={`Open ${file.fileName}`} /></div>
    case 'image': {
      const src = imageSrc(file)
      if (!src) return <Notice title="Preview not available" />
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={src} alt={file.fileName} className="max-w-full rounded-lg border border-gray-700" />
    }
    case 'pdf':
      return <iframe src={file.url} className={`w-full h-full ${frameMin} rounded-lg border border-gray-700 bg-gray-800`} title={file.fileName} />
    case 'svg':
      return <iframe srcDoc={SVG_DOC(file.content || '')} className={`w-full h-full ${frameMin} rounded-lg border border-gray-700`} sandbox="allow-scripts" title={file.fileName} />
    case 'html':
      return <iframe srcDoc={HTML_DOC(file.content || '')} className={`w-full h-full ${frameMin} rounded-lg border border-gray-700`} sandbox="allow-scripts" title={file.fileName} />
    case 'mermaid':
      return <MermaidBlock code={file.content || ''} />
    case 'markdown':
    default:
      return (
        <div className="text-sm">
          {file.truncated && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-300">
              Showing the first part of this file{file.originalSize ? ` (full size ${Math.round(file.originalSize / 1024)} KB)` : ''}.
            </div>
          )}
          <MarkdownMessage content={file.content || ''} />
        </div>
      )
  }
}
