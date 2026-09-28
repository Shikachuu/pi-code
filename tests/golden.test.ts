import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { expectGolden } from './golden.ts'

test('expectGolden throws when the rendered value differs from the fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'golden-'))
  writeFileSync(join(dir, 'x.txt'), 'expected\n')
  expect(() => expectGolden('x', 'actual', dir)).toThrow(/golden x changed/)
})

test('expectGolden throws with the update command when the fixture is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'golden-'))
  expect(() => expectGolden('absent', 'actual', dir)).toThrow(/missing golden absent; run `mise run golden`/)
})

test('expectGolden writes the fixture in UPDATE_GOLDENS mode and reads it back unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'golden-'))
  process.env.UPDATE_GOLDENS = '1'
  try {
    expectGolden('made', 'value', dir)
  } finally {
    delete process.env.UPDATE_GOLDENS
  }
  expect(readFileSync(join(dir, 'made.txt'), 'utf8')).toBe('value\n')
  expectGolden('made', 'value', dir)
})
