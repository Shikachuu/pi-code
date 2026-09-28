import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { assert } from 'vitest'

const DIR = join(import.meta.dirname, 'fixtures', 'sdd-golden')

const asserted = new Set<string>()

export function expectGolden(name: string, actual: string): void {
  asserted.add(name)
  const path = join(DIR, `${name}.txt`)
  if (process.env.UPDATE_GOLDENS) {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(path, `${actual}\n`)
  }
  let expected: string
  try {
    expected = readFileSync(path, 'utf8').replace(/\n$/, '')
  } catch {
    throw new Error(`missing golden ${name}; run \`mise run golden\``)
  }
  assert.strictEqual(actual, expected, `golden ${name} changed; review, then run \`mise run golden\``)
}

export function assertedGoldens(): ReadonlySet<string> {
  return asserted
}
