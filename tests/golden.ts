import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { assert } from 'vitest'

const DIR = join(import.meta.dirname, 'fixtures', 'sdd-golden')

// Fixtures are stored with a final newline and compared after stripping it, so an
// editor that appends one does not fail the byte comparison.
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
