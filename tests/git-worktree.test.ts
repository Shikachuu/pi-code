import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
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
import { asMock, must } from './helpers.ts'

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
  return must(tool, 'worktree tool')
}

const resultText = (result: ToolResult): string => must(result.content[0], 'tool result content').text

function ctx(): ExtensionContext {
  return asMock<ExtensionContext>({
    cwd: tmpdir(),
    hasUI: true,
    ui: { confirm: async () => true, notify: () => {} },
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

function restrictPath(dir: string): Stub {
  const previous = process.env.PATH ?? ''
  process.env.PATH = dir
  const stub: Stub = { restore: () => (process.env.PATH = previous), calls: () => [] }
  stubs.push(stub)
  return stub
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function stubBin(name: string, script: string): Stub {
  const dir = mkdtempSync(join(tmpdir(), `stub-${name}-`))
  const logPath = join(dir, 'calls.log')
  const file = join(dir, name)
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

const ENVELOPE = {
  schema: 2,
  items: [
    { branch: 'main', worktree: { path: '/repo/main', main: true, current: true } },
    {
      branch: 'feature',
      marker: 'working',
      worktree: { path: '/wt/feature', current: false, changes: { modified: 2, untracked: 1 } },
    },
  ],
}

function stubList(json: unknown): Stub {
  return stubBin('wt', `if [ "$1" = "list" ]; then printf '%s' ${shellQuote(JSON.stringify(json))}; fi\nexit 0`)
}

test('registers the worktree tool with a prompt snippet', () => {
  const tool = loadTool()
  expect(tool.name).toBe('worktree')
  expect(tool.promptSnippet).toBeTruthy()
  expect(tool.promptGuidelines?.length).toBeGreaterThan(0)
})

test('worktree list renders branch, path, dirty state and marker', async () => {
  stubList(ENVELOPE)
  const result = await loadTool().execute('id', { operation: 'list' }, undefined, undefined, ctx())
  const text = resultText(result)
  expect(text).toContain('main /repo/main [current, main] clean')
  expect(text).toContain('feature /wt/feature dirty (2 modified, 1 untracked) marker: working')
})

test('worktree status selects the current worktree', async () => {
  stubList(ENVELOPE)
  const result = await loadTool().execute('id', { operation: 'status' }, undefined, undefined, ctx())
  expect(resultText(result)).toBe('main /repo/main [current, main] clean')
})

test('worktree create pre-checks for an existing worktree and does not switch', async () => {
  const wt = stubList(ENVELOPE)
  const result = await loadTool().execute('id', { operation: 'create', branch: 'feature' }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/already has a worktree/)
  expect(wt.calls().some((call) => call.includes('switch'))).toBe(false)
})

test('worktree create runs wt switch -c for a new branch', async () => {
  const wt = stubList({ schema: 2, items: [{ branch: 'main', worktree: { path: '/repo', current: true } }] })
  const result = await loadTool().execute(
    'id',
    { operation: 'create', branch: 'newbranch' },
    undefined,
    undefined,
    ctx(),
  )
  expect(wt.calls().some((call) => call === 'switch -c newbranch')).toBe(true)
  expect(resultText(result)).toMatch(/Created branch newbranch/)
})

test('worktree remove maps force and keepBranch to wt flags and runs in the foreground', async () => {
  const wt = stubList({
    schema: 2,
    items: [{ branch: 'feature', worktree: { path: '/wt/feature', current: true, changes: { modified: 1 } } }],
  })
  await loadTool().execute('id', { operation: 'remove', force: true }, undefined, undefined, ctx())
  expect(wt.calls().some((call) => call === 'remove feature -f --foreground')).toBe(true)

  const wt2 = stubList({ schema: 2, items: [{ branch: 'feature', worktree: { path: '/wt/feature', current: true } }] })
  await loadTool().execute('id', { operation: 'remove', keepBranch: true }, undefined, undefined, ctx())
  expect(wt2.calls().some((call) => call === 'remove feature --no-delete-branch --foreground')).toBe(true)
})

test('worktree switch uses --no-cd so the agent never changes directory', async () => {
  const wt = stubList(ENVELOPE)
  await loadTool().execute('id', { operation: 'switch', branch: 'feature' }, undefined, undefined, ctx())
  expect(wt.calls().some((call) => call === 'switch feature --no-cd')).toBe(true)
})

test('worktree surfaces the command stderr verbatim', async () => {
  stubBin('wt', 'printf "%s\\n" "boom: not a worktree" >&2\nexit 3')
  const result = await loadTool().execute('id', { operation: 'list' }, undefined, undefined, ctx())
  expect(resultText(result)).toContain('boom: not a worktree')
})

test('worktree reports a missing wt binary', async () => {
  restrictPath(mkdtempSync(join(tmpdir(), 'empty-path-')))
  const result = await loadTool().execute('id', { operation: 'list' }, undefined, undefined, ctx())
  expect(resultText(result)).toMatch(/wt \(not found on PATH\)/)
})

test('worktree reports unparseable wt output', async () => {
  stubBin('wt', `if [ "$1" = "list" ]; then printf '%s' 'not-json'; fi\nexit 0`)
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
  expect(isDirty({ conflicted: 0 })).toBe(false)
  expect(formatList(envelope)).toContain('feature /wt/feature')
  expect(formatWorktree(feature)).toContain('marker: working')
})

test('parseEnvelope rejects invalid JSON and missing items', () => {
  expect(parseEnvelope('nope')).toBeUndefined()
  expect(parseEnvelope('"string"')).toBeUndefined()
  expect(must(parseEnvelope('{}'), 'empty').items).toEqual([])
})

test('existingWorktreeError reports the existing path', () => {
  const envelope = must(parseEnvelope(JSON.stringify(ENVELOPE)), 'envelope')
  expect(existingWorktreeError(envelope, 'feature')).toMatch(/\/wt\/feature/)
  expect(existingWorktreeError(envelope, 'other')).toBeUndefined()
})
