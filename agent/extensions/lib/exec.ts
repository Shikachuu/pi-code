import { execFile, type ExecFileOptions } from 'node:child_process'

import { truncateTail } from '@earendil-works/pi-coding-agent'

export interface RunOptions {
  cwd?: string | undefined
  signal?: AbortSignal | undefined
}

export interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
  /** True when the process could not be spawned, for example when the binary is absent from PATH. */
  missing: boolean
}

const MAX_BUFFER = 10 * 1024 * 1024

/** Bound command output the same way the built-in tools do. */
export function truncateOutput(text: string, maxLines?: number): string {
  const result = truncateTail(text, maxLines === undefined ? undefined : { maxLines })
  if (!result.truncated) return text
  return `${result.content}\n\n[... truncated; showing the last ${result.outputLines} of ${result.totalLines} lines]`
}

/**
 * Run a command with an argument array and never throw on a non-zero exit.
 * Failures are returned as `{ ok: false }` with the command's stderr so tools can
 * surface them as text instead of exceptions.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const execOptions: ExecFileOptions = { maxBuffer: MAX_BUFFER }
    if (options.cwd !== undefined) execOptions.cwd = options.cwd
    if (options.signal !== undefined) execOptions.signal = options.signal
    execFile(command, args, execOptions, (error, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : ''
      const err = typeof stderr === 'string' ? stderr : ''
      if (!error) {
        resolve({ ok: true, stdout: out, stderr: err, code: 0, missing: false })
        return
      }
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      resolve({
        ok: false,
        stdout: out,
        stderr: err || (missing ? `spawn ${command} ENOENT` : error.message),
        code: typeof error.code === 'number' ? error.code : 1,
        missing,
      })
    })
  })
}
