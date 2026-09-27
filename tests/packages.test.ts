import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect, test } from 'vitest'

import { AGENT_DIR, readJson } from './helpers.ts'

// Pi installs npm:/git: sources itself with no lockfile; only local paths backed by package-lock.json are reproducible.
const REMOTE = /^(npm:|git:|git\+|https?:|ssh:|git@)/

interface AgentSettings {
  packages?: (string | { source: string })[]
  extensions?: string[]
  skills?: string[]
  prompts?: string[]
  themes?: string[]
}

test('settings.packages only references local paths that exist', () => {
  const { packages = [] } = readJson<AgentSettings>(resolve(AGENT_DIR, 'settings.json'))
  for (const entry of packages) {
    const source: string = typeof entry === 'string' ? entry : entry.source
    expect(source, `${source}: add it to package.json and reference ../node_modules/<name>`).not.toMatch(REMOTE)
    expect(existsSync(resolve(AGENT_DIR, source)), `${source} does not exist; run \`mise install\``).toBe(true)
  }
})

test('settings resource paths are local', () => {
  const settings = readJson<AgentSettings>(resolve(AGENT_DIR, 'settings.json'))
  for (const key of ['extensions', 'skills', 'prompts', 'themes'] as const) {
    for (const path of settings[key] ?? []) {
      expect(path, `${key}: ${path}`).not.toMatch(REMOTE)
      expect(!path.startsWith('~') && !path.startsWith('/'), `${key}: ${path} points outside the repo`).toBe(true)
    }
  }
})
