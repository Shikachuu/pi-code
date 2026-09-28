import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
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
  PR_CHECKS_FIELDS,
  PR_VIEW_FIELDS,
  prViewArgs,
  REPO_VIEW_FIELDS,
  repoViewArgs,
  summarizeChecks,
} from '../agent/extensions/git-gh/ghops.ts'
import register from '../agent/extensions/git-gh/index.ts'
import {
  asMock,
  emptyPathDir,
  git,
  loadRegisteredTool,
  must,
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

afterEach(restorePathStubs)

function stubGh(script: string) {
  return stubOnPath('gh', script)
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
  expect(wt.calls()).toContain('auth status')
})

test('auth falls back to the authenticated placeholder on empty output', async () => {
  stubGh('if [ "$1" = "auth" ]; then exit 0; fi\nexit 1')
  const result = await loadTool().execute('id', { operation: 'auth' }, undefined, undefined, readOnlyCtx(process.cwd()))
  expect(resultText(result)).toBe('gh is authenticated.')
})

test('an approved pr update passes the fields to gh pr edit', async () => {
  const gh = stubGh(
    `if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then printf '%s\\n' 'https://github.com/o/r/pull/12'; exit 0; fi\nexit 1`,
  )
  const result = await loadTool().execute(
    'id',
    { operation: 'pr update', target: '12', title: 'New title', body: 'New body' },
    undefined,
    undefined,
    ctx(process.cwd(), true),
  )
  expect(resultText(result)).toContain('https://github.com/o/r/pull/12')
  expect(gh.calls().join('\n')).toContain('pr edit 12 --title New title --body New body')
})

test('a failing pr edit surfaces the command stderr', async () => {
  stubGh('printf "%s\\n" "you do not have permission" >&2\nexit 1')
  const result = await loadTool().execute(
    'id',
    { operation: 'pr update', target: '12', title: 'x' },
    undefined,
    undefined,
    ctx(process.cwd(), true),
  )
  expect(resultText(result)).toContain('you do not have permission')
  expect(resultText(result)).toMatch(/gh pr edit failed with exit code 1/)
})

test('pr update needs a title or body and never calls gh', async () => {
  const gh = stubGh('exit 1')
  const result = await loadTool().execute(
    'id',
    { operation: 'pr update', target: '12' },
    undefined,
    undefined,
    ctx(process.cwd(), true),
  )
  expect(resultText(result)).toMatch(/needs a title or a body/)
  expect(gh.calls()).toEqual([])
})

test('pr create derives the title and body from local commits', async () => {
  const cwd = initRepo()
  const gh = stubGh(
    `if [ "$1" = "pr" ] && [ "$2" = "create" ]; then printf '%s\\n' 'https://github.com/o/r/pull/1'; exit 0; fi\nexit 1`,
  )
  const result = await loadTool().execute('id', { operation: 'pr create' }, undefined, undefined, ctx(cwd, true))
  expect(resultText(result)).toContain('https://github.com/o/r/pull/1')
  const log = gh.calls().join('\n')
  expect(log).toContain('--title add b')
  expect(log).toContain('## Summary')
  expect(log).toContain('## Commits')
})

test('pr create needs a base branch when neither main nor master exists', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gh-nobase-'))
  git(cwd, ['init', '-b', 'trunk'])
  const gh = stubGh('exit 1')
  const result = await loadTool().execute(
    'id',
    { operation: 'pr create', title: 'x', body: 'y' },
    undefined,
    undefined,
    ctx(cwd, true),
  )
  expect(resultText(result)).toMatch(/Could not find a base branch/)
  expect(gh.calls()).toEqual([])
})

test('pr create reports the URL even when gh exits non-zero', async () => {
  const cwd = initRepo()
  stubGh(
    `if [ "$1" = "pr" ] && [ "$2" = "create" ]; then printf '%s\\n' 'https://github.com/o/r/pull/5'; exit 1; fi\nexit 1`,
  )
  const result = await loadTool().execute(
    'id',
    { operation: 'pr create', title: 'x', body: 'y' },
    undefined,
    undefined,
    ctx(cwd, true),
  )
  expect(resultText(result)).toMatch(/Pull request created but gh exited 1/)
  expect(resultText(result)).toContain('https://github.com/o/r/pull/5')
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
  restrictPath(emptyPathDir())
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

test('pr checks reports a non-JSON failure with the exit code and stderr', async () => {
  stubGh('printf "%s\\n" "network error" >&2\nexit 1')
  const result = await loadTool().execute(
    'id',
    { operation: 'pr checks' },
    undefined,
    undefined,
    readOnlyCtx(process.cwd()),
  )
  expect(resultText(result)).toMatch(/gh pr checks failed with exit code 1/)
  expect(resultText(result)).toContain('network error')
})

test('unparseable repo view and pr view output is reported', async () => {
  stubGh(`if [ "$1" = "repo" ]; then printf '%s' 'not-json'; exit 0; fi\nexit 1`)
  const repo = await loadTool().execute(
    'id',
    { operation: 'repo view' },
    undefined,
    undefined,
    readOnlyCtx(process.cwd()),
  )
  expect(resultText(repo)).toMatch(/could not parse/)
  const gh = stubGh(`if [ "$1" = "pr" ]; then printf '%s' 'not-json'; exit 0; fi\nexit 1`)
  const pr = await loadTool().execute('id', { operation: 'pr view' }, undefined, undefined, readOnlyCtx(process.cwd()))
  expect(resultText(pr)).toMatch(/could not parse/)
  expect(gh.calls().length).toBeGreaterThan(0)
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
  expect(must(parseRepoView(JSON.stringify({ defaultBranchRef: 'main' })), 'repo').defaultBranch).toBeUndefined()
  expect(parseRepoView('nope')).toBeUndefined()
  expect(findPrUrl('created https://github.com/o/r/pull/7\n')).toBe('https://github.com/o/r/pull/7')
  expect(findPrUrl('nothing')).toBeUndefined()
})

test('git log output round-trips through gitLogArgs and parseCommits', () => {
  const cwd = initRepo()
  writeFileSync(join(cwd, 'c.txt'), 'c\n')
  git(cwd, ['add', 'c.txt'])
  git(cwd, ['commit', '-m', 'add c', '-m', 'why c'])
  const commits = parseCommits(git(cwd, gitLogArgs('main')))
  expect(commits[0]).toEqual({ subject: 'add c', body: 'why c' })
  expect(commits).toHaveLength(2)
})

test('arg builders pin the exact JSON field lists', () => {
  expect(authArgs(true)).toEqual(['auth', 'status', '--json', 'hosts'])
  expect(prViewArgs('12')).toEqual(['pr', 'view', '12', '--json', PR_VIEW_FIELDS.join(',')])
  expect(prChecksArgs(undefined)).toEqual(['pr', 'checks', '--json', PR_CHECKS_FIELDS.join(',')])
  expect(repoViewArgs()).toEqual(['repo', 'view', '--json', REPO_VIEW_FIELDS.join(',')])
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
  expect(gitLogArgs('main')).toContain('main..HEAD')
  expect(gitLogArgs('main')).toContain('-n')
})
