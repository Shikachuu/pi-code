import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { REPO } from './helpers.ts'

const TOOL_DIRS = ['git-commit', 'git-gh', 'git-worktree']

test('the git tool extensions never write under agent/', () => {
  for (const dir of TOOL_DIRS) {
    const root = join(REPO, 'agent', 'extensions', dir)
    for (const file of readdirSync(root)) {
      const source = readFileSync(join(root, file), 'utf8')
      expect(source, `${dir}/${file} must not write runtime state`).not.toMatch(
        /\b(writeFileSync|appendFileSync|mkdirSync|rmSync|writeFile|mkdir)\b/,
      )
    }
  }
})

test('README documents where commits are made', () => {
  expect(readFileSync(join(REPO, 'README.md'), 'utf8')).toContain('agent/extensions/git-commit/')
})
