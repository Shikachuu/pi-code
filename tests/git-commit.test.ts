import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, test } from 'vitest'

import register from '../agent/extensions/git-commit/index.ts'
import { COMMIT_TYPES, renderRules, validateSubject } from '../agent/extensions/git-commit/message.ts'
import { asMock, git, must } from './helpers.ts'

interface ToolResult {
  content: { type: string; text: string }[]
  details: unknown
}

interface Tool {
  name: string
  promptSnippet?: string
  promptGuidelines?: string[]
  execute(
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResult>
}

function loadTool(): Tool {
  let tool: Tool | undefined
  register(
    asMock<ExtensionAPI>({
      registerTool: (t: unknown) => {
        tool = asMock<Tool>(t)
      },
    }),
  )
  return must(tool, 'commit tool')
}

const resultText = (result: ToolResult): string => must(result.content[0], 'tool result content').text

function ctx(cwd: string, confirm = true): ExtensionContext {
  return asMock<ExtensionContext>({
    cwd,
    hasUI: true,
    ui: { confirm: async () => confirm, notify: () => {} },
  })
}

interface Stub {
  restore(): void
  calls(): string[]
  pushes(): string[]
}

const stubs: Stub[] = []
afterEach(() => {
  for (const stub of stubs.splice(0).reverse()) stub.restore()
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function stubGit(): Stub {
  const realGit = which('git')
  const dir = mkdtempSync(join(tmpdir(), 'stub-git-'))
  const logPath = join(dir, 'calls.log')
  const file = join(dir, 'git')
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(logPath)}\nprintf '%s\\n' "$1" >> ${shellQuote(join(dir, 'first.log'))}\nexec ${shellQuote(realGit)} "$@"\n`,
  )
  chmodSync(file, 0o755)
  const previous = process.env.PATH ?? ''
  process.env.PATH = `${dir}:${previous}`
  const read = (path: string): string[] => {
    try {
      return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  const stub: Stub = {
    restore: () => (process.env.PATH = previous),
    calls: () => read(logPath),
    pushes: () => read(join(dir, 'first.log')).filter((first) => first === 'push'),
  }
  stubs.push(stub)
  return stub
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
