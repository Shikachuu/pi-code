import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { assert } from 'vitest'

import { stripTrailingNewline } from '../agent/extensions/lib/jinja.ts'

const DIR = join(import.meta.dirname, 'fixtures', 'sdd-golden')

export function expectGolden(name: string, actual: string): void {
  const path = join(DIR, `${name}.txt`)
  if (process.env.UPDATE_GOLDENS) {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(path, `${actual}\n`)
  }
  let expected: string
  try {
    expected = stripTrailingNewline(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`missing golden ${name}; run \`mise run golden\``)
  }
  assert.strictEqual(actual, expected, `golden ${name} changed; review, then run \`mise run golden\``)
}
