import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { expect } from 'vitest'

import type { Reports } from '../agent/extensions/verification/report.ts'

export const REPO = resolve(import.meta.dirname, '..')
export const AGENT_DIR = join(REPO, 'agent')

// Pi reads ~/.agents/skills and walks context files from / to cwd, so tests pin both
// to empty temp dirs to see only what agent/ provides.
export function isolate(): { home: string; cwd: string; restore(): void } {
  const root = mkdtempSync(join(tmpdir(), 'pi-harness-'))
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(home)
  mkdirSync(cwd)
  const previous = { home: process.env.HOME, offline: process.env.PI_OFFLINE }
  process.env.HOME = home
  process.env.PI_OFFLINE = '1'
  const restore = () => {
    for (const [key, value] of [
      ['HOME', previous.home],
      ['PI_OFFLINE', previous.offline],
    ] as [string, string | undefined][]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  return { home, cwd, restore }
}

export function normalize(text: string, cwd: string): string {
  return text.replaceAll(cwd, '<CWD>').replaceAll(REPO, '<REPO>')
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`)
  return value
}

export function asMock<T>(value: unknown): T {
  return value as unknown as T
}

export interface ToolResult {
  content: { type: string; text: string }[]
  details: unknown
}

export interface RegisteredTool {
  name: string
  promptSnippet?: string
  promptGuidelines?: string[]
  execute(
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResult>
}

export function loadRegisteredTool(register: (pi: ExtensionAPI) => void): RegisteredTool {
  let tool: RegisteredTool | undefined
  register(
    asMock<ExtensionAPI>({
      registerTool: (t: unknown) => {
        tool = asMock<RegisteredTool>(t)
      },
    }),
  )
  return must(tool, 'registered tool')
}

export function toolResultText(result: ToolResult): string {
  return must(result.content[0], 'tool result content').text
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export interface Stub {
  restore(): void
  calls(): string[]
}

export interface StubOnPath extends Stub {
  dir: string
  logPath: string
  callArgs(): string[][]
}

const pathStubs: Stub[] = []

const ARG_FIELD_SEPARATOR = '\x1e'
const CALL_SEPARATOR = '\0'

function readCallArgs(path: string): string[][] {
  try {
    return readFileSync(path, 'utf8')
      .split(CALL_SEPARATOR)
      .filter((record) => record.length > 0)
      .map((record) => {
        const parts = record.split(ARG_FIELD_SEPARATOR)
        if (parts[parts.length - 1] === '') parts.pop()
        return parts
      })
  } catch {
    return []
  }
}

export function stubOnPath(name: string, script: string): StubOnPath {
  const dir = mkdtempSync(join(tmpdir(), `stub-${name}-`))
  const logPath = join(dir, 'calls.log')
  const file = join(dir, name)
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s${ARG_FIELD_SEPARATOR}' "$@" >> ${shellQuote(logPath)}\nprintf '\\000' >> ${shellQuote(logPath)}\n${script}\n`,
  )
  chmodSync(file, 0o755)
  const previous = process.env.PATH ?? ''
  process.env.PATH = `${dir}:${previous}`
  const stub: StubOnPath = {
    dir,
    logPath,
    restore: () => {
      process.env.PATH = previous
    },
    callArgs: () => readCallArgs(logPath),
    calls: () => readCallArgs(logPath).map((args) => args.join(' ')),
  }
  pathStubs.push(stub)
  return stub
}

export function restrictPath(dir: string): void {
  const previous = process.env.PATH ?? ''
  process.env.PATH = dir
  pathStubs.push({
    restore: () => {
      process.env.PATH = previous
    },
    calls: () => [],
  })
}

export function emptyPathDir(): string {
  return mkdtempSync(join(tmpdir(), 'empty-path-'))
}

export function which(bin: string): string {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`cannot find ${bin} on PATH`)
}

export function restorePathStubs(): void {
  for (const stub of pathStubs.splice(0).reverse()) stub.restore()
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
}

export function matchSnapshot(name: string, actual: string): void {
  const path = join(REPO, 'tests', 'snapshots', name)
  if (process.env.UPDATE_SNAPSHOTS) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, actual)
    return
  }
  let expected: string
  try {
    expected = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`missing snapshot ${name}; run \`mise run snapshot\``)
  }
  expect(actual, `snapshot ${name} changed; review, then run \`mise run snapshot\``).toBe(expected)
}

export function reports(overrides: Partial<Reports> = {}): Reports {
  return {
    codeReviewer: {
      verdict: 'APPROVE',
      overview: 'Looks fine.',
      findings: [],
      verificationStory: { testsReviewed: 'yes', buildVerified: 'yes', securityChecked: 'yes' },
    },
    testEngineer: {
      verdict: 'APPROVE',
      overview: 'Coverage is fine.',
      findings: [],
      coverageGaps: [],
      smokeTest: { commands: ['npm test'], suite: 'passed', manual: '', blocked: [] },
    },
    commentAuditor: {
      verdict: 'APPROVE',
      overview: 'Comments are clean.',
      mustKill: [],
      correctness: [],
      nits: [],
      kept: [],
      skipped: [],
    },
    ...overrides,
  }
}
