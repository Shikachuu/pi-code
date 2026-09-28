import { execFile, type ExecFileOptions } from 'node:child_process'
import { existsSync } from 'node:fs'

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
    const execOptions: ExecFileOptions = {
      maxBuffer: MAX_BUFFER,
      // git and gh must never block on a terminal prompt from inside a tool call.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    }
    if (options.cwd !== undefined) execOptions.cwd = options.cwd
    if (options.signal !== undefined) execOptions.signal = options.signal
    try {
      execFile(command, args, execOptions, (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : ''
        const err = typeof stderr === 'string' ? stderr : ''
        if (!error) {
          resolve({ ok: true, stdout: out, stderr: err, code: 0, missing: false })
          return
        }
        if (options.cwd !== undefined && !existsSync(options.cwd)) {
          resolve({
            ok: false,
            stdout: out,
            stderr: `working directory does not exist: ${options.cwd}`,
            code: 1,
            missing: false,
          })
          return
        }
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
        const stderrText = err || (missing ? `spawn ${command} ENOENT` : error.message)
        resolve({
          ok: false,
          stdout: out,
          stderr: stderrText.includes('maxBuffer')
            ? `command output exceeded the ${MAX_BUFFER} byte limit`
            : stderrText,
          code: typeof error.code === 'number' ? error.code : 1,
          missing,
        })
      })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: (error as Error).message, code: 1, missing: false })
    }
  })
}
