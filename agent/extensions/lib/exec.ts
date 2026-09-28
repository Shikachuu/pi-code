import { execFile, type ExecFileOptions } from 'node:child_process'

export interface RunOptions {
  cwd?: string | undefined
  signal?: AbortSignal | undefined
  env?: NodeJS.ProcessEnv | undefined
  timeout?: number | undefined
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
    if (options.env !== undefined) execOptions.env = options.env
    if (options.timeout !== undefined) execOptions.timeout = options.timeout
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

export async function tryRun(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult | undefined> {
  const result = await run(command, args, options)
  return result.ok ? result : undefined
}

export function missingBinary(command: string, result: RunResult): string | undefined {
  return result.missing ? `${command} (not found on PATH): ${result.stderr.trim()}` : undefined
}
