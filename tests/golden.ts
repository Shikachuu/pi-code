import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { assert } from 'vitest'

const DIR = join(import.meta.dirname, 'fixtures', 'sdd-golden')

export function expectGolden(name: string, actual: string): void {
  const path = join(DIR, `${name}.txt`)
  if (process.env.UPDATE_GOLDENS) {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(path, `${actual}\n`)
    return
  }
  let expected: string
  try {
    expected = readFileSync(path, 'utf8').replace(/\n$/, '')
  } catch {
    throw new Error(`missing golden ${name}; run \`mise run golden\``)
  }
  assert.strictEqual(actual, expected, `golden ${name} changed; review, then run \`mise run golden\``)
}
