import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Key, matchesKey } from '@earendil-works/pi-tui'
import {
  type AgentDefinition,
  loadAgentRegistry,
  runWorkflow,
  type WorkflowErrorCode,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from '@quintinshaw/pi-dynamic-workflows'

import { progressWidget } from './progress.ts'

export const SCOUT: AgentDefinition = {
  name: 'sdd-scout',
  description: 'Read-only, low-effort scout for spec-driven development',
  disallowedTools: ['edit', 'write'],
  thinking: 'low',
  prompt:
    'You are a read-only helper. Never create, edit or delete files, including through bash. Prefer rg and targeted reads over reading whole files. Stop as soon as you can answer, and report evidence exactly (path:line or URL).',
  source: 'user',
}

export type WorkflowRunner = (script: string, options: WorkflowRunOptions) => Promise<WorkflowRunResult<unknown>>

type AgentEnd = Parameters<NonNullable<WorkflowRunOptions['onAgentEnd']>>[0]

interface AgentFailure {
  label: string
  message: string
  code?: WorkflowErrorCode
}

function describeFailure(failure: AgentFailure): string {
  return `agent "${failure.label}" failed${failure.code ? ` (${failure.code})` : ''}: ${failure.message}`
}

function describeFailures(failures: AgentFailure[]): string {
  if (failures.length === 1) return describeFailure(failures[0]!)
  const described = failures.map(
    (failure) => `"${failure.label}"${failure.code ? ` (${failure.code})` : ''}: ${failure.message}`,
  )
  return `${failures.length} agents failed - ${described.join('; ')}`
}

export interface RunSddOptions {
  label: string
  maxAgents: number
  run?: WorkflowRunner | undefined
}

export async function runSdd<T>(ctx: ExtensionContext, script: string, args: unknown, opts: RunSddOptions): Promise<T> {
  const registry = loadAgentRegistry(ctx.cwd)
  if (!registry.has(SCOUT.name)) registry.set(SCOUT.name, SCOUT)
  const abort = new AbortController()
  const stopOnEscape =
    ctx.mode === 'tui'
      ? ctx.ui.onTerminalInput((data) => {
          if (!matchesKey(data, Key.escape)) return undefined
          abort.abort()
          return { consume: true }
        })
      : undefined
  const view = progressWidget(ctx, opts.label)
  // A recoverable agent failure is swallowed by the workflow library into a null
  // result. Keep every reported error, keyed by the library's per-call id, so the
  // null can explain itself instead of surfacing as an opaque "returned no result".
  const failures = new Map<string, AgentFailure>()
  try {
    const result = await (opts.run ?? runWorkflow)(script, {
      args,
      cwd: ctx.cwd,
      ...(ctx.model ? { mainModel: `${ctx.model.provider}/${ctx.model.id}` } : {}),
      modelRegistry: ctx.modelRegistry,
      agentRegistry: registry,
      providerMiddlewareExtensions: ['pi-web-access'],
      concurrency: 10,
      maxAgents: opts.maxAgents,
      signal: abort.signal,
      persistLogs: false,
      ...view.options,
      onAgentEnd: (event: AgentEnd) => {
        if (event.errorCode != null || event.error != null)
          failures.set(event.id, {
            label: event.label,
            message: event.error ?? event.errorCode ?? 'agent failed',
            ...(event.errorCode ? { code: event.errorCode } : {}),
          })
        view.options.onAgentEnd?.(event)
      },
    })
    if (abort.signal.aborted) throw new Error(`${opts.label} was stopped`)
    if (result.result == null) {
      if (failures.size) throw new Error(`${opts.label}: ${describeFailures([...failures.values()])}`)
      throw new Error(`${opts.label} returned no result`)
    }
    return result.result as T
  } finally {
    stopOnEscape?.()
    view.clear()
  }
}
