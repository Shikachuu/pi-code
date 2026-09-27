import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import { expect, test } from 'vitest'

import register, { isProtected } from '../agent/extensions/protected-paths/index.ts'
import { asMock, must } from './helpers.ts'

interface ToolCallStub {
  toolName: string
  input: Record<string, unknown>
}

type ToolCallHandler = (event: ToolCallStub, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>

test('blocks secrets, git internals and dependencies', () => {
  for (const path of [
    '.env',
    './.env',
    '/abs/repo/.env.local',
    '.git',
    '.git/config',
    '../x/.git/HEAD',
    'a/node_modules/x.js',
    'agent/auth.json',
  ]) {
    expect({ path, protected: isProtected(path) }).toEqual({ path, protected: true })
  }
})

test('allows ordinary files', () => {
  for (const path of ['src/env.ts', '.envrc', '.environment', 'foo.git/x', 'gitignore', 'README.md']) {
    expect({ path, protected: isProtected(path) }).toEqual({ path, protected: false })
  }
})

function load() {
  let handler: ToolCallHandler | undefined
  const commands: string[] = []
  const recorders = {
    on: (event: string, fn: unknown) => {
      if (event === 'tool_call') handler = asMock<ToolCallHandler>(fn)
    },
    registerCommand: (name: string) => {
      commands.push(name)
    },
  }
  register(asMock<ExtensionAPI>(recorders))
  const notified: string[] = []
  const ctx = (hasUI: boolean) =>
    asMock<ExtensionContext>({ hasUI, ui: { notify: (msg: string) => notified.push(msg) } })
  return { call: must(handler, 'tool_call handler'), commands, notified, ctx }
}

test('tool_call handler blocks write and edit on protected paths', async () => {
  const { call, commands, notified, ctx } = load()
  expect(commands).toEqual(['protected-paths'])

  const blocked = await call({ toolName: 'write', input: { path: '.env' } }, ctx(true))
  expect(blocked?.block).toBe(true)
  expect(blocked?.reason).toMatch(/\.env/)
  expect(notified.length).toBe(1)

  expect((await call({ toolName: 'edit', input: { path: '.git/config' } }, ctx(false)))?.block).toBe(true)
  expect(notified.length, 'no notify without UI').toBe(1)
})

test('tool_call handler ignores other tools, safe paths and missing paths', async () => {
  const { call, ctx } = load()
  expect(await call({ toolName: 'read', input: { path: '.env' } }, ctx(false))).toBeUndefined()
  expect(await call({ toolName: 'write', input: { path: 'README.md' } }, ctx(false))).toBeUndefined()
  expect(await call({ toolName: 'write', input: {} }, ctx(false))).toBeUndefined()
})
