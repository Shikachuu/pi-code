import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import { Container, Markdown, Text } from '@earendil-works/pi-tui'
import { loadAgentRegistry } from '@quintinshaw/pi-dynamic-workflows'

import { runSdd, type WorkflowRunner } from '../sdd/runner.ts'
import type { Reports } from './report.ts'
import { mergeFindings, renderSummary, verdict as computeVerdict } from './report.ts'
import { formatScope, isLarge, resolveScope, type Scope } from './scope.ts'
import { VERIFY_AGENTS, VERIFY_SCRIPT, verifyArgs } from './workflow.ts'

export interface VerificationOptions {
  run?: WorkflowRunner | undefined
}

// The ask-user DOC_ENTRY renderer collapses to a one-line header until the user
// expands it via the transcript's own UI toggle, which left /verify's report
// invisible unless the main agent happened to relay the sendMessage content back
// as prose. /verify's report *is* the payload the user asked for, so it gets its
// own entry type that always renders the full markdown.
export const VERIFY_DOC_ENTRY = 'verify-doc'

export interface VerifyDocEntry {
  title: string
  markdown: string
  status: string
}

export function registerVerifyDocRenderer(pi: ExtensionAPI) {
  pi.registerEntryRenderer<VerifyDocEntry>(VERIFY_DOC_ENTRY, (entry, _options, theme) => {
    const data = entry.data
    if (!data) return undefined
    const header = new Text(
      `${theme.fg('accent', theme.bold(data.title))} ${theme.fg('dim', `(${data.status})`)}`,
      0,
      0,
    )
    const box = new Container()
    box.addChild(header)
    box.addChild(new Markdown(data.markdown, 1, 0, getMarkdownTheme()))
    return box
  })
}

function checkAgentRegistry(cwd: string): string | null {
  const registry = loadAgentRegistry(cwd)
  for (const name of VERIFY_AGENTS) {
    const def = registry.get(name)
    if (!def) return `agentType "${name}" is not registered. Expected agent/agents/${name}.md.`
    const denied = def.disallowedTools ?? []
    if (!denied.includes('edit') || !denied.includes('write')) {
      return `agentType "${name}" must deny both "edit" and "write" in disallowedTools.`
    }
  }
  return null
}

export default function (pi: ExtensionAPI, options: VerificationOptions = {}) {
  registerVerifyDocRenderer(pi)
  pi.registerCommand('verify', {
    description: 'Run three parallel read-only verification agents over a git scope and render a Verification Summary',
    handler: async (args, ctx: ExtensionContext) => {
      try {
        await handleVerify(pi, ctx, args, options)
      } catch (error) {
        ctx.ui.notify(`/verify: ${(error as Error).message}`, 'error')
      }
    },
  })
}

export interface RunVerificationOptions extends VerificationOptions {
  target?: string | undefined
}

export interface VerificationResult {
  scope: Scope
  markdown: string
  verdict: 'APPROVE' | 'REQUEST CHANGES'
}

export async function runVerification(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: RunVerificationOptions = {},
): Promise<VerificationResult | null> {
  const target = options.target?.trim() ?? ''

  const scope = resolveScope(ctx.cwd, target || undefined)

  if (scope.files.length === 0 && scope.wholeFiles.length === 0) return null

  if (isLarge(scope.stats)) {
    ctx.ui.notify(
      `Large scope: ${scope.stats.files} files, +${scope.stats.insertions}/-${scope.stats.deletions} changed lines`,
      'warning',
    )
  }

  const guardError = checkAgentRegistry(ctx.cwd)
  if (guardError) throw new Error(guardError)

  const reports = await runSdd<Reports>(ctx, VERIFY_SCRIPT, verifyArgs(scope), {
    label: 'verify',
    maxAgents: 3,
    run: options.run,
  })

  const markdown = renderSummary(scope, reports)
  const result: VerificationResult = { scope, markdown, verdict: computeVerdict(reports, mergeFindings(reports)) }
  pi.appendEntry<VerifyDocEntry>(VERIFY_DOC_ENTRY, {
    title: `Verify: ${target || '(default)'}`,
    markdown,
    status: result.verdict,
  })
  return result
}

async function handleVerify(pi: ExtensionAPI, ctx: ExtensionContext, args: string, options: VerificationOptions) {
  const target = args.trim()
  const result = await runVerification(pi, ctx, { ...options, target })
  if (!result) return void ctx.ui.notify('Nothing to verify: no changes found for this scope', 'info')
  pi.sendMessage({ customType: 'verify-report', content: result.markdown, display: false })
}

export { formatScope, resolveScope, isLarge }
