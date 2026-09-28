import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, test } from 'vitest'

import register from '../agent/extensions/git-worktree/index.ts'
import {
  describeChanges,
  existingWorktreeError,
  findByBranch,
  findCurrent,
  formatList,
  formatWorktree,
  isDirty,
  parseEnvelope,
  summarize,
} from '../agent/extensions/git-worktree/worktrees.ts'
import {
  asMock,
  emptyPathDir,
  loadRegisteredTool,
  must,
  restrictPath,
  restorePathStubs,
  shellQuote,
  stubOnPath,
  toolResultText as resultText,
} from './helpers.ts'

const loadTool = () => loadRegisteredTool(register)

function ctx(): ExtensionContext {
  return asMock<ExtensionContext>({
    cwd: tmpdir(),
    hasUI: true,
    ui: { confirm: async () => true, notify: () => {} },
  })
}

afterEach(restorePathStubs)

// Real `wt list --format=json` (schema 2) change flags are booleans with a diff count object.
const CLEAN_CHANGES = {
  staged: false,
  modified: false,
  untracked: false,
  renamed: false,
  deleted: false,
  conflicted: false,
  diff: { added: 0, deleted: 0 },
}

const DIRTY_CHANGES = {
  staged: false,
  modified: true,
  untracked: true,
  renamed: false,
  deleted: false,
  conflicted: false,
  diff: { added: 3, deleted: 1 },
}

const ENVELOPE = {
  schema: 2,
  items: [
    {
      branch: 'main',
      worktree: { path: '/repo/main', main: true, current: true, changes: CLEAN_CHANGES },
    },
    {
      branch: 'feature',
      marker: 'working',
      worktree: { path: '/wt/feature', current: false, changes: DIRTY_CHANGES },
    },
  ],
}

function stubList(json: unknown) {
  return stubOnPath('wt', `if [ "$1" = "list" ]; then printf '%s' ${shellQuote(JSON.stringify(json))}; fi\nexit 0`)
}

test('registers the worktree tool with a prompt snippet', () => {
  const tool = loadTool()
  expect(tool.name).toBe('worktree')
  expect(tool.promptSnippet).toBeTruthy()
  expect(tool.promptGuidelines?.length).toBeGreaterThan(0)
})

test('worktree list renders branch, path, dirty state and marker from real wt flags', async () => {
  stubList(ENVELOPE)
  const result = await loadTool().execute('id', { operation: 'list' }, undefined, undefined, ctx())
  const text = resultText(result)
  expect(text).toContain('main /repo/main [current, main] clean')
  expect(text).toContain('feature /wt/feature dirty (modified, untracked, +3/-1) marker: working')
})

test('worktree status selects the current worktree', async () => {
  stubList(ENVELOPE)
  const result = await loadTool().execute('id', { operation: 'status' }, undefined, undefined, ctx())
  expect(resultText(result)).toBe('main /repo/main [current, main] clean')
})

test('worktree status reports when no worktree is current', async () => {
  stubList({ schema: 2, items: [{ branch: 'main', worktree: { path: '/repo' } }] })
  const result = await loadTool().execute('id', { operation: 'status' }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/No current worktree/)
})

test('worktree create pre-checks for an existing worktree and does not switch', async () => {
  const wt = stubList(ENVELOPE)
  const result = await loadTool().execute('id', { operation: 'create', branch: 'feature' }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/already has a worktree/)
  expect(wt.calls().some((call) => call.includes('switch'))).toBe(false)
})

test('worktree create runs wt switch -c with --no-cd for a new branch', async () => {
  const wt = stubList({ schema: 2, items: [{ branch: 'main', worktree: { path: '/repo', current: true } }] })
  const result = await loadTool().execute(
    'id',
    { operation: 'create', branch: 'newbranch' },
    undefined,
    undefined,
    ctx(),
  )
  expect(wt.calls().some((call) => call === 'switch -c newbranch --no-cd')).toBe(true)
  expect(wt.callArgs()).toContainEqual(['switch', '-c', 'newbranch', '--no-cd'])
  expect(resultText(result)).toMatch(/Created branch newbranch/)
})

test('worktree create reports the created worktree from the follow-up list', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'wt-state-')), 'created')
  const base = { schema: 2, items: [{ branch: 'main', worktree: { path: '/repo', current: true } }] }
  const withNew = {
    schema: 2,
    items: [...base.items, { branch: 'newbranch', worktree: { path: '/wt/newbranch' } }],
  }
  stubOnPath(
    'wt',
    [
      `if [ "$1" = "switch" ]; then touch ${shellQuote(marker)}; exit 0; fi`,
      `if [ "$1" = "list" ]; then`,
      `  if [ -f ${shellQuote(marker)} ]; then printf '%s' ${shellQuote(JSON.stringify(withNew))}; else printf '%s' ${shellQuote(JSON.stringify(base))}; fi`,
      'fi',
      'exit 0',
    ].join('\n'),
  )
  const result = await loadTool().execute(
    'id',
    { operation: 'create', branch: 'newbranch' },
    undefined,
    undefined,
    ctx(),
  )
  expect(resultText(result)).toBe('Created newbranch /wt/newbranch clean')
})

test('worktree create surfaces a wt switch failure and skips the follow-up list', async () => {
  const wt = stubOnPath(
    'wt',
    [
      `if [ "$1" = "list" ]; then printf '%s' ${shellQuote(JSON.stringify({ schema: 2, items: [{ branch: 'main', worktree: { current: true } }] }))}; exit 0; fi`,
      `if [ "$1" = "switch" ]; then printf '%s\\n' "branch already exists" >&2; exit 2; fi`,
      'exit 0',
    ].join('\n'),
  )
  const result = await loadTool().execute('id', { operation: 'create', branch: 'x' }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/failed with exit code 2/)
  expect(resultText(result)).toContain('branch already exists')
  expect(wt.calls().filter((call) => call.startsWith('list'))).toHaveLength(1)
})

test('worktree switch surfaces a wt switch failure', async () => {
  const wt = stubOnPath(
    'wt',
    `if [ "$1" = "switch" ]; then printf '%s\\n' "no branch named nope" >&2; exit 4; fi\nexit 0`,
  )
  const result = await loadTool().execute('id', { operation: 'switch', branch: 'nope' }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/failed with exit code 4/)
  expect(resultText(result)).toContain('no branch named nope')
  expect(wt.calls().some((call) => call.startsWith('list'))).toBe(false)
})

test('worktree remove surfaces a wt remove failure', async () => {
  const wt = stubOnPath(
    'wt',
    [
      `if [ "$1" = "list" ]; then printf '%s' ${shellQuote(JSON.stringify({ schema: 2, items: [{ branch: 'feature', worktree: { path: '/wt/feature', current: true } }] }))}; exit 0; fi`,
      `if [ "$1" = "remove" ]; then printf '%s\\n' "worktree is dirty" >&2; exit 5; fi`,
      'exit 0',
    ].join('\n'),
  )
  const result = await loadTool().execute('id', { operation: 'remove', branch: 'feature' }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/failed with exit code 5/)
  expect(resultText(result)).toContain('worktree is dirty')
  expect(wt.calls().filter((call) => call.startsWith('remove'))).toHaveLength(1)
})

test('worktree resolves with error text when the signal is already aborted', async () => {
  stubList(ENVELOPE)
  const controller = new AbortController()
  controller.abort()
  const result = await loadTool().execute('id', { operation: 'list' }, controller.signal, undefined, ctx())
  expect(resultText(result)).toMatch(/aborted/i)
})

test('worktree create and switch require a branch and never call wt', async () => {
  const wt = stubList(ENVELOPE)
  const create = await loadTool().execute('id', { operation: 'create' }, undefined, undefined, ctx())
  const swap = await loadTool().execute('id', { operation: 'switch', branch: '   ' }, undefined, undefined, ctx())
  expect(resultText(create)).toMatch(/create requires a branch name/)
  expect(resultText(swap)).toMatch(/switch requires a branch name/)
  expect(wt.calls()).toEqual([])
})

test('worktree remove maps force and keepBranch to wt flags and runs in the foreground', async () => {
  const wt = stubList({
    schema: 2,
    items: [{ branch: 'feature', worktree: { path: '/wt/feature', current: true, changes: DIRTY_CHANGES } }],
  })
  await loadTool().execute('id', { operation: 'remove', force: true }, undefined, undefined, ctx())
  expect(wt.callArgs()).toContainEqual(['remove', 'feature', '-f', '--foreground'])

  const wt2 = stubList({
    schema: 2,
    items: [{ branch: 'feature', worktree: { path: '/wt/feature', current: true, changes: DIRTY_CHANGES } }],
  })
  await loadTool().execute('id', { operation: 'remove', force: true, keepBranch: true }, undefined, undefined, ctx())
  expect(wt2.callArgs()).toContainEqual(['remove', 'feature', '-f', '--no-delete-branch', '--foreground'])
})

test('worktree remove reports the removed worktree when the follow-up list drops it', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'wt-remove-')), 'removed')
  const before = { schema: 2, items: [{ branch: 'feature', worktree: { path: '/wt/feature', current: true } }] }
  stubOnPath(
    'wt',
    [
      `if [ "$1" = "remove" ]; then touch ${shellQuote(marker)}; exit 0; fi`,
      `if [ "$1" = "list" ]; then`,
      `  if [ -f ${shellQuote(marker)} ]; then printf '%s' ${shellQuote(JSON.stringify({ schema: 2, items: [] }))}; else printf '%s' ${shellQuote(JSON.stringify(before))}; fi`,
      'fi',
      'exit 0',
    ].join('\n'),
  )
  const result = await loadTool().execute('id', { operation: 'remove', branch: 'feature' }, undefined, undefined, ctx())
  expect(resultText(result)).toBe('Removed the worktree for feature.')
})

test('worktree remove reports the fallback when the follow-up list still has the branch', async () => {
  const wt = stubList({
    schema: 2,
    items: [{ branch: 'feature', worktree: { path: '/wt/feature', current: true } }],
  })
  const result = await loadTool().execute('id', { operation: 'remove', branch: 'feature' }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/run operation "list" to see the current state/)
  expect(wt.calls().filter((call) => call.startsWith('list'))).toHaveLength(2)
})

test('a declined worktree remove never runs wt remove', async () => {
  const wt = stubList({
    schema: 2,
    items: [{ branch: 'feature', worktree: { path: '/wt/feature', current: true } }],
  })
  const declined = asMock<ExtensionContext>({
    cwd: tmpdir(),
    hasUI: true,
    ui: { confirm: async () => false, notify: () => {} },
  })
  const result = await loadTool().execute(
    'id',
    { operation: 'remove', branch: 'feature' },
    undefined,
    undefined,
    declined,
  )
  expect(resultText(result)).toMatch(/declined/)
  expect(wt.calls().some((call) => call.startsWith('remove'))).toBe(false)
})

test('worktree refuses to remove the worktree it is running in even when forced', async () => {
  const wt = stubList({
    schema: 2,
    items: [{ branch: 'feature', worktree: { path: tmpdir(), current: true } }],
  })
  const result = await loadTool().execute('id', { operation: 'remove', force: true }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/Refusing to remove/)
  expect(wt.calls().some((call) => call.startsWith('remove'))).toBe(false)
})

test('worktree refuses to remove the worktree when cwd is a subdirectory of it', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'wt-cwd-'))
  const nested = join(worktree, 'nested', 'deeper')
  mkdirSync(nested, { recursive: true })
  const wt = stubList({ schema: 2, items: [{ branch: 'feature', worktree: { path: worktree, current: true } }] })
  const nestedCtx = asMock<ExtensionContext>({
    cwd: nested,
    hasUI: true,
    ui: { confirm: async () => true, notify: () => {} },
  })
  const result = await loadTool().execute('id', { operation: 'remove' }, undefined, undefined, nestedCtx)
  expect(resultText(result)).toMatch(/Refusing to remove/)
  expect(wt.calls().some((call) => call.startsWith('remove'))).toBe(false)
})

test('worktree remove refuses without a UI and never runs wt remove', async () => {
  const wt = stubList({
    schema: 2,
    items: [{ branch: 'feature', worktree: { path: '/wt/feature', current: true } }],
  })
  const headless = asMock<ExtensionContext>({ cwd: tmpdir(), hasUI: false, ui: {} })
  const result = await loadTool().execute(
    'id',
    { operation: 'remove', branch: 'feature' },
    undefined,
    undefined,
    headless,
  )
  expect(resultText(result)).toMatch(/no interactive UI/)
  expect(wt.calls().some((call) => call.startsWith('remove'))).toBe(false)
})

test('worktree remove needs a branch when no worktree is current', async () => {
  const wt = stubList({ schema: 2, items: [{ branch: 'main', worktree: { path: '/repo' } }] })
  const result = await loadTool().execute('id', { operation: 'remove' }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/needs a branch/)
  expect(wt.calls().some((call) => call.startsWith('remove'))).toBe(false)
})

test('worktree switch uses --no-cd so the agent never changes directory', async () => {
  const wt = stubList(ENVELOPE)
  await loadTool().execute('id', { operation: 'switch', branch: 'feature' }, undefined, undefined, ctx())
  expect(wt.calls().some((call) => call === 'switch feature --no-cd')).toBe(true)
  expect(wt.callArgs()).toContainEqual(['switch', 'feature', '--no-cd'])
})

test('worktree surfaces the command stderr verbatim', async () => {
  stubOnPath('wt', 'printf "%s\\n" "boom: not a worktree" >&2\nexit 3')
  const result = await loadTool().execute('id', { operation: 'list' }, undefined, undefined, ctx())
  expect(resultText(result)).toContain('boom: not a worktree')
})

test('worktree reports a missing wt binary', async () => {
  restrictPath(emptyPathDir())
  const result = await loadTool().execute('id', { operation: 'list' }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/wt \(not found on PATH\)/)
})

test('worktree reports unparseable wt output', async () => {
  stubOnPath('wt', `if [ "$1" = "list" ]; then printf '%s' 'not-json'; fi\nexit 0`)
  const result = await loadTool().execute('id', { operation: 'list' }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/could not parse/)
})

test('parseEnvelope reads the schema-2 envelope and summarizes dirty state', () => {
  const envelope = must(parseEnvelope(JSON.stringify(ENVELOPE)), 'envelope')
  expect(envelope.schema).toBe(2)
  expect(envelope.items).toHaveLength(2)
  const feature = must(findByBranch(envelope, 'feature'), 'feature')
  expect(feature.dirty).toBe(true)
  expect(feature.marker).toBe('working')
  expect(feature.current).toBe(false)
  expect(findCurrent(envelope)?.branch).toBe('main')
  expect(describeChanges(summarize(envelope.items[0] ?? {}).changes)).toBe('clean')
  expect(isDirty({ modified: true })).toBe(true)
  expect(isDirty({ modified: false })).toBe(false)
  expect(formatList(envelope)).toContain('feature /wt/feature')
  expect(formatWorktree(feature)).toContain('marker: working')
})

test('parseEnvelope also accepts the numeric schema-1 change counts', () => {
  const envelope = must(
    parseEnvelope(JSON.stringify({ items: [{ branch: 'n', worktree: { changes: { modified: 2, untracked: 1 } } }] })),
    'envelope',
  )
  expect(envelope.schema).toBeUndefined()
  const summary = summarize(must(envelope.items[0], 'item'))
  expect(summary.dirty).toBe(true)
  expect(describeChanges(summary.changes)).toBe('dirty (modified, untracked)')
})

test('parseEnvelope drops junk items and handles an empty list', () => {
  const envelope = must(parseEnvelope('{"schema":2,"items":[1,"x",null,{"branch":"b"}]}'), 'envelope')
  expect(envelope.items).toHaveLength(1)
  expect(formatList(envelope)).toContain('b')
  expect(formatList(must(parseEnvelope('{"items":[]}'), 'empty'))).toBe('No worktrees found.')
  expect(parseEnvelope('nope')).toBeUndefined()
  expect(parseEnvelope('"string"')).toBeUndefined()
})

test('summarize falls back to placeholders for a detached worktree', () => {
  const summary = summarize({})
  expect(summary.branch).toBe('(detached)')
  expect(summary.path).toBe('(unknown)')
  expect(summary.dirty).toBe(false)
})

test('parseEnvelope drops wrong-typed change values and non-array items', () => {
  const envelope = must(
    parseEnvelope(
      JSON.stringify({ items: [{ branch: 'x', worktree: { changes: { staged: 'yes', diff: { added: '3' } } } }] }),
    ),
    'envelope',
  )
  expect(summarize(must(envelope.items[0], 'item')).changes).toEqual({ diff: {} })
  expect(formatList(must(parseEnvelope('{"items":"x"}'), 'non-array'))).toBe('No worktrees found.')
})

test('isDirty and describeChanges handle zero and diff-only changes', () => {
  expect(isDirty({ modified: 0 })).toBe(false)
  expect(describeChanges({ modified: 0 })).toBe('clean')
  const flagsOff = {
    staged: false,
    modified: false,
    untracked: false,
    renamed: false,
    deleted: false,
    conflicted: false,
  }
  expect(isDirty({ ...flagsOff, diff: { added: 12, deleted: 0 } })).toBe(true)
  expect(describeChanges({ ...flagsOff, diff: { added: 12, deleted: 0 } })).toBe('dirty (+12/-0)')
})

test('worktree switch reports partial success when the follow-up list fails', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'wt-partial-')), 'switched')
  const base = { schema: 2, items: [{ branch: 'main', worktree: { path: '/repo', current: true } }] }
  stubOnPath(
    'wt',
    [
      `if [ "$1" = "switch" ]; then touch ${shellQuote(marker)}; exit 0; fi`,
      `if [ "$1" = "list" ]; then`,
      `  if [ -f ${shellQuote(marker)} ]; then printf '%s\\n' "list is down" >&2; exit 3; fi`,
      `  printf '%s' ${shellQuote(JSON.stringify(base))}`,
      `  exit 0`,
      'fi',
      'exit 0',
    ].join('\n'),
  )
  const result = await loadTool().execute('id', { operation: 'switch', branch: 'feature' }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/Switched to feature\. wt list failed with exit code 3/)
  expect(resultText(result)).toContain('list is down')
})

test('worktree create reports partial success when the follow-up list fails', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'wt-partial-')), 'created')
  const base = { schema: 2, items: [{ branch: 'main', worktree: { path: '/repo', current: true } }] }
  stubOnPath(
    'wt',
    [
      `if [ "$1" = "switch" ]; then touch ${shellQuote(marker)}; exit 0; fi`,
      `if [ "$1" = "list" ]; then`,
      `  if [ -f ${shellQuote(marker)} ]; then printf '%s\\n' "list is down" >&2; exit 3; fi`,
      `  printf '%s' ${shellQuote(JSON.stringify(base))}`,
      `  exit 0`,
      'fi',
      'exit 0',
    ].join('\n'),
  )
  const result = await loadTool().execute(
    'id',
    { operation: 'create', branch: 'newbranch' },
    undefined,
    undefined,
    ctx(),
  )
  expect(resultText(result)).toMatch(/Created branch newbranch\. wt list failed with exit code 3/)
  expect(resultText(result)).toContain('list is down')
})

test('existingWorktreeError reports the existing path', () => {
  const envelope = must(parseEnvelope(JSON.stringify(ENVELOPE)), 'envelope')
  expect(existingWorktreeError(envelope, 'feature')).toMatch(/\/wt\/feature/)
  expect(existingWorktreeError(envelope, 'other')).toBeUndefined()
})
