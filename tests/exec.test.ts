import { expect, test } from 'vitest'

import { missingBinary, run, tryRun } from '../agent/extensions/lib/exec.ts'

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

test('tryRun returns undefined on failure and the result on success', async () => {
  expect(await tryRun(node, ['-e', 'process.exit(1)'])).toBeUndefined()
  const ok = await tryRun(node, ['-e', 'process.stdout.write("ok")'])
  expect(ok?.stdout).toBe('ok')
})

test('missingBinary renders the not-found message only for a missing binary', async () => {
  const missing = await run('pi-definitely-not-on-path', [])
  expect(missingBinary('wt', missing)).toMatch(/^wt \(not found on PATH\)/)
  const ran = await run(node, ['-e', 'process.exit(1)'])
  expect(missingBinary('wt', ran)).toBeUndefined()
})
