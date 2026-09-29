import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { detailOf, run, truncateOutput } from '../agent/extensions/lib/exec.ts'

const node = process.execPath

test('run captures stdout and a zero exit code', async () => {
  const result = await run(node, ['-e', 'process.stdout.write("hi")'])
  expect(result).toMatchObject({ ok: true, code: 0, stdout: 'hi', missing: false })
})

test('run returns a non-zero exit code with stderr instead of throwing', async () => {
  const result = await run(node, ['-e', 'process.stderr.write("boom"); process.exit(3)'])
  expect(result.ok).toBe(false)
  expect(result.code).toBe(3)
  expect(result.stderr).toContain('boom')
  expect(result.missing).toBe(false)
})

test('run flags a missing binary and never throws', async () => {
  const result = await run('pi-definitely-not-on-path', [])
  expect(result.ok).toBe(false)
  expect(result.missing).toBe(true)
  expect(result.stderr).toContain('ENOENT')
})

test('run resolves rather than rejects on an aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await run(node, ['-e', 'setTimeout(() => {}, 5000)'], { signal: controller.signal })
  expect(result.ok).toBe(false)
})

test('run blames a missing cwd rather than reporting a missing binary', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'exec-cwd-')), 'gone')
  const result = await run(node, ['-e', 'process.exit(0)'], { cwd: missing })
  expect(result.ok).toBe(false)
  expect(result.missing).toBe(false)
  expect(result.stderr).toContain('working directory does not exist')
  expect(result.stderr).toContain(missing)
})

test('run resolves when cwd is a file instead of a directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exec-file-'))
  const file = join(dir, 'not-a-dir')
  writeFileSync(file, 'x')
  const result = await run(node, ['-e', 'process.exit(0)'], { cwd: file })
  expect(result.ok).toBe(false)
  expect(result.missing).toBe(false)
})

test('run passes the non-interactive env to the child', async () => {
  const result = await run(node, [
    '-e',
    'process.stdout.write(`${process.env.GIT_TERMINAL_PROMPT}/${process.env.GH_PROMPT_DISABLED}`)',
  ])
  expect(result.stdout).toBe('0/1')
})

test('run names the byte limit when a command exceeds maxBuffer', async () => {
  const result = await run(node, ['-e', "process.stdout.write('x'.repeat(11 * 1024 * 1024))"])
  expect(result.ok).toBe(false)
  expect(result.missing).toBe(false)
  expect(result.stderr).toContain('command output exceeded the')
})

test('run kills a child that exceeds the timeout', async () => {
  const result = await run(node, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 50 })
  expect(result.ok).toBe(false)
  expect(result.stderr).toContain('timed out after 50ms')
})

test('detailOf prefers stderr, then stdout, then a placeholder', () => {
  expect(detailOf({ ok: false, stdout: 'out', stderr: 'err', code: 1, missing: false })).toBe('err')
  expect(detailOf({ ok: false, stdout: 'out', stderr: '  ', code: 1, missing: false })).toBe('out')
  expect(detailOf({ ok: false, stdout: '', stderr: '', code: 1, missing: false })).toBe('(no output)')
})

test('truncateOutput returns short input unchanged', () => {
  expect(truncateOutput('one\ntwo')).toBe('one\ntwo')
})

test('truncateOutput keeps the tail and pins the notice', () => {
  const text = ['a', 'b', 'c', 'd', 'e'].join('\n')
  expect(truncateOutput(text, 3)).toBe('c\nd\ne\n\n[... truncated; showing the last 3 of 5 lines]')
})

test('truncateOutput names the byte limit when a long line is cut', () => {
  const out = truncateOutput(`a\n${'x'.repeat(60_000)}\nb`)
  expect(out).toMatch(/\[\.\.\. truncated to .+; showing the last \d+ of 3 lines\]/)
  expect(out).not.toContain('undefined')
})
