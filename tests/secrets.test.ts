import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { AGENT_DIR, REPO, readJson } from './helpers.ts'

const INDIRECT = /^(\$\{?[A-Z_][A-Z0-9_]*\}?|!.+)$/

interface ModelEntry {
  headers?: Record<string, string>
}

interface ProviderEntry {
  apiKey?: unknown
  headers?: Record<string, string>
  models?: ModelEntry[]
}

test('models.json holds no literal credentials', () => {
  const { providers = {} } = readJson<{ providers?: Record<string, ProviderEntry> }>(join(AGENT_DIR, 'models.json'))
  for (const [id, provider] of Object.entries(providers)) {
    const values: unknown[] = [provider.apiKey, ...Object.values(provider.headers ?? {})]
    for (const model of provider.models ?? []) values.push(...Object.values(model.headers ?? {}))
    for (const value of values.filter((v) => v !== undefined)) {
      expect(String(value), `${id}: use $ENV_VAR or !command, not a literal`).toMatch(INDIRECT)
    }
  }
})

test('pi state files are git-ignored', () => {
  const paths = [
    'auth.json',
    'trust.json',
    'models-store.json',
    'crashes.json',
    'sessions/x.jsonl',
    'bin/rg',
    'npm/x',
    'git/x',
  ]
  const { stdout } = spawnSync('git', ['check-ignore', ...paths.map((p) => `agent/${p}`)], {
    cwd: REPO,
    encoding: 'utf8',
  })
  expect(stdout.trim().split('\n').filter(Boolean)).toEqual(paths.map((p) => `agent/${p}`))
})
