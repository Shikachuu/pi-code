import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { run, truncateOutput, type RunResult } from '../lib/exec.ts'
import {
  authArgs,
  buildPrBody,
  findPrUrl,
  formatPrView,
  formatRepoView,
  gitLogArgs,
  parseAuthHosts,
  parseChecks,
  parseCommits,
  parsePrView,
  parseRepoView,
  prChecksArgs,
  prCreateArgs,
  prEditArgs,
  prViewArgs,
  repoViewArgs,
  summarizeChecks,
} from './ghops.ts'

const Params = Type.Object({
  operation: Type.Union([
    Type.Literal('auth'),
    Type.Literal('repo view'),
    Type.Literal('pr view'),
    Type.Literal('pr checks'),
    Type.Literal('pr create'),
    Type.Literal('pr update'),
  ]),
  target: Type.Optional(Type.String({ description: 'Pull request number, URL or branch (pr view/checks/update)' })),
  title: Type.Optional(Type.String({ description: 'Pull request title (pr create/update)' })),
  body: Type.Optional(Type.String({ description: 'Pull request body (pr create/update)' })),
  base: Type.Optional(Type.String({ description: 'Base branch for the pull request (pr create)' })),
})

const NO_UI =
  'Error: no interactive UI; this operation writes to GitHub. Ask the user to run `gh` themselves, or retry when a UI is available.'

async function resolveBase(cwd: string, requested: string | undefined, signal: AbortSignal | undefined) {
  for (const candidate of requested ? [requested] : ['main', 'master']) {
    const local = await run('git', ['rev-parse', '--verify', candidate], { cwd, signal })
    if (local.ok) return candidate
    const remote = await run('git', ['rev-parse', '--verify', `refs/remotes/origin/${candidate}`], { cwd, signal })
    if (remote.ok) return candidate
  }
  return undefined
}

function ghFailure(command: string, result: RunResult): string {
  if (result.missing) return `gh (not found on PATH): ${result.stderr.trim()}`
  const detail = result.stderr.trim() || result.stdout.trim() || '(no output from gh)'
  return `${command} failed with exit code ${result.code}: ${detail}`
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'gh',
    label: 'GitHub',
    description:
      'Inspect GitHub with the gh CLI (auth status, repo view, pr view, pr checks) and manage the pull request lifecycle (pr create, pr update). Mutating operations ask for confirmation first and only run with an interactive UI.',
    promptSnippet:
      'Inspect GitHub and manage pull requests with the gh CLI (auth, repo view, pr view/checks/create/update)',
    promptGuidelines: [
      'Use the gh tool for GitHub and pull request work; git handles local commits and worktrees.',
      'Read-only operations (auth, repo view, pr view, pr checks) never prompt. pr create and pr update build the request, ask for confirmation, and only then call gh.',
      'pr create builds the body from local commits ahead of the base branch; pass title or body to override it.',
    ],
    parameters: Params,

    async execute(_id, params, signal, _onUpdate, ctx) {
      const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: {} })
      const cwd = ctx.cwd

      switch (params.operation) {
        case 'auth': {
          const json = await run('gh', authArgs(true), { cwd, signal })
          if (json.missing) return text(ghFailure('gh auth status', json))
          if (json.ok) {
            const lines = parseAuthHosts(json.stdout)
            if (lines && lines.length) return text(lines.join('\n'))
          }
          const human = await run('gh', authArgs(false), { cwd, signal })
          if (human.missing) return text(ghFailure('gh auth status', human))
          if (human.ok) return text(human.stdout.trim() || 'gh is authenticated.')
          return text(
            `gh is not authenticated:\n${human.stderr.trim() || human.stdout.trim() || '(no output from gh)'}`,
          )
        }

        case 'repo view': {
          const result = await run('gh', repoViewArgs(), { cwd, signal })
          if (!result.ok) return text(ghFailure('gh repo view', result))
          const repo = parseRepoView(result.stdout)
          if (!repo)
            return text(
              `gh repo view produced output this tool could not parse: ${truncateOutput(result.stdout.trim(), 20)}`,
            )
          return text(formatRepoView(repo))
        }

        case 'pr view': {
          const result = await run('gh', prViewArgs(params.target), { cwd, signal })
          if (!result.ok) return text(ghFailure('gh pr view', result))
          const pr = parsePrView(result.stdout)
          if (!pr)
            return text(
              `gh pr view produced output this tool could not parse: ${truncateOutput(result.stdout.trim(), 20)}`,
            )
          return text(formatPrView(pr))
        }

        case 'pr checks': {
          const result = await run('gh', prChecksArgs(params.target), { cwd, signal })
          const checks = parseChecks(result.stdout)
          // gh pr checks exits 8 while checks are pending, so parse stdout before judging the exit code.
          if (!checks) return text(ghFailure('gh pr checks', result))
          return text(summarizeChecks(checks))
        }

        case 'pr create': {
          if (!ctx.hasUI) return text(NO_UI)
          const base = await resolveBase(cwd, params.base, signal)
          if (!base) {
            const looked = params.base ? `"${params.base}"` : '(main or master)'
            return text(
              `Could not find base branch ${looked} as a local or origin ref. Create it or pass a valid base.`,
            )
          }
          const log = await run('git', gitLogArgs(base), { cwd, signal })
          if (log.missing) return text(`git (not found on PATH): ${log.stderr.trim()}`)
          if (!log.ok)
            return text(`git log failed with exit code ${log.code}: ${log.stderr.trim() || log.stdout.trim()}`)
          const commits = parseCommits(log.stdout)
          const title = params.title ?? commits.at(-1)?.subject
          if (!title) return text('pr create needs a title; no local commits ahead of the base were found.')
          const body = params.body ?? buildPrBody(commits)
          const confirmed = await ctx.ui.confirm('Create pull request', `Base: ${base}\nTitle: ${title}\n\n${body}`)
          if (!confirmed) {
            return text(`Pull request not created. Retry to confirm.\n\nBase: ${base}\nTitle: ${title}\n\n${body}`)
          }
          const result = await run('gh', prCreateArgs({ title, body, base }), { cwd, signal })
          const url = findPrUrl(result.stdout)
          if (result.ok)
            return text(url ? `Created pull request: ${url}` : result.stdout.trim() || 'Pull request created.')
          if (url) return text(`Pull request created but gh exited ${result.code}: ${url}\n${result.stderr.trim()}`)
          return text(ghFailure('gh pr create', result))
        }

        case 'pr update': {
          if (!ctx.hasUI) return text(NO_UI)
          if (params.title === undefined && params.body === undefined) {
            return text('pr update needs a title or a body to change.')
          }
          const fields = { title: params.title, body: params.body }
          const target = params.target
          const preview = [
            target ? `Pull request: ${target}` : 'Pull request: current branch',
            params.title !== undefined ? `Title: ${params.title}` : undefined,
            params.body !== undefined ? `Body:\n${params.body}` : undefined,
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n')
          const confirmed = await ctx.ui.confirm('Update pull request', preview)
          if (!confirmed) return text(`Pull request not updated. Retry to confirm.\n\n${preview}`)
          const result = await run('gh', prEditArgs(target, fields), { cwd, signal })
          if (!result.ok) return text(ghFailure('gh pr edit', result))
          return text(result.stdout.trim() || 'Pull request updated.')
        }
      }
    },
  })
}
