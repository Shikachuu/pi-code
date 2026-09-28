import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assert, expect, test } from 'vitest'

import { renderTemplate, templatePath } from '../agent/extensions/lib/jinja.ts'

test('renderTemplate throws with the path and the OS reason when the template is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const missing = templatePath(dir, 'absent')
  expect(() => renderTemplate(missing)).toThrow(/cannot read template/)
  expect(() => renderTemplate(missing)).toThrow(/absent\.jinja/)
  expect(() => renderTemplate(missing)).toThrow(/ENOENT/)
})

test('renderTemplate throws with the path and the parse reason when the template is invalid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const path = templatePath(dir, 'broken')
  writeFileSync(path, '{% if %}')
  expect(() => renderTemplate(path)).toThrow(/cannot parse template/)
  expect(() => renderTemplate(path)).toThrow(/broken\.jinja/)
})

test('renderTemplate throws with the path when rendering fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const path = templatePath(dir, 'bad-filter')
  writeFileSync(path, '{{ value | nosuchfilter }}')
  expect(() => renderTemplate(path, { value: 'x' })).toThrow(/cannot render template/)
  expect(() => renderTemplate(path, { value: 'x' })).toThrow(/bad-filter\.jinja/)
})

test('renderTemplate parses a template once and ignores later edits to the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const path = templatePath(dir, 'cached')
  writeFileSync(path, 'first {{ v }}')
  expect(renderTemplate(path, { v: '1' })).toBe('first 1')

  writeFileSync(path, 'second {{ v }}')
  expect(readFileSync(path, 'utf8')).toBe('second {{ v }}')
  expect(renderTemplate(path, { v: '2' })).toBe('first 2')
})

test('renderTemplate substitutes values verbatim without escaping or re-parsing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const path = templatePath(dir, 'verbatim')
  writeFileSync(path, '{{ value }}')
  const value = 'a & b < c > d "e" {{ not_a_var }} {% raw %}'
  expect(renderTemplate(path, { value })).toBe(value)
})

test('renderTemplate strips one trailing newline from the rendered output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const path = templatePath(dir, 'trailing')
  writeFileSync(path, '{{ value }}')
  expect(renderTemplate(path, { value: 'x\n' })).toBe('x')
  expect(renderTemplate(path, { value: 'x\n\n' })).toBe('x\n')
})

test('renderTemplate renders an unknown variable as empty rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const path = templatePath(dir, 'missing-var')
  writeFileSync(path, 'a{{ missing }}b')
  expect(renderTemplate(path)).toBe('ab')
})

test('renderTemplate renders a variable-free template without a context argument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const path = templatePath(dir, 'static')
  writeFileSync(path, 'plain text')
  expect(renderTemplate(path)).toBe('plain text')
})

test('renderTemplate renders an all-false template as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const path = templatePath(dir, 'empty')
  writeFileSync(path, '{% if false %}never{% endif %}')
  expect(renderTemplate(path)).toBe('')
})

test('renderTemplate strips the trailing newline a loop body leaves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const path = templatePath(dir, 'loop')
  writeFileSync(path, '{% for x in xs %}\n- {{ x }}\n{% endfor %}\n')
  expect(renderTemplate(path, { xs: ['a', 'b'] })).toBe('- a\n- b')
})

test('renderTemplate preserves the original error as cause on every failure path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinja-'))
  const cases: [string, string, Record<string, unknown>][] = [
    ['absent', '', {}],
    ['broken', '{% if %}', {}],
    ['bad-filter', '{{ v | nosuchfilter }}', { v: 'x' }],
  ]
  for (const [name, source, context] of cases) {
    const path = templatePath(dir, name)
    if (source) writeFileSync(path, source)
    let caught: unknown
    try {
      renderTemplate(path, context)
    } catch (error) {
      caught = error
    }
    assert.instanceOf((caught as Error).cause, Error, name)
  }
})

test('renderTemplate keys the cache by full path, not basename', () => {
  const first = templatePath(mkdtempSync(join(tmpdir(), 'jinja-a-')), 'same')
  const second = templatePath(mkdtempSync(join(tmpdir(), 'jinja-b-')), 'same')
  writeFileSync(first, 'A={{ v }}')
  writeFileSync(second, 'B={{ v }}')
  expect(renderTemplate(first, { v: '1' })).toBe('A=1')
  expect(renderTemplate(second, { v: '2' })).toBe('B=2')
})
