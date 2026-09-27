import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { afterAll, expect, test } from 'vitest'

import { AGENT_DIR, REPO, asMock, isolate, matchSnapshot, must, normalize } from './helpers.ts'

const { cwd, restore } = isolate()
afterAll(restore)

interface RpcCommandInfo {
  name: string
  source?: string
  sourceInfo?: { scope?: string; path?: string }
}

interface GetCommandsResponse {
  type: 'response'
  command: 'get_commands'
  success: boolean
  data: { commands: RpcCommandInfo[] }
}

test('pi on PATH is the pinned version', () => {
  const pin = readFileSync(join(REPO, 'mise.toml'), 'utf8').match(/^pi\s*=\s*"([^"]+)"/m)?.[1]
  expect(execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim(), 'run tests through `mise run test`').toBe(pin)
})

test('pinned pi binary exposes the configured commands over RPC', { timeout: 30_000 }, async () => {
  const child = spawn('pi', ['--mode', 'rpc', '--no-session', '--offline'], {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  try {
    const lines = createInterface({ input: child.stdout })
    child.stdin.write(`${JSON.stringify({ id: '1', type: 'get_commands' })}\n`)
    let response: GetCommandsResponse | undefined
    for await (const line of lines) {
      const msg = JSON.parse(line) as { type?: string; command?: string }
      if (msg.type === 'response' && msg.command === 'get_commands') {
        response = asMock<GetCommandsResponse>(msg)
        break
      }
    }
    const ok = must(response, 'get_commands response')
    expect(ok.success, 'get_commands failed').toBe(true)
    const commands = ok.data.commands
      .map((c) => ({ name: c.name, source: c.source, scope: c.sourceInfo?.scope, path: c.sourceInfo?.path }))
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
    matchSnapshot('commands.json', normalize(JSON.stringify(commands, null, 2), cwd) + '\n')
  } finally {
    child.kill()
  }
})
