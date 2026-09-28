import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { renderTemplate, templatePath } from '../agent/extensions/lib/jinja.ts'

test('renderTemplate throws with the path and the OS reason when the template is missing', () => {
  const missing = join(tmpdir(), 'definitely-missing-jinja-template-12345.jinja')
  expect(() => renderTemplate(missing)).toThrow(/definitely-missing-jinja-template-12345\.jinja/)
  expect(() => renderTemplate(missing)).toThrow(/ENOENT/)
})

test('renderTemplate parses a template once and reuses it for later renders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const path = templatePath(dir, 'cached')
  writeFileSync(path, 'v={{ v }}')
  expect(renderTemplate(path, { v: '1' })).toBe('v=1')
  writeFileSync(path, 'changed={{ v }}')
  expect(renderTemplate(path, { v: '2' })).toBe('v=2')
})

test('renderTemplate substitutes values verbatim without escaping or re-parsing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const path = templatePath(dir, 'verbatim')
  writeFileSync(path, '{{ value }}')
  const value = 'a & b < c > d "e" {{ not_a_var }} {% raw %}'
  expect(renderTemplate(path, { value })).toBe(value)
})
