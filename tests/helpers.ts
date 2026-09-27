import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { expect } from 'vitest'

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
