import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { AGENT_DIR, REPO, readJson } from './helpers.ts'

interface PackageJson {
  devDependencies: Record<string, string>
}

interface AgentSettings {
  lastChangelogVersion?: string
}

test('pi version is identical across mise, npm, installed SDK and settings', () => {
  const miseToml = readFileSync(join(REPO, 'mise.toml'), 'utf8')
  const misePin = miseToml.match(/^pi\s*=\s*"([^"]+)"/m)?.[1]
  const devDeps = readJson<PackageJson>(join(REPO, 'package.json')).devDependencies
  const devDep = devDeps['@earendil-works/pi-coding-agent']
  const tuiDevDep = devDeps['@earendil-works/pi-tui']
  const installed = readJson<{ version: string }>(
    join(REPO, 'node_modules/@earendil-works/pi-coding-agent/package.json'),
  ).version
  const changelog = readJson<AgentSettings>(join(AGENT_DIR, 'settings.json')).lastChangelogVersion

  expect(misePin ?? '', 'mise.toml must pin pi to an exact version').toMatch(/^\d+\.\d+\.\d+$/)
  expect({ devDep, tuiDevDep, installed, changelog }).toEqual({
    devDep: misePin,
    tuiDevDep: misePin,
    installed: misePin,
    changelog: misePin,
  })
})
