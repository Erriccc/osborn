'use client'

import { useState } from 'react'
import {
  type EnvConfig,
  defaultEnvConfig,
  generateAgentEnv,
  generateFrontendEnv,
  validateLivekitUrl,
  validateAnthropicKey,
  checkAgentHealth,
} from '@/lib/setup'

interface SetupWizardProps {
  onComplete: (agentUrl: string) => void
  onSkip: () => void
}

const TOTAL_STEPS = 6

// ── Progress Bar ──────────────────────────────────────────────

function ProgressBar({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex items-center justify-center gap-1 mb-8">
      {Array.from({ length: TOTAL_STEPS }, (_, i) => (
        <div key={i} className="flex items-center">
          <div
            className={`w-3 h-3 rounded-full transition-all duration-300 ${
              i < currentStep
                ? 'bg-violet-500'
                : i === currentStep
                  ? 'bg-violet-400 ring-2 ring-violet-400/40'
                  : 'bg-gray-700'
            }`}
          />
          {i < TOTAL_STEPS - 1 && (
            <div
              className={`w-8 h-0.5 transition-all duration-300 ${
                i < currentStep ? 'bg-violet-500' : 'bg-gray-700'
              }`}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// ── API Key Input ─────────────────────────────────────────────

function ApiKeyInput({
  label,
  value,
  onChange,
  placeholder,
  helpUrl,
  helpLabel,
  error,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  helpUrl?: string
  helpLabel?: string
  error?: string
}) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-300">{label}</label>
        {helpUrl && (
          <a
            href={helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
          >
            {helpLabel || 'Get key'}
          </a>
        )}
      </div>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`w-full px-3 py-2.5 bg-gray-900 border rounded-lg text-white placeholder-gray-500 focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 focus:outline-none transition-all text-sm font-mono pr-10 ${
            error ? 'border-red-500/70' : 'border-gray-700'
          }`}
        />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
        >
          {visible ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.59 6.59m7.532 7.532l3.29 3.29M3 3l18 18" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          )}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

// ── Env File Preview ──────────────────────────────────────────

function EnvFilePreview({ filename, content }: { filename: string; content: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="rounded-lg border border-gray-700 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-800/80 border-b border-gray-700">
        <span className="text-xs font-mono text-gray-400">{filename}</span>
        <button
          onClick={handleCopy}
          className="px-2.5 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-300 transition-colors"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="p-3 bg-gray-900/80 text-sm font-mono text-green-400 overflow-x-auto whitespace-pre max-h-64 overflow-y-auto">
        {content}
      </pre>
    </div>
  )
}

// ── Step Card ─────────────────────────────────────────────────

function StepCard({
  title,
  description,
  children,
  onNext,
  onBack,
  onSkip,
  nextLabel,
  nextDisabled,
  showBack,
}: {
  title: string
  description: string
  children: React.ReactNode
  onNext: () => void
  onBack?: () => void
  onSkip?: () => void
  nextLabel?: string
  nextDisabled?: boolean
  showBack?: boolean
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white mb-1">{title}</h2>
        <p className="text-sm text-gray-400">{description}</p>
      </div>

      <div className="space-y-4">{children}</div>

      <div className="flex items-center justify-between pt-2">
        <div>
          {showBack && onBack && (
            <button
              onClick={onBack}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Back
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {onSkip && (
            <button
              onClick={onSkip}
              className="px-4 py-2 text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              Skip Setup
            </button>
          )}
          <button
            onClick={onNext}
            disabled={nextDisabled}
            className="px-5 py-2.5 bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 rounded-xl text-white text-sm font-medium transition-all shadow-lg shadow-violet-500/20 disabled:shadow-none"
          >
            {nextLabel || 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Wizard ───────────────────────────────────────────────

export default function SetupWizard({ onComplete, onSkip }: SetupWizardProps) {
  const [step, setStep] = useState(0)
  const [config, setConfig] = useState<EnvConfig>(defaultEnvConfig)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [envTab, setEnvTab] = useState<'agent' | 'frontend'>('agent')
  const [agentUrl, setAgentUrl] = useState('http://localhost:8741')
  const [healthStatus, setHealthStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [checking, setChecking] = useState(false)

  const updateConfig = (field: keyof EnvConfig, value: string) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => {
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  const next = () => setStep((s) => Math.min(TOTAL_STEPS - 1, s + 1))
  const back = () => setStep((s) => Math.max(0, s - 1))

  // ── Step 0: Welcome ─────────────────────────────────────────

  if (step === 0) {
    return (
      <div className="w-full max-w-lg mx-auto">
        <ProgressBar currentStep={0} />
        <div className="text-center space-y-6">
          <div className="w-20 h-20 rounded-full bg-gradient-to-br from-violet-500/30 to-purple-600/30 flex items-center justify-center mx-auto">
            <svg className="w-10 h-10 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <div>
            <h1 className="text-3xl font-bold text-white mb-2">Welcome to Osborn</h1>
            <p className="text-gray-400 max-w-sm mx-auto">
              Let&apos;s set up your environment. You&apos;ll need API keys for LiveKit, Anthropic, and a voice provider.
            </p>
          </div>
          <div className="flex flex-col items-center gap-3 pt-2">
            <button
              onClick={next}
              className="px-8 py-3 bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 rounded-xl text-white font-medium transition-all shadow-lg shadow-violet-500/20"
            >
              Get Started
            </button>
            <button
              onClick={onSkip}
              className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              Skip — I&apos;ll configure manually
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 1: LiveKit ─────────────────────────────────────────

  if (step === 1) {
    const validateStep1 = () => {
      const errs: Record<string, string> = {}
      if (!config.livekitUrl) errs.livekitUrl = 'Required'
      else if (!validateLivekitUrl(config.livekitUrl)) errs.livekitUrl = 'Must start with wss://'
      if (!config.livekitApiKey) errs.livekitApiKey = 'Required'
      if (!config.livekitApiSecret) errs.livekitApiSecret = 'Required'
      setErrors(errs)
      if (!Object.keys(errs).length) next()
    }

    return (
      <div className="w-full max-w-lg mx-auto">
        <ProgressBar currentStep={1} />
        <StepCard
          title="LiveKit Configuration"
          description="LiveKit handles real-time audio transport between the frontend and agent."
          onNext={validateStep1}
          onBack={back}
          onSkip={onSkip}
          showBack
        >
          <ApiKeyInput
            label="LiveKit URL"
            value={config.livekitUrl}
            onChange={(v) => updateConfig('livekitUrl', v)}
            placeholder="wss://your-app.livekit.cloud"
            helpUrl="https://cloud.livekit.io"
            helpLabel="Get from cloud.livekit.io"
            error={errors.livekitUrl}
          />
          <ApiKeyInput
            label="API Key"
            value={config.livekitApiKey}
            onChange={(v) => updateConfig('livekitApiKey', v)}
            placeholder="APIxxxxxxxx"
            error={errors.livekitApiKey}
          />
          <ApiKeyInput
            label="API Secret"
            value={config.livekitApiSecret}
            onChange={(v) => updateConfig('livekitApiSecret', v)}
            placeholder="Your LiveKit API secret"
            error={errors.livekitApiSecret}
          />
        </StepCard>
      </div>
    )
  }

  // ── Step 2: Anthropic ───────────────────────────────────────

  if (step === 2) {
    const validateStep2 = () => {
      const errs: Record<string, string> = {}
      if (!config.anthropicApiKey) errs.anthropicApiKey = 'Required'
      else if (!validateAnthropicKey(config.anthropicApiKey)) errs.anthropicApiKey = 'Must start with sk-ant-'
      setErrors(errs)
      if (!Object.keys(errs).length) next()
    }

    return (
      <div className="w-full max-w-lg mx-auto">
        <ProgressBar currentStep={2} />
        <StepCard
          title="Anthropic API Key"
          description="Claude powers the research agent. You need an API key from Anthropic."
          onNext={validateStep2}
          onBack={back}
          onSkip={onSkip}
          showBack
        >
          <ApiKeyInput
            label="API Key"
            value={config.anthropicApiKey}
            onChange={(v) => updateConfig('anthropicApiKey', v)}
            placeholder="sk-ant-api03-..."
            helpUrl="https://console.anthropic.com/settings/keys"
            helpLabel="Get from console.anthropic.com"
            error={errors.anthropicApiKey}
          />
        </StepCard>
      </div>
    )
  }

  // ── Step 3: Voice Provider ──────────────────────────────────

  if (step === 3) {
    const validateStep3 = () => {
      const errs: Record<string, string> = {}
      if (config.voiceProvider === 'openai' && !config.openaiApiKey) {
        errs.openaiApiKey = 'Required for OpenAI voice'
      }
      if (config.voiceProvider === 'gemini' && !config.googleApiKey) {
        errs.googleApiKey = 'Required for Gemini voice'
      }
      setErrors(errs)
      if (!Object.keys(errs).length) next()
    }

    return (
      <div className="w-full max-w-lg mx-auto">
        <ProgressBar currentStep={3} />
        <StepCard
          title="Voice Provider"
          description="Choose OpenAI or Gemini for real-time voice. You need at least one."
          onNext={validateStep3}
          onBack={back}
          onSkip={onSkip}
          showBack
        >
          {/* Provider toggle */}
          <div className="flex gap-2">
            <button
              onClick={() => updateConfig('voiceProvider', 'openai')}
              className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                config.voiceProvider === 'openai'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              OpenAI
            </button>
            <button
              onClick={() => updateConfig('voiceProvider', 'gemini')}
              className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                config.voiceProvider === 'gemini'
                  ? 'bg-green-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              Gemini
            </button>
          </div>

          {config.voiceProvider === 'openai' && (
            <ApiKeyInput
              label="OpenAI API Key"
              value={config.openaiApiKey}
              onChange={(v) => updateConfig('openaiApiKey', v)}
              placeholder="sk-..."
              helpUrl="https://platform.openai.com/api-keys"
              helpLabel="Get from platform.openai.com"
              error={errors.openaiApiKey}
            />
          )}

          {config.voiceProvider === 'gemini' && (
            <ApiKeyInput
              label="Google API Key"
              value={config.googleApiKey}
              onChange={(v) => updateConfig('googleApiKey', v)}
              placeholder="AI..."
              helpUrl="https://aistudio.google.com/apikey"
              helpLabel="Get from aistudio.google.com"
              error={errors.googleApiKey}
            />
          )}

          <div className="pt-2 border-t border-gray-700/50">
            <ApiKeyInput
              label="Smithery API Key (optional)"
              value={config.smitheryApiKey}
              onChange={(v) => updateConfig('smitheryApiKey', v)}
              placeholder="smi_..."
              helpUrl="https://smithery.ai"
              helpLabel="Get from smithery.ai"
            />
            <p className="text-xs text-gray-500 mt-1">Enables cloud-hosted MCP servers (YouTube, GitHub)</p>
          </div>
        </StepCard>
      </div>
    )
  }

  // ── Step 4: Environment Files ───────────────────────────────

  if (step === 4) {
    const agentEnv = generateAgentEnv(config)
    const frontendEnv = generateFrontendEnv(config)

    return (
      <div className="w-full max-w-lg mx-auto">
        <ProgressBar currentStep={4} />
        <StepCard
          title="Environment Files"
          description="Copy these into your project. The agent needs agent/.env and the frontend needs frontend/.env.local."
          onNext={next}
          onBack={back}
          onSkip={onSkip}
          showBack
        >
          {/* Tab selector */}
          <div className="flex gap-1 p-1 bg-gray-800/60 rounded-lg">
            <button
              onClick={() => setEnvTab('agent')}
              className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                envTab === 'agent'
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              agent/.env
            </button>
            <button
              onClick={() => setEnvTab('frontend')}
              className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                envTab === 'frontend'
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              frontend/.env.local
            </button>
          </div>

          {envTab === 'agent' && <EnvFilePreview filename="agent/.env" content={agentEnv} />}
          {envTab === 'frontend' && <EnvFilePreview filename="frontend/.env.local" content={frontendEnv} />}

          <p className="text-xs text-gray-500">
            Create these files in the respective directories, then start both servers.
          </p>
        </StepCard>
      </div>
    )
  }

  // ── Step 5: Verification ────────────────────────────────────

  if (step === 5) {
    const handleCheck = async () => {
      setChecking(true)
      setHealthStatus(null)
      const result = await checkAgentHealth(agentUrl)
      setHealthStatus(result)
      setChecking(false)
    }

    const handleFinish = () => {
      onComplete(agentUrl)
    }

    return (
      <div className="w-full max-w-lg mx-auto">
        <ProgressBar currentStep={5} />
        <StepCard
          title="Verify Connection"
          description="Make sure the agent server is running and reachable."
          onNext={handleFinish}
          onBack={back}
          nextLabel="Finish Setup"
          showBack
        >
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-300">Agent Server URL</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={agentUrl}
                onChange={(e) => { setAgentUrl(e.target.value); setHealthStatus(null) }}
                placeholder="http://localhost:8741"
                className="flex-1 px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 focus:outline-none transition-all text-sm font-mono"
              />
              <button
                onClick={handleCheck}
                disabled={checking || !agentUrl.trim()}
                className="px-4 py-2.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 rounded-lg text-white text-sm font-medium transition-colors shrink-0"
              >
                {checking ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : 'Check'}
              </button>
            </div>
          </div>

          {healthStatus && (
            <div className={`flex items-center gap-2 p-3 rounded-lg border ${
              healthStatus.ok
                ? 'bg-green-900/30 border-green-700/50 text-green-400'
                : 'bg-red-900/30 border-red-700/50 text-red-400'
            }`}>
              <div className={`w-2 h-2 rounded-full ${healthStatus.ok ? 'bg-green-400' : 'bg-red-400'}`} />
              <span className="text-sm">{healthStatus.message}</span>
            </div>
          )}

          <p className="text-xs text-gray-500">
            This step is optional — you can finish setup and connect later.
          </p>
        </StepCard>
      </div>
    )
  }

  return null
}
