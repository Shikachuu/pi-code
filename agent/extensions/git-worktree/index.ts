import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { run } from '../lib/exec.ts'
import {
  existingWorktreeError,
  findByBranch,
  findCurrent,
  formatList,
  formatWorktree,
  parseEnvelope,
  type WtEnvelope,
} from './worktrees.ts'

const Params = Type.Object({
  operation: Type.Union([
    Type.Literal('list'),
    Type.Literal('create'),
    Type.Literal('remove'),
    Type.Literal('status'),
    Type.Literal('switch'),
  ]),
  branch: Type.Optional(
    Type.String({ description: 'Branch to create, remove or switch to; remove defaults to the current worktree' }),
  ),
  force: Type.Optional(
    Type.Boolean({ description: 'Remove a worktree that has uncommitted changes (maps to wt remove -f)' }),
  ),
  keepBranch: Type.Optional(
    Type.Boolean({ description: 'Keep the branch after removing its worktree (maps to wt remove --no-delete-branch)' }),
  ),
})

type Loaded = { ok: true; envelope: WtEnvelope } | { ok: false; error: string }

async function loadWorktrees(cwd: string, signal: AbortSignal | undefined): Promise<Loaded> {
  const result = await run('wt', ['list', '--format=json'], { cwd, signal })
  if (result.missing) return { ok: false, error: `wt (not found on PATH): ${result.stderr.trim()}` }
  if (!result.ok) {
    return {
      ok: false,
      error: `wt list failed with exit code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
    }
  }
  const envelope = parseEnvelope(result.stdout)
  if (!envelope) {
    return {
      ok: false,
      error: `wt list produced output this tool could not parse: ${result.stdout.trim().slice(0, 200)}`,
    }
  }
  return { ok: true, envelope }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'worktree',
    label: 'Git worktree',
    description:
      'Manage git worktrees through Worktrunk (wt): list worktrees with branch, path, dirty state and any marker, create or switch to a branch worktree, remove one, or report the current worktree.',
    promptSnippet: 'Manage git worktrees through Worktrunk (wt): list, create, switch, remove, status',
    promptGuidelines: [
      'Use the worktree tool for every worktree operation; never call raw `git worktree`, because wt owns worktree layout and hooks.',
      'worktree create and switch do not change the agent working directory; pass the reported path as cwd when you need to run commands in that worktree.',
      'worktree remove refuses a dirty worktree unless force is true, and wt deletes the branch unless keepBranch is true.',
    ],
    parameters: Params,

    async execute(_id, params, signal, _onUpdate, ctx) {
      const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: {} })
      const cwd = ctx.cwd

      switch (params.operation) {
        case 'list': {
          const loaded = await loadWorktrees(cwd, signal)
          return text(loaded.ok ? formatList(loaded.envelope) : loaded.error)
        }

        case 'status': {
          const loaded = await loadWorktrees(cwd, signal)
          if (!loaded.ok) return text(loaded.error)
          const current = findCurrent(loaded.envelope)
          if (!current) return text('No current worktree found in the wt list output.')
          return text(formatWorktree(current))
        }

        case 'create': {
          const branch = params.branch?.trim()
          if (!branch) return text('worktree create requires a branch name.')
          const loaded = await loadWorktrees(cwd, signal)
          if (!loaded.ok) return text(loaded.error)
          const duplicate = existingWorktreeError(loaded.envelope, branch)
          if (duplicate) return text(duplicate)
          const result = await run('wt', ['switch', '-c', branch, '--no-cd'], { cwd, signal })
          if (result.missing) return text(`wt (not found on PATH): ${result.stderr.trim()}`)
          if (!result.ok) {
            return text(
              `wt switch -c ${branch} failed with exit code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
            )
          }
          const after = await loadWorktrees(cwd, signal)
          if (!after.ok) return text(`Created branch ${branch}. ${after.error}`)
          const created = findByBranch(after.envelope, branch)
          return text(
            created
              ? `Created ${formatWorktree(created)}`
              : `Created branch ${branch}. Run operation "list" to see its worktree.`,
          )
        }

        case 'switch': {
          const branch = params.branch?.trim()
          if (!branch) return text('worktree switch requires a branch name.')
          const result = await run('wt', ['switch', branch, '--no-cd'], { cwd, signal })
          if (result.missing) return text(`wt (not found on PATH): ${result.stderr.trim()}`)
          if (!result.ok) {
            return text(
              `wt switch ${branch} failed with exit code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
            )
          }
          const after = await loadWorktrees(cwd, signal)
          if (!after.ok) return text(`Switched to ${branch}. ${after.error}`)
          const selected = findByBranch(after.envelope, branch)
          return text(selected ? `Switched to ${formatWorktree(selected)}` : `Switched to branch ${branch}.`)
        }

        case 'remove': {
          const loaded = await loadWorktrees(cwd, signal)
          if (!loaded.ok) return text(loaded.error)
          const branch = params.branch?.trim() || findCurrent(loaded.envelope)?.branch
          if (!branch) return text('worktree remove needs a branch when there is no current worktree.')
          const args = ['remove', branch]
          if (params.force) args.push('-f')
          if (params.keepBranch) args.push('--no-delete-branch')
          args.push('--foreground')
          const result = await run('wt', args, { cwd, signal })
          if (result.missing) return text(`wt (not found on PATH): ${result.stderr.trim()}`)
          if (!result.ok) {
            return text(
              `wt remove ${branch} failed with exit code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
            )
          }
          const after = await loadWorktrees(cwd, signal)
          const removed = after.ok && !findByBranch(after.envelope, branch)
          return text(
            removed
              ? `Removed the worktree for ${branch}.`
              : `wt removed the worktree for ${branch}; run operation "list" to see the current state.`,
          )
        }
      }
    },
  })
}
