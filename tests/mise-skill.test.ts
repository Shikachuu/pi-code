import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { REPO } from './helpers.ts'

const SKILL = join(REPO, 'agent', 'skills', 'mise')
const SOURCE = join(REPO, '..', 'dotfiles', 'ai', '.claude', 'skills', 'mise')
const VALIDATE = join(SKILL, 'scripts', 'validate-mise.sh')

function has(command: string): boolean {
  return spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0
}

function runValidate(dir: string) {
  return spawnSync('bash', [VALIDATE, dir], { encoding: 'utf8', env: { ...process.env, MISE_OFFLINE: '1' } })
}

// The port-mise-skill spec requires a byte-identical copy, so a comment cleanup
// must not edit these files. Skipped when the sibling dotfiles repo is absent.
test.skipIf(!existsSync(SOURCE))('the mise skill stays a verbatim copy of dotfiles', () => {
  const diff = spawnSync('diff', ['-r', SOURCE, SKILL], { encoding: 'utf8' })
  expect(diff.status).not.toBe(0)
  expect(diff.stdout.trim().split('\n')).toEqual([`Only in ${SOURCE}: evals`])
})

test.skipIf(!has('mise') || !has('jq'))('validate-mise.sh refuses a directory with no mise config', () => {
  const run = runValidate(mkdtempSync(join(tmpdir(), 'mise-empty-')))
  expect(run.status).toBe(1)
  expect(run.stderr).toMatch(/no mise config found/)
})

test.skipIf(!has('mise') || !has('jq'))('validate-mise.sh flags a deprecated config form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mise-deprecated-'))
  writeFileSync(join(dir, 'mise.toml'), '[tools]\nnode = "24"\n\n[alias]\nnb = "run build"\n')
  const run = runValidate(dir)
  expect(run.status, 'a deprecated form fails the gate').toBe(1)
  expect(run.stdout).toMatch(/deprecations: FOUND/)
  expect(`${run.stdout}${run.stderr}`).toMatch(/use \[tool_alias\] or \[shell_alias\], not \[alias\]/)
})
