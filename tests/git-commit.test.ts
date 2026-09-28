import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, test } from 'vitest'

import register from '../agent/extensions/git-commit/index.ts'
import { COMMIT_TYPES, isPastTense, renderRules, validateSubject } from '../agent/extensions/git-commit/message.ts'
import {
  asMock,
  emptyPathDir,
  git,
  loadRegisteredTool,
  restrictPath,
  restorePathStubs,
  shellQuote,
  stubOnPath,
  toolResultText as resultText,
} from './helpers.ts'

const loadTool = () => loadRegisteredTool(register)

function ctx(cwd: string, confirm = true): ExtensionContext {
  return asMock<ExtensionContext>({
    cwd,
    hasUI: true,
    ui: { confirm: async () => confirm, notify: () => {} },
  })
}

afterEach(restorePathStubs)

function stubGit() {
  const realGit = which('git')
  const stub = stubOnPath('git', `exec ${shellQuote(realGit)} "$@"`)
  return {
    ...stub,
    pushes: () => stub.calls().filter((call) => call.startsWith('push')),
  }
}

function which(bin: string): string {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`cannot find ${bin} on PATH`)
}

function initRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'commit-'))
  git(cwd, ['init', '-b', 'main'])
  git(cwd, ['config', 'user.email', 't@t.com'])
  git(cwd, ['config', 'user.name', 't'])
  git(cwd, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(cwd, 'a.txt'), 'a\n')
  git(cwd, ['add', 'a.txt'])
  git(cwd, ['commit', '-m', 'init'])
  return cwd
}

function repoWithRemote(): string {
  const remote = mkdtempSync(join(tmpdir(), 'commit-remote-'))
  git(remote, ['init', '--bare'])
  const cwd = initRepo()
  git(cwd, ['remote', 'add', 'origin', remote])
  git(cwd, ['push', '-u', 'origin', 'main'])
  git(cwd, ['checkout', '-b', 'feature'])
  return cwd
}

function stage(cwd: string, name: string, content: string): void {
  writeFileSync(join(cwd, name), content)
  git(cwd, ['add', name])
}

test('registers the commit tool and carries the message rules in promptGuidelines', () => {
  const tool = loadTool()
  expect(tool.name).toBe('commit')
  expect(tool.promptSnippet).toBeTruthy()
  const guidelines = (tool.promptGuidelines ?? []).join('\n')
  expect(guidelines).toContain('feat, fix, chore or refactor')
  expect(guidelines).toContain('at most 72 characters')
  expect(guidelines).toContain('never stages files')
})

test('validateSubject accepts every allowed type', () => {
  for (const type of COMMIT_TYPES) {
    expect(validateSubject(`${type}: add a thing`)).toEqual([])
  }
})

test('validateSubject hints on out-of-set types, uppercase and past tense', () => {
  expect(validateSubject('update: add a thing').join('\n')).toMatch(/outside/)
  expect(validateSubject('feat: Add a thing').join('\n')).toMatch(/lowercase/)
  expect(validateSubject('feat: added a thing').join('\n')).toMatch(/present tense/)
  expect(validateSubject('add a thing').join('\n')).toMatch(/must match/)
})

test('validateSubject allows exactly 72 characters and flags more', () => {
  const prefix = 'feat: '
  const atLimit = prefix + 'x'.repeat(72 - prefix.length)
  expect(atLimit).toHaveLength(72)
  expect(validateSubject(atLimit)).toEqual([])
  const overLimit = prefix + 'x'.repeat(73 - prefix.length)
  expect(validateSubject(overLimit).join('\n')).toMatch(/72 characters/)
})

test('renderRules lists the subject, summary and body rules', () => {
  const rules = renderRules()
  expect(rules).toContain('feat, fix, chore or refactor')
  expect(rules).toContain('lowercase, present tense')
  expect(rules).toContain('Body: only when the reason')
})

test('message mode without a message returns the staged diff and the rules', async () => {
  const cwd = initRepo()
  stage(cwd, 'a.txt', 'a\nmore\n')
  const result = await loadTool().execute('id', {}, undefined, undefined, ctx(cwd))
  const text = resultText(result)
  expect(text).toContain('Staged diff:')
  expect(text).toContain('+more')
  expect(text).toContain('feat, fix, chore or refactor')
})

test('nothing staged reports the empty index plainly', async () => {
  const cwd = initRepo()
  const result = await loadTool().execute('id', {}, undefined, undefined, ctx(cwd))
  expect(resultText(result)).toBe(
    'Nothing is staged. Stage the files you want with git add, then call the commit tool again.',
  )
})

test('message mode commits the staged change and reports the new commit', async () => {
  const cwd = initRepo()
  stage(cwd, 'a.txt', 'a\nmore\n')
  const result = await loadTool().execute('id', { message: 'feat: add more' }, undefined, undefined, ctx(cwd))
  expect(resultText(result)).toContain('Committed:')
  expect(git(cwd, ['log', '-1', '--format=%s'])).toBe('feat: add more')
})

test('advisory hints do not block the commit', async () => {
  const cwd = initRepo()
  stage(cwd, 'a.txt', 'a\nmore\n')
  const result = await loadTool().execute('id', { message: 'update: Add more' }, undefined, undefined, ctx(cwd))
  const text = resultText(result)
  expect(text).toContain('Advisory hints')
  expect(text).toMatch(/outside/)
  expect(text).toMatch(/lowercase/)
  expect(git(cwd, ['log', '-1', '--format=%s'])).toBe('update: Add more')
})

test('message mode with nothing staged still reports the empty index', async () => {
  const cwd = initRepo()
  const result = await loadTool().execute('id', { message: 'feat: add more' }, undefined, undefined, ctx(cwd))
  expect(resultText(result)).toMatch(/Nothing is staged/)
  expect(git(cwd, ['log', '-1', '--format=%s'])).toBe('init')
})

test('a declined push leaves the commit local and never runs git push', async () => {
  const cwd = repoWithRemote()
  stage(cwd, 'b.txt', 'b\n')
  const stub = stubGit()
  const result = await loadTool().execute(
    'id',
    { message: 'feat: add b', push: true },
    undefined,
    undefined,
    ctx(cwd, false),
  )
  expect(resultText(result)).toMatch(/Push declined/)
  expect(git(cwd, ['rev-list', '--count', 'origin/main..HEAD'])).toBe('1')
  expect(stub.pushes()).toEqual([])
})

test('a confirmed push sends the commit to the remote', async () => {
  const cwd = repoWithRemote()
  stage(cwd, 'b.txt', 'b\n')
  const stub = stubGit()
  const result = await loadTool().execute(
    'id',
    { message: 'feat: add b', push: true },
    undefined,
    undefined,
    ctx(cwd, true),
  )
  expect(resultText(result)).toMatch(/Committed and pushed/)
  expect(stub.pushes().length).toBe(1)
  expect(git(cwd, ['rev-list', '--count', 'origin/feature..HEAD'])).toBe('0')
})

test('a headless push confirmation returns guidance and does not push', async () => {
  const cwd = repoWithRemote()
  stage(cwd, 'b.txt', 'b\n')
  const stub = stubGit()
  const headless = asMock<ExtensionContext>({ cwd, hasUI: false, ui: {} })
  const result = await loadTool().execute('id', { message: 'feat: add b', push: true }, undefined, undefined, headless)
  expect(resultText(result)).toMatch(/commit is local/)
  expect(stub.pushes()).toEqual([])
})

test('a rejected push surfaces the failure and keeps the commit local', async () => {
  const cwd = repoWithRemote()
  stage(cwd, 'b.txt', 'b\n')
  const realGit = which('git')
  stubOnPath(
    'git',
    `if [ "$1" = "push" ]; then printf '%s\\n' "rejected: non-fast-forward" >&2; exit 1; fi\nexec ${shellQuote(realGit)} "$@"`,
  )
  const result = await loadTool().execute(
    'id',
    { message: 'feat: add b', push: true },
    undefined,
    undefined,
    ctx(cwd, true),
  )
  expect(resultText(result)).toMatch(/git push failed with exit code 1/)
  expect(resultText(result)).toContain('rejected: non-fast-forward')
  expect(resultText(result)).toContain('The commit stays local.')
  expect(git(cwd, ['rev-list', '--count', 'origin/main..HEAD'])).toBe('1')
})

test('push with no remote leaves the commit local', async () => {
  const cwd = initRepo()
  stage(cwd, 'a.txt', 'a\nmore\n')
  const result = await loadTool().execute(
    'id',
    { message: 'feat: add more', push: true },
    undefined,
    undefined,
    ctx(cwd, true),
  )
  expect(resultText(result)).toMatch(/No git remote is configured/)
})

test('the staged diff ignores an external diff tool', async () => {
  const cwd = initRepo()
  git(cwd, ['config', 'diff.external', 'false'])
  stage(cwd, 'a.txt', 'a\nmore\n')
  const result = await loadTool().execute('id', {}, undefined, undefined, ctx(cwd))
  expect(resultText(result)).toContain('Staged diff:')
  expect(resultText(result)).toContain('+more')
})

test('a failing git commit surfaces the hook error and leaves HEAD unchanged', async () => {
  const cwd = initRepo()
  stage(cwd, 'a.txt', 'a\nmore\n')
  const hook = join(cwd, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\nprintf "%s\\n" "pre-commit says no" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  const before = git(cwd, ['rev-parse', 'HEAD'])
  const result = await loadTool().execute('id', { message: 'feat: add more' }, undefined, undefined, ctx(cwd))
  expect(resultText(result)).toMatch(/git commit failed with exit code/)
  expect(resultText(result)).toContain('pre-commit says no')
  expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(before)
})

test('a multi-line message keeps the subject hints and commits the body', async () => {
  const cwd = initRepo()
  stage(cwd, 'a.txt', 'a\nmore\n')
  const result = await loadTool().execute(
    'id',
    { message: 'feat: add more\n\nwhy it matters' },
    undefined,
    undefined,
    ctx(cwd),
  )
  expect(resultText(result)).toContain('Committed:')
  expect(git(cwd, ['log', '-1', '--format=%B'])).toBe('feat: add more\n\nwhy it matters')
})

test('commit reports a missing git binary', async () => {
  restrictPath(emptyPathDir())
  const result = await loadTool().execute('id', {}, undefined, undefined, ctx(tmpdir()))
  expect(resultText(result)).toMatch(/git \(not found on PATH\)/)
})

test('a message with shell metacharacters is committed verbatim', async () => {
  const cwd = initRepo()
  stage(cwd, 'a.txt', 'a\nmore\n')
  const marker = join(cwd, 'pwned')
  const message = `chore: add $(touch ${marker}) and \`touch ${marker}2\` ; rm`
  const result = await loadTool().execute('id', { message }, undefined, undefined, ctx(cwd))
  expect(resultText(result)).toContain('Committed:')
  expect(existsSync(marker)).toBe(false)
  expect(existsSync(`${marker}2`)).toBe(false)
  expect(git(cwd, ['log', '-1', '--format=%s'])).toBe(message.split('\n')[0])
})

test('the past-tense heuristic and its named-pipe false positive are explicit', () => {
  expect(isPastTense('moved the parser')).toBe(true)
  expect(isPastTense('named pipe support')).toBe(true)
  expect(isPastTense('move the parser')).toBe(false)
  expect(validateSubject('feat: moved the parser').join('\n')).toMatch(/present tense/)
})

test('subjects without a usable type return the format hint', () => {
  for (const subject of ['feat:', 'feat:   ', '   ']) {
    expect(validateSubject(subject).join('\n')).toMatch(/must match/)
  }
})

test('a staged diff larger than the output cap is truncated', async () => {
  const cwd = initRepo()
  const big = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join('\n')
  writeFileSync(join(cwd, 'big.txt'), `${big}\n`)
  git(cwd, ['add', 'big.txt'])
  const result = await loadTool().execute('id', {}, undefined, undefined, ctx(cwd))
  expect(resultText(result)).toContain('truncated; showing the last')
})

test('a non-repository cwd reports a bounded git diff failure', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'commit-nonrepo-'))
  const result = await loadTool().execute('id', {}, undefined, undefined, ctx(cwd))
  const text = resultText(result)
  expect(text).toMatch(/git diff --cached failed with exit code/)
  expect(text.length).toBeLessThan(4000)
})

test('commit resolves with error text when the signal is already aborted', async () => {
  const cwd = initRepo()
  stage(cwd, 'a.txt', 'a\nmore\n')
  const controller = new AbortController()
  controller.abort()
  const result = await loadTool().execute('id', {}, controller.signal, undefined, ctx(cwd))
  expect(resultText(result)).toMatch(/abort|failed with exit code/)
})

test('commit falls back to the message subject when git log fails', async () => {
  const cwd = initRepo()
  stage(cwd, 'a.txt', 'a\nmore\n')
  const realGit = which('git')
  stubOnPath('git', `if [ "$1" = "log" ]; then exit 1; fi\nexec ${shellQuote(realGit)} "$@"`)
  const result = await loadTool().execute('id', { message: 'feat: add more' }, undefined, undefined, ctx(cwd))
  expect(resultText(result)).toMatch(/Committed:\nfeat: add more/)
})

test('a failing rev-parse reports the branch as unknown in the push prompt', async () => {
  const cwd = repoWithRemote()
  stage(cwd, 'b.txt', 'b\n')
  const realGit = which('git')
  stubOnPath('git', `if [ "$1" = "rev-parse" ]; then exit 1; fi\nexec ${shellQuote(realGit)} "$@"`)
  let confirmMessage = ''
  const capturingCtx = asMock<ExtensionContext>({
    cwd,
    hasUI: true,
    ui: {
      confirm: async (_title: string, message: string) => {
        confirmMessage = message
        return false
      },
      notify: () => {},
    },
  })
  await loadTool().execute('id', { message: 'feat: add b', push: true }, undefined, undefined, capturingCtx)
  expect(confirmMessage).toContain('(unknown)')
})
