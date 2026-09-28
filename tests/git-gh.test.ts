import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, test } from 'vitest'

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
} from '../agent/extensions/git-gh/ghops.ts'
import register from '../agent/extensions/git-gh/index.ts'
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
  return must(tool, 'gh tool')
}

const resultText = (result: ToolResult): string => must(result.content[0], 'tool result content').text

function ctx(cwd: string, confirm = true): ExtensionContext {
  return asMock<ExtensionContext>({
    cwd,
    hasUI: true,
    ui: { confirm: async () => confirm, notify: () => {} },
  })
}

function readOnlyCtx(cwd: string): ExtensionContext {
  return asMock<ExtensionContext>({
    cwd,
    hasUI: true,
    ui: {
      confirm: async () => {
        throw new Error('read-only operation prompted')
      },
      notify: () => {},
    },
  })
}

interface Stub {
  restore(): void
  calls(): string[]
}

const stubs: Stub[] = []
afterEach(() => {
  for (const stub of stubs.splice(0).reverse()) stub.restore()
})

function restrictPath(dir: string): void {
  const previous = process.env.PATH ?? ''
  process.env.PATH = dir
  stubs.push({ restore: () => (process.env.PATH = previous), calls: () => [] })
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function stubGh(script: string): Stub {
  const dir = mkdtempSync(join(tmpdir(), 'stub-gh-'))
  const logPath = join(dir, 'calls.log')
  const file = join(dir, 'gh')
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(logPath)}\n${script}\n`)
  chmodSync(file, 0o755)
  const previous = process.env.PATH ?? ''
  process.env.PATH = `${dir}:${previous}`
  const stub: Stub = {
    restore: () => (process.env.PATH = previous),
    calls: () => {
      try {
        return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
  }
  stubs.push(stub)
  return stub
}

function initRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'gh-'))
  git(cwd, ['init', '-b', 'main'])
  git(cwd, ['config', 'user.email', 't@t.com'])
  git(cwd, ['config', 'user.name', 't'])
  git(cwd, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(cwd, 'a.txt'), 'a\n')
  git(cwd, ['add', 'a.txt'])
  git(cwd, ['commit', '-m', 'init'])
  git(cwd, ['checkout', '-b', 'feature'])
  writeFileSync(join(cwd, 'b.txt'), 'b\n')
  git(cwd, ['add', 'b.txt'])
  git(cwd, ['commit', '-m', 'add b'])
  return cwd
}

const PR_JSON = {
  number: 12,
  title: 'Add gh tool',
  state: 'OPEN',
  url: 'https://github.com/o/r/pull/12',
  headRefName: 'feat/gh',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  reviewDecision: 'APPROVED',
  author: { login: 'octocat' },
}

test('registers the gh tool with a prompt snippet', () => {
  const tool = loadTool()
  expect(tool.name).toBe('gh')
  expect(tool.promptSnippet).toBeTruthy()
  expect(tool.promptGuidelines?.length).toBeGreaterThan(0)
})

test('pr view returns parsed output and never prompts', async () => {
  stubGh(
    `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf '%s' ${shellQuote(JSON.stringify(PR_JSON))}; exit 0; fi\nexit 1`,
  )
  const result = await loadTool().execute(
    'id',
    { operation: 'pr view' },
    undefined,
    undefined,
    readOnlyCtx(process.cwd()),
  )
  const text = resultText(result)
  expect(text).toContain('#12 Add gh tool [OPEN]')
  expect(text).toContain('feat/gh -> main')
  expect(text).toContain('author: octocat')
})

test('pr checks summarises buckets and tolerates the pending exit code', async () => {
  const checks = [
    { name: 'build', bucket: 'pass', state: 'SUCCESS' },
    { name: 'test', bucket: 'pending', state: 'IN_PROGRESS' },
    { name: 'lint', bucket: 'fail', state: 'FAILURE', description: '3 errors' },
  ]
  stubGh(
    `if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then printf '%s' ${shellQuote(JSON.stringify(checks))}; exit 8; fi\nexit 1`,
  )
  const result = await loadTool().execute(
    'id',
    { operation: 'pr checks' },
    undefined,
    undefined,
    readOnlyCtx(process.cwd()),
  )
  const text = resultText(result)
  expect(text).toContain('3 checks: 1 passing, 1 pending, 1 failing')
  expect(text).toContain('fail lint - 3 errors')
})

test('repo view returns parsed output', async () => {
  const repo = {
    nameWithOwner: 'o/r',
    description: 'repo desc',
    url: 'https://github.com/o/r',
    defaultBranchRef: { name: 'main' },
    isPrivate: true,
    viewerPermission: 'ADMIN',
    stargazerCount: 5,
  }
  stubGh(
    `if [ "$1" = "repo" ] && [ "$2" = "view" ]; then printf '%s' ${shellQuote(JSON.stringify(repo))}; exit 0; fi\nexit 1`,
  )
  const result = await loadTool().execute(
    'id',
    { operation: 'repo view' },
    undefined,
    undefined,
    readOnlyCtx(process.cwd()),
  )
  const text = resultText(result)
  expect(text).toContain('o/r')
  expect(text).toContain('default: main')
  expect(text).toContain('private')
})

test('auth reports hosts when logged in and stderr when logged out', async () => {
  const hosts = { hosts: { 'github.com': [{ state: 'success', active: true, login: 'octocat' }] } }
  stubGh(`if [ "$1" = "auth" ]; then printf '%s' ${shellQuote(JSON.stringify(hosts))}; exit 0; fi\nexit 1`)
  const loggedIn = await loadTool().execute(
    'id',
    { operation: 'auth' },
    undefined,
    undefined,
    readOnlyCtx(process.cwd()),
  )
  expect(resultText(loggedIn)).toContain('github.com: octocat success (active)')

  const wt = stubGh(
    [
      'if [ "$1" = "auth" ]; then',
      `  if [ "$3" = "--json" ]; then printf '%s' '{"hosts":{}}'; exit 0; fi`,
      '  printf "%s\\n" "You are not logged into any GitHub hosts." >&2',
      '  exit 1',
      'fi',
      'exit 1',
    ].join('\n'),
  )
  const loggedOut = await loadTool().execute(
    'id',
    { operation: 'auth' },
    undefined,
    undefined,
    readOnlyCtx(process.cwd()),
  )
  const text = resultText(loggedOut)
  expect(text).toMatch(/not authenticated/)
  expect(text).toContain('You are not logged into any GitHub hosts.')
  expect(wt.calls().length).toBeGreaterThan(0)
})

test('a declined pr create never executes the gh stub', async () => {
  const cwd = initRepo()
  const gh = stubGh('exit 1')
  const result = await loadTool().execute(
    'id',
    { operation: 'pr create', title: 'Add feature', body: 'body text' },
    undefined,
    undefined,
    ctx(cwd, false),
  )
  expect(resultText(result)).toMatch(/not created/i)
  expect(gh.calls()).toEqual([])
})

test('a declined pr update never executes the gh stub', async () => {
  const gh = stubGh('exit 1')
  const result = await loadTool().execute(
    'id',
    { operation: 'pr update', target: '12', title: 'New title' },
    undefined,
    undefined,
    ctx(process.cwd(), false),
  )
  expect(resultText(result)).toMatch(/not updated/i)
  expect(gh.calls()).toEqual([])
})

test('an approved pr create passes the generated draft to gh', async () => {
  const cwd = initRepo()
  const gh = stubGh(
    `if [ "$1" = "pr" ] && [ "$2" = "create" ]; then printf '%s\\n' 'https://github.com/o/r/pull/99'; exit 0; fi\nexit 1`,
  )
  const result = await loadTool().execute(
    'id',
    { operation: 'pr create', title: 'Add feature', body: 'body text' },
    undefined,
    undefined,
    ctx(cwd, true),
  )
  expect(resultText(result)).toContain('https://github.com/o/r/pull/99')
  const call = gh.calls().find((entry) => entry.startsWith('pr create'))
  expect(call).toContain('--title Add feature')
  expect(call).toContain('--body body text')
  expect(call).toContain('--base main')
})

test('a failing gh command surfaces its stderr verbatim', async () => {
  stubGh('printf "%s\\n" "no pull requests found for branch" >&2\nexit 1')
  const result = await loadTool().execute(
    'id',
    { operation: 'pr view' },
    undefined,
    undefined,
    readOnlyCtx(process.cwd()),
  )
  expect(resultText(result)).toContain('no pull requests found for branch')
})

test('a missing gh binary is reported clearly', async () => {
  restrictPath(mkdtempSync(join(tmpdir(), 'empty-path-')))
  const result = await loadTool().execute(
    'id',
    { operation: 'pr view' },
    undefined,
    undefined,
    readOnlyCtx(process.cwd()),
  )
  expect(resultText(result)).toMatch(/gh \(not found on PATH\)/)
})

test('mutating operations refuse without a UI and never call gh', async () => {
  const gh = stubGh('exit 1')
  const headless = asMock<ExtensionContext>({ cwd: process.cwd(), hasUI: false, ui: {} })
  const result = await loadTool().execute('id', { operation: 'pr update', title: 'x' }, undefined, undefined, headless)
  expect(resultText(result)).toMatch(/no interactive UI/)
  expect(gh.calls()).toEqual([])
})

test('parseCommits and buildPrBody keep subjects, bodies and a commit list', () => {
  const raw = `add b\n\nwhy b\x1eadd a\x1e`
  const commits = parseCommits(raw)
  expect(commits).toEqual([{ subject: 'add b', body: 'why b' }, { subject: 'add a' }])
  const body = buildPrBody(commits)
  expect(body).toContain('## Summary')
  expect(body).toContain('- add b')
  expect(body).toContain('why b')
  expect(body).toContain('## Commits')
  expect(buildPrBody([])).toBe('No local commits ahead of the base branch.')
})

test('summarizeChecks keys off bucket and state, not the exit code', () => {
  const checks = must(
    parseChecks(
      JSON.stringify([
        { name: 'a', bucket: 'pass' },
        { name: 'b', state: 'FAILURE' },
      ]),
    ),
    'checks',
  )
  expect(summarizeChecks(checks)).toContain('2 checks: 1 passing, 0 pending, 1 failing')
  expect(summarizeChecks([])).toMatch(/No checks/)
})

test('parseAuthHosts handles the hosts envelope and rejects junk', () => {
  expect(
    parseAuthHosts(JSON.stringify({ hosts: { 'github.com': [{ login: 'a', state: 'success', active: true }] } })),
  ).toEqual(['github.com: a success (active)'])
  expect(parseAuthHosts('nope')).toBeUndefined()
  expect(parseAuthHosts('{"hosts":{}}')).toEqual([])
})

test('pr view, repo view and URL helpers parse and format', () => {
  const pr = must(parsePrView(JSON.stringify(PR_JSON)), 'pr')
  expect(formatPrView(pr)).toContain('#12 Add gh tool')
  const repo = must(
    parseRepoView(JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' }, isPrivate: false })),
    'repo',
  )
  expect(formatRepoView(repo)).toContain('public')
  expect(findPrUrl('created https://github.com/o/r/pull/7\n')).toBe('https://github.com/o/r/pull/7')
  expect(findPrUrl('nothing')).toBeUndefined()
})

test('arg builders stay deterministic', () => {
  expect(authArgs(true)).toEqual(['auth', 'status', '--json', 'hosts'])
  expect(prViewArgs('12')).toEqual(['pr', 'view', '12', '--json', expect.any(String)])
  expect(prChecksArgs(undefined)).toEqual(['pr', 'checks', '--json', expect.any(String)])
  expect(repoViewArgs()).toEqual(['repo', 'view', '--json', expect.any(String)])
  expect(prCreateArgs({ title: 't', body: 'b', base: 'main' })).toEqual([
    'pr',
    'create',
    '--title',
    't',
    '--body',
    'b',
    '--base',
    'main',
  ])
  expect(prEditArgs('12', { title: 't' })).toEqual(['pr', 'edit', '12', '--title', 't'])
  expect(gitLogArgs('main')[2]).toBe('main..HEAD')
})
