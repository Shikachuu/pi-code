import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { run, truncateOutput } from '../lib/exec.ts'
import { COMMIT_GUIDELINES, renderRules, validateSubject } from './message.ts'

const Params = Type.Object({
  message: Type.Optional(
    Type.String({ description: 'Commit message: a `<type>: <summary>` subject and an optional body' }),
  ),
  push: Type.Optional(Type.Boolean({ description: 'After committing, ask to push the current branch to its remote' })),
})

const NOTHING_STAGED = 'Nothing is staged. Stage the files you want with git add, then call the commit tool again.'

type Staged = { ok: true; hasChanges: boolean; text: string } | { ok: false; error: string }

async function readStaged(cwd: string, signal: AbortSignal | undefined): Promise<Staged> {
  const result = await run('git', ['diff', '--cached', '--no-ext-diff'], { cwd, signal })
  if (result.missing) return { ok: false, error: `git (not found on PATH): ${result.stderr.trim()}` }
  if (!result.ok) {
    return {
      ok: false,
      error: `git diff --cached failed with exit code ${result.code}: ${truncateOutput(result.stderr.trim() || result.stdout.trim(), 20)}`,
    }
  }
  return { ok: true, hasChanges: result.stdout.trim().length > 0, text: result.stdout }
}

// Message mode only needs to know whether anything is staged, so list names
// instead of materialising a potentially large diff.
async function hasStaged(cwd: string, signal: AbortSignal | undefined): Promise<Staged> {
  const result = await run('git', ['diff', '--cached', '--name-only', '--no-ext-diff'], { cwd, signal })
  if (result.missing) return { ok: false, error: `git (not found on PATH): ${result.stderr.trim()}` }
  if (!result.ok) {
    return {
      ok: false,
      error: `git diff --cached failed with exit code ${result.code}: ${truncateOutput(result.stderr.trim() || result.stdout.trim(), 20)}`,
    }
  }
  return { ok: true, hasChanges: result.stdout.trim().length > 0, text: '' }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'commit',
    label: 'Commit',
    description:
      'Read the staged diff and return the commit message rules, or commit the staged changes with a message. Optionally ask to push after committing. The tool never stages files.',
    promptSnippet: 'Read the staged diff and commit it with a conventional commit message',
    promptGuidelines: COMMIT_GUIDELINES,
    parameters: Params,

    async execute(_id, params, signal, _onUpdate, ctx) {
      const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: {} })
      const cwd = ctx.cwd

      if (!params.message) {
        const staged = await readStaged(cwd, signal)
        if (!staged.ok) return text(staged.error)
        if (!staged.hasChanges) return text(NOTHING_STAGED)
        return text(
          `Staged diff:\n\n${truncateOutput(staged.text.trimEnd())}\n\nCommit message rules:\n${renderRules()}\n\nCall the commit tool again with a message.`,
        )
      }

      const staged = await hasStaged(cwd, signal)
      if (!staged.ok) return text(staged.error)
      if (!staged.hasChanges) return text(NOTHING_STAGED)

      const hints = validateSubject(params.message)
      const result = await run('git', ['commit', '-m', params.message], { cwd, signal })
      if (result.missing) return text(`git (not found on PATH): ${result.stderr.trim()}`)
      if (!result.ok) {
        return text(
          `git commit failed with exit code ${result.code}: ${truncateOutput(result.stderr.trim() || result.stdout.trim(), 20)}`,
        )
      }

      const head = await run('git', ['log', '-1', '--format=%H%n%s'], { cwd, signal })
      const summary = head.ok ? head.stdout.trim() : (params.message.split('\n')[0] ?? params.message)
      const hintText = hints.length
        ? `\n\nAdvisory hints (not blocking):\n${hints.map((hint) => `- ${hint}`).join('\n')}`
        : ''

      if (!params.push) return text(`Committed:\n${summary}${hintText}`)

      const branchResult = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, signal })
      const branch = branchResult.ok ? branchResult.stdout.trim() : '(unknown)'
      const remoteResult = await run('git', ['remote'], { cwd, signal })
      const remote = remoteResult.ok ? (remoteResult.stdout.split('\n').find((line) => line.trim()) ?? '').trim() : ''
      if (!remote) {
        return text(`Committed:\n${summary}${hintText}\n\nNo git remote is configured, so nothing was pushed.`)
      }
      if (!ctx.hasUI) {
        return text(
          `Committed:\n${summary}${hintText}\n\nThe commit is local. Ask the user to run \`git push ${remote} ${branch}\`; this tool only pushes after an interactive confirmation.`,
        )
      }
      const confirmed = await ctx.ui.confirm('Push commit', `Push ${branch} to ${remote}?`)
      if (!confirmed) {
        return text(`Committed:\n${summary}${hintText}\n\nPush declined; the commit stays local.`)
      }
      const push = await run('git', ['push', '--set-upstream', remote, branch], { cwd, signal })
      if (push.missing) return text(`git (not found on PATH): ${push.stderr.trim()}`)
      if (!push.ok) {
        return text(
          `git push failed with exit code ${push.code}: ${truncateOutput(push.stderr.trim() || push.stdout.trim(), 20)}\n\nThe commit stays local.`,
        )
      }
      return text(`Committed and pushed ${branch} to ${remote}:\n${summary}${hintText}`)
    },
  })
}
