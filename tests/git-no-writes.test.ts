import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { REPO } from './helpers.ts'

const TOOL_DIRS = ['git-commit', 'git-gh', 'git-worktree']
const WRITE_CALLS =
  /\b(writeFileSync|writeFile|appendFile|appendFileSync|mkdirSync|mkdir|rmSync|rmdir|rm|unlink|copyFile|rename|truncate|createWriteStream)\b/

function sources(): { name: string; source: string }[] {
  const files: { name: string; source: string }[] = []
  for (const dir of TOOL_DIRS) {
    const root = join(REPO, 'agent', 'extensions', dir)
    for (const file of readdirSync(root)) {
      files.push({ name: `${dir}/${file}`, source: readFileSync(join(root, file), 'utf8') })
    }
  }
  files.push({ name: 'lib/exec.ts', source: readFileSync(join(REPO, 'agent', 'extensions', 'lib', 'exec.ts'), 'utf8') })
  return files
}

test('the git tool extensions never write under agent/', () => {
  for (const { name, source } of sources()) {
    expect(source, `${name} must not write runtime state`).not.toMatch(WRITE_CALLS)
  }
})

test('README documents where commits are made', () => {
  expect(readFileSync(join(REPO, 'README.md'), 'utf8')).toContain('agent/extensions/git-commit/')
})
