import { execFile, type ExecFileOptions } from 'node:child_process'
import { existsSync } from 'node:fs'

import { formatSize, truncateTail } from '@earendil-works/pi-coding-agent'

export interface RunOptions {
  cwd?: string | undefined
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
}

export interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
  missing: boolean
}

const MAX_BUFFER = 10 * 1024 * 1024

const DEFAULT_TIMEOUT_MS = 120_000

const NON_INTERACTIVE_ENV = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }

export function detailOf(result: RunResult): string {
  return result.stderr.trim() || result.stdout.trim() || '(no output)'
}

export function truncateOutput(text: string, maxLines?: number): string {
  const result = truncateTail(text, maxLines === undefined ? undefined : { maxLines })
  if (!result.truncated) return text
  const notice =
    result.truncatedBy === 'bytes'
      ? `[... truncated to ${formatSize(result.outputBytes)}; showing the last ${result.outputLines} of ${result.totalLines} lines]`
      : `[... truncated; showing the last ${result.outputLines} of ${result.totalLines} lines]`
  return `${result.content}\n\n${notice}`
}

type RunExecOptions = ExecFileOptions & { stdio?: ['ignore', 'pipe', 'pipe'] }

/**
 * Run a command with an argument array and never throw on a non-zero exit.
 * Failures are returned as `{ ok: false }` so tools can surface them as text.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const execOptions: RunExecOptions = {
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
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
        const overBuffer = (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        const aborted = error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR'
        const killed = (error as { killed?: boolean }).killed === true
        const stderrText = overBuffer
          ? `command output exceeded the ${MAX_BUFFER} byte limit`
          : missing
            ? `spawn ${command} ENOENT`
            : killed
              ? `${command} timed out after ${timeoutMs}ms`
              : err || (aborted ? error.message : '')
        resolve({
          ok: false,
          stdout: out,
          stderr: stderrText,
          code: typeof error.code === 'number' ? error.code : 1,
          missing,
        })
      })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: (error as Error).message, code: 1, missing: false })
    }
  })
}
