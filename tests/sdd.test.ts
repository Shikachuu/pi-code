import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import type { TUI } from '@earendil-works/pi-tui'
import type { WorkflowRunOptions, WorkflowRunResult } from '@quintinshaw/pi-dynamic-workflows'
import { parseWorkflowScript, runWorkflow } from '@quintinshaw/pi-dynamic-workflows'
import { expect, test, vi } from 'vitest'

import register from '../agent/extensions/sdd/index.ts'
import { memoryBlock, parseEntries } from '../agent/extensions/sdd/memory.ts'
import type { ProgressState } from '../agent/extensions/sdd/progress.ts'
import { renderResearch, validatePlan } from '../agent/extensions/sdd/prompts.ts'
import { SCOUT, type WorkflowRunner } from '../agent/extensions/sdd/runner.ts'
import {
  createFeature,
  featureCompletions,
  featureDir,
  listFeatures,
  nextResearchPath,
  readDoc,
  readState,
  setPhase,
  setVerifyRounds,
  slugify,
  splitArgs,
  writeDoc,
} from '../agent/extensions/sdd/store.ts'
import {
  DISCOVERY_SCRIPT,
  discoveryArgs,
  ENRICH_SCRIPT,
  enrichArgs,
  MAX_PROBES,
  RESEARCH_SCRIPT,
  researchArgs,
  SINGLE_SCRIPT,
} from '../agent/extensions/sdd/workflows.ts'
import { asMock, must } from './helpers.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'sdd-'))

const VALID_PLAN = `# Plan: Phone

## Tasks
- [ ] 1. Add column

## Acceptance criteria
- Users can save a phone number

## Validation pipeline
- \`mise run test\` - unit tests
`

interface FakeModel {
  provider: string
  id: string
}

interface FakeSession {
  sendUserMessage(content: string): Promise<void>
}

interface FakeNewSessionOptions {
  withSession: (session: FakeSession) => Promise<void>
}

interface FakeCtx {
  cwd: string
  mode: 'rpc' | 'tui'
  hasUI: boolean
  model?: FakeModel | undefined
  modelRegistry: { getAll(): FakeModel[]; find(provider: string, id: string): FakeModel | undefined }
  sessionManager: { getEntries(): unknown[] }
  ui: {
    select(): Promise<string | undefined>
    input(): Promise<string | undefined>
    notify(message: string, level?: string): void
    setWidget(key: string, content: unknown): void
    confirm(): Promise<boolean>
  }
  newSession?(options: FakeNewSessionOptions): Promise<{ cancelled: boolean }>
}

interface FakeCommand {
  handler(args: string, ctx: FakeCtx): Promise<void>
}

interface FakeToolResult {
  content: { type: string; text: string }[]
}

interface FakeTool {
  name: string
  parameters?: unknown
  promptGuidelines?: string[]
  execute(
    toolCallId: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: FakeCtx,
  ): Promise<FakeToolResult>
}

type FakeHandler = (event: unknown, ctx: FakeCtx) => unknown

type Call = { prompt: string; label?: string | undefined; scout: boolean; tier?: string | undefined }

const toolText = (result: FakeToolResult): string => must(result.content[0], 'tool content').text

const command = (commands: Map<string, FakeCommand>, name: string): FakeCommand =>
  must(commands.get(name), `${name} command`)
const tool = (tools: Map<string, FakeTool>, name: string): FakeTool => must(tools.get(name), `${name} tool`)
const handler = (handlers: Map<string, FakeHandler>, event: string): FakeHandler =>
  must(handlers.get(event), `${event} handler`)

test('slugify makes short kebab-case names', () => {
  expect(slugify('Add a Phone Number field!')).toBe('add-a-phone-number-field')
  expect(slugify('***')).toBe('feature')
  expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(48)
})

test('features get unique slugs, state and ordered listings', () => {
  const cwd = tmp()
  const a = createFeature(cwd, 'phone-number-field', 'Phone', new Date('2026-01-01T00:00:00Z'))
  const b = createFeature(cwd, 'Phone Number Field', 'Phone again', new Date('2026-01-02T00:00:00Z'))
  expect(a.slug).toBe('phone-number-field')
  expect(b.slug).toBe('phone-number-field-2')
  expect(featureDir(cwd, a.slug).endsWith(join('.pi', 'sdd', 'phone-number-field'))).toBe(true)
  setPhase(cwd, a.slug, 'planned', new Date('2026-01-03T00:00:00Z'))
  expect(listFeatures(cwd).map((f) => [f.slug, f.phase])).toEqual([
    ['phone-number-field', 'planned'],
    ['phone-number-field-2', 'spec'],
  ])
  expect(featureCompletions(cwd, 'phone', ['planned'])?.map((i) => i.value)).toEqual(['phone-number-field'])
  expect(featureCompletions(cwd, 'zzz')).toBeNull()
  expect(() => setPhase(cwd, 'missing', 'done')).toThrow(/Unknown feature/)
})

test('research files are numbered from the highest existing one', () => {
  const cwd = tmp()
  const { slug } = createFeature(cwd, 'x', 'X')
  expect(nextResearchPath(cwd, slug).endsWith('research-1.md')).toBe(true)
  writeFileSync(join(featureDir(cwd, slug), 'research-1.md'), 'a')
  writeFileSync(join(featureDir(cwd, slug), 'research-3.md'), 'b')
  expect(nextResearchPath(cwd, slug).endsWith('research-4.md')).toBe(true)
})

test('splitArgs separates the feature from the rest', () => {
  expect(splitArgs('  phone  validation rules ')).toEqual({ feature: 'phone', rest: 'validation rules' })
  expect(splitArgs('phone')).toEqual({ feature: 'phone', rest: '' })
})

test('memory reads hermes entries for the repo and the user', () => {
  expect(parseEntries('a <!-- created=1 -->\n§\n\n§\nb')).toEqual(['a', 'b'])
  const agentDir = tmp()
  const repo = join(tmp(), 'proj')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'sub'))
  expect(memoryBlock(repo, agentDir)).toBe('')
  mkdirSync(join(agentDir, 'projects-memory', 'proj'), { recursive: true })
  mkdirSync(join(agentDir, 'pi-hermes-memory'))
  writeFileSync(join(agentDir, 'projects-memory', 'proj', 'MEMORY.md'), 'uses pnpm <!-- created=x -->')
  writeFileSync(join(agentDir, 'pi-hermes-memory', 'USER.md'), 'likes Go')
  expect(memoryBlock(join(repo, 'sub'), agentDir)).toBe(
    '<memory>\nProject memory:\n- uses pnpm\n\nUser profile:\n- likes Go\n</memory>',
  )
})

test('validatePlan requires tasks, criteria and pipeline commands', () => {
  expect(validatePlan(VALID_PLAN)).toEqual([])
  const errors = validatePlan('# Plan\n\n## Tasks\n- do it\n\n## Validation pipeline\nrun tests\n')
  expect(errors.length).toBe(3)
  expect(errors.join('\n')).toMatch(/checkbox/)
  expect(errors.join('\n')).toMatch(/Acceptance criteria/)
  expect(errors.join('\n')).toMatch(/backticks/)
})

test('renderResearch writes the fixed format with deduplicated sources', () => {
  const md = renderResearch({
    question: 'Phone validation',
    summary: 'Use libphonenumber',
    findings: [
      { claim: 'E.164 is the standard', sources: ['https://a'] },
      { claim: 'Max 15 digits', sources: ['https://a', 'https://b'] },
    ],
    implications: ['Store E.164'],
    recommendation: 'Normalize on write',
    openQuestions: [],
  })
  for (const heading of [
    '## Question',
    '## Summary',
    '## Findings',
    '## Implications for this feature',
    '## Recommendation',
    '## Open questions',
    '## Sources',
  ]) {
    expect(md).toContain(heading)
  }
  expect(md.split('\n').filter((l) => l === '- https://a').length).toBe(1)
  expect(md).toMatch(/## Open questions\n\n- None/)
})

test('every workflow script parses', () => {
  for (const script of [SINGLE_SCRIPT, ENRICH_SCRIPT, DISCOVERY_SCRIPT, RESEARCH_SCRIPT]) {
    expect(parseWorkflowScript(script).meta.name.startsWith('sdd_')).toBe(true)
  }
})

async function runStub(script: string, args: unknown, reply: (call: Call) => unknown) {
  const calls: Call[] = []
  const result = await runWorkflow(script, {
    args,
    persistLogs: false,
    agentRegistry: new Map([[SCOUT.name, SCOUT]]),
    agent: {
      run: async (prompt, options) => {
        const call = {
          prompt,
          label: options?.label,
          scout: !!options?.disallowedToolNames?.includes('write'),
          tier: options?.tier,
        }
        calls.push(call)
        return reply(call)
      },
    },
  })
  return { calls, result: asMock<Record<string, unknown>>(result.result) }
}

test('discovery caps probes at 10 and feeds every result to the synthesizer', async () => {
  const probes = Array.from({ length: 15 }, (_, i) => ({
    kind: i === 0 ? 'web' : 'code',
    title: `p${i}`,
    question: `q${i}`,
    hints: '',
  }))
  const { calls, result } = await runStub(DISCOVERY_SCRIPT, discoveryArgs('SPEC', undefined, ''), (call) => {
    if (call.label === 'plan probes') return { probes }
    if (call.label === 'synthesize') return { markdown: '# Discovery' }
    return { findings: [{ claim: call.label, evidence: ['a.ts:1'] }], answered: [], gaps: [] }
  })
  const probeCalls = calls.filter((c) => c.label?.startsWith('probe '))
  expect(probeCalls.length).toBe(MAX_PROBES)
  expect(
    probeCalls.every((c) => c.scout && c.tier === 'small'),
    'probes run as the read-only scout on the small tier',
  ).toBe(true)
  expect(probeCalls[0]?.prompt, 'web probes get web tool instructions').toMatch(/web_enable/)
  expect(probeCalls[1]?.prompt).not.toMatch(/web_enable/)
  const synth = calls.find((c) => c.label === 'synthesize')
  expect(synth?.prompt ?? '').toMatch(/"title": "p9"/)
  expect(synth?.prompt ?? '').not.toMatch(/"title": "p10"/)
  expect(result.markdown).toBe('# Discovery')
})

test('discovery falls back to one code probe when planning returns none', async () => {
  const { calls } = await runStub(DISCOVERY_SCRIPT, discoveryArgs('SPEC', 'OLD', ''), (call) =>
    call.label === 'synthesize'
      ? { markdown: 'm' }
      : call.label === 'plan probes'
        ? null
        : { findings: [], answered: [], gaps: [] },
  )
  expect(calls.map((c) => c.label)).toEqual(['plan probes', 'probe 1: related code', 'synthesize'])
  expect(calls[2]?.prompt).toMatch(/<existing-discovery>\nOLD/)
})

test('enrich runs scope, repo scout and questions in parallel', async () => {
  const { calls, result } = await runStub(ENRICH_SCRIPT, enrichArgs('add phone', '<memory>m</memory>'), (call) => ({
    label: call.label,
  }))
  expect(calls.map((c) => c.label).sort()).toEqual(['open questions', 'repo context', 'scope'])
  expect(calls.every((c) => c.scout)).toBe(true)
  expect(calls.find((c) => c.label === 'scope')?.prompt ?? '').toMatch(/<memory>m<\/memory>/)
  expect(result.scope).toEqual({ label: 'scope' })
})

test('research gathers per query and reports from supported claims', async () => {
  const { calls, result } = await runStub(
    RESEARCH_SCRIPT,
    researchArgs('phone validation', 'SPEC', undefined),
    (call) => {
      if (call.label === 'plan queries') return { queries: ['a', 'b', 'c', 'd', 'e'] }
      if (call.label?.startsWith('research')) return { sources: [{ url: `https://${call.label}`, claims: ['c'] }] }
      if (call.label === 'cross-check') return { supported: [{ claim: 'c', sources: ['https://x'] }] }
      return { summary: 's', findings: [], implications: [], recommendation: 'r', openQuestions: [] }
    },
  )
  expect(calls.filter((c) => c.label?.startsWith('research')).length).toBe(4)
  expect(calls.find((c) => c.label === 'cross-check')?.prompt ?? '').toMatch(/https:\/\/research 4/)
  expect(calls.find((c) => c.label === 'write report')?.prompt ?? '').toMatch(/"claim":"c"/)
  expect(result.recommendation).toBe('r')
})

function fakePi() {
  const commands = new Map<string, FakeCommand>()
  const tools = new Map<string, FakeTool>()
  const handlers = new Map<string, FakeHandler>()
  const entries: { type: string; data: Record<string, string> }[] = []
  const renderers = new Map<string, (entry: unknown) => unknown>()
  let active = ['read', 'sdd_save_plan', 'sdd_complete', 'sdd_verify']
  const pi = {
    registerCommand: (name: string, cmd: FakeCommand) => commands.set(name, cmd),
    registerTool: (t: FakeTool) => tools.set(t.name, t),
    registerEntryRenderer: (type: string, renderer: (entry: unknown) => unknown) => renderers.set(type, renderer),
    on: (event: string, fn: FakeHandler) => handlers.set(event, fn),
    appendEntry: (type: string, data: Record<string, string>) => entries.push({ type, data }),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names
    },
    setSessionName: () => {},
    setModel: async () => true,
    setThinkingLevel: () => {},
    getThinkingLevel: () => 'off' as const,
  }
  return { pi: asMock<ExtensionAPI>(pi), commands, tools, handlers, entries, renderers, active: () => active }
}

function fakeCtx(cwd: string, selects: string[] = [], inputs: string[] = [], confirms: boolean[] = []) {
  const notes: string[] = []
  const ctx: FakeCtx = {
    cwd,
    mode: 'rpc',
    hasUI: true,
    model: undefined,
    modelRegistry: { getAll: () => [], find: () => undefined },
    sessionManager: { getEntries: () => [] },
    ui: {
      select: async () => selects.shift(),
      input: async () => inputs.shift(),
      notify: (msg: string) => notes.push(msg),
      setWidget: () => {},
      confirm: async () => (confirms.length ? (confirms.shift() ?? true) : true),
    },
  }
  return { notes, ctx }
}

test('registers the SDD commands and session tools', () => {
  const { pi, commands, tools, handlers } = fakePi()
  register(pi)
  expect([...commands.keys()].sort()).toEqual(['discover', 'implement', 'plan', 'research', 'sdd', 'spec'])
  expect([...tools.keys()].sort()).toEqual(['sdd_complete', 'sdd_save_plan', 'sdd_verify'])
  expect(handlers.has('session_start')).toBe(true)
})

test('session tools stay off outside plan and implement sessions', async () => {
  const { pi, handlers, active } = fakePi()
  register(pi)
  const { ctx } = fakeCtx(tmp())
  await handler(handlers, 'session_start')({ reason: 'startup' }, ctx)
  expect(active()).toEqual(['read'])
  ctx.sessionManager.getEntries = () => [
    { type: 'custom', customType: 'sdd-session', data: { kind: 'plan', slug: 'x' } },
  ]
  await handler(handlers, 'session_start')({ reason: 'resume' }, ctx)
  expect(active()).toEqual(['read', 'sdd_save_plan'])
})

test('sdd_save_plan rejects invalid plans, relays feedback and saves on accept', async () => {
  const cwd = tmp()
  const { slug } = createFeature(cwd, 'phone', 'Phone')
  const { pi, tools, entries } = fakePi()
  register(pi)
  const save = (markdown: string, ctx: FakeCtx) =>
    tool(tools, 'sdd_save_plan').execute(
      'id',
      { feature: slug, markdown, decisions: ['Store E.164'] },
      undefined,
      undefined,
      ctx,
    )

  const rejected = await save('# Plan\n', fakeCtx(cwd).ctx)
  expect(toolText(rejected)).toMatch(/Plan rejected/)

  const revised = await save(VALID_PLAN, fakeCtx(cwd, ['Suggest changes'], ['add a migration test']).ctx)
  expect(toolText(revised)).toMatch(/add a migration test/)
  expect(readDoc(cwd, slug, 'plan.md')).toBeUndefined()

  const saved = await save(VALID_PLAN, fakeCtx(cwd, ['Accept']).ctx)
  expect(toolText(saved)).toMatch(/memory_add with target "project"[\s\S]*Store E.164[\s\S]*\/implement phone/)
  expect(readDoc(cwd, slug, 'plan.md')).toBe(VALID_PLAN)
  expect(readState(cwd, slug)?.phase).toBe('planned')
  expect(entries.map((e) => e.data.status)).toEqual(['changes requested', 'accepted'])
})

test('sdd_complete refuses to close the feature until verification approves', async () => {
  const cwd = tmp()
  const { slug } = createFeature(cwd, 'phone', 'Phone')
  writeDoc(cwd, slug, 'plan.md', VALID_PLAN)
  const { pi, tools } = fakePi()
  register(pi)
  const complete = (status: string) =>
    tool(tools, 'sdd_complete').execute(
      'id',
      { feature: slug, results: [{ criterion: 'saves phone', status, evidence: 'tests pass' }] },
      undefined,
      undefined,
      fakeCtx(cwd).ctx,
    )
  const record = (verdict?: string) =>
    writeDoc(
      cwd,
      slug,
      'plan.md',
      `${VALID_PLAN}${verdict ? `\n## Verification\n\n- verdict: ${verdict}\n\nreport\n` : ''}`,
    )

  expect(toolText(await complete('fail'))).toMatch(/1 criteria failed/)
  expect(readState(cwd, slug)?.phase).toBe('implementing')

  record()
  const unverified = toolText(await complete('pass'))
  expect(unverified).toMatch(/Call sdd_verify with feature "phone" first/)
  expect(readState(cwd, slug)?.phase, 'no verdict, no close').toBe('implementing')

  record('REQUEST CHANGES')
  expect(toolText(await complete('pass'))).toMatch(/Verification recorded REQUEST CHANGES/)
  expect(readState(cwd, slug)?.phase).toBe('implementing')

  setVerifyRounds(cwd, slug, 2)
  record('APPROVE')
  expect(toolText(await complete('pass'))).toMatch(/the feature is done/)
  expect(readState(cwd, slug)?.phase).toBe('done')
  expect(readState(cwd, slug)?.verifyRounds, 'the round counter resets on close').toBe(0)
  expect(readDoc(cwd, slug, 'plan.md') ?? '').toMatch(/## Results\n\n- \[x\] saves phone: pass - tests pass\n$/)
})

interface SpecRunArgs {
  scope?: unknown
  label?: string
  prompt?: string
}

test('/spec interviews, reviews, saves the spec, runs discovery and stops at the gate', async () => {
  const cwd = tmp()
  const labels: string[] = []
  const prompts: { label: string; prompt: string }[] = []
  const run = async (_script: string, options: WorkflowRunOptions) => {
    const args = asMock<SpecRunArgs>(options.args)
    if (args.scope) {
      labels.push('enrich')
      return asMock({
        result: {
          scope: {},
          repo: {},
          questions: {
            questions: [
              {
                id: 'fmt',
                header: 'Format',
                question: 'Which format?',
                options: [{ label: 'E.164' }, { label: 'Free text' }],
              },
            ],
          },
        },
      })
    }
    if (args.label) {
      labels.push(args.label)
      prompts.push({ label: args.label, prompt: args.prompt ?? '' })
      const revise = args.label === 'revise spec'
      return asMock({
        result: {
          slug: revise ? 'ignored' : 'phone-number-field',
          title: 'Phone number',
          markdown: revise ? '# Phone v2' : '# Phone',
        },
      })
    }
    labels.push('discovery')
    return asMock({ result: { markdown: '# Discovery' } })
  }
  const { pi, commands, entries } = fakePi()
  register(pi, { run: asMock<WorkflowRunner>(run) })
  const { ctx, notes } = fakeCtx(cwd, ['E.164', 'Suggest changes', 'Accept', 'Stop'], ['mention limits'])
  await command(commands, 'spec').handler('add a phone number field to users', ctx)

  expect(labels).toEqual(['enrich', 'draft spec', 'revise spec', 'discovery'])
  expect(
    must(
      prompts.find((p) => p.label === 'draft spec'),
      'draft prompt',
    ).prompt,
  ).toMatch(/Format: E.164/)
  expect(
    must(
      prompts.find((p) => p.label === 'revise spec'),
      'revise prompt',
    ).prompt,
  ).toMatch(/<feedback>\nmention limits/)
  expect(readDoc(cwd, 'phone-number-field', 'spec.md')).toBe('# Phone v2\n')
  expect(readDoc(cwd, 'phone-number-field', 'discovery.md')).toBe('# Discovery\n')
  expect(readState(cwd, 'phone-number-field')?.phase).toBe('discovered')
  expect(entries.map((e) => `${e.data.title} (${e.data.status})`)).toEqual([
    'Spec: Phone number (changes requested)',
    'Spec: Phone number (accepted)',
    'Discovery: phone-number-field (saved)',
  ])
  expect(notes.some((n) => n.includes('/plan phone-number-field'))).toBe(true)
})

test('/implement refuses a feature without a plan', async () => {
  const cwd = tmp()
  createFeature(cwd, 'phone', 'Phone')
  const { pi, commands } = fakePi()
  register(pi)
  const { ctx, notes } = fakeCtx(cwd)
  await command(commands, 'implement').handler('phone', ctx)
  expect(notes[0]).toMatch(/has no plan\.md/)
  expect(existsSync(join(featureDir(cwd, 'phone'), 'plan.md'))).toBe(false)
})

test('/plan hands off to a fresh session seeded with spec, discovery and research', async () => {
  const cwd = tmp()
  const { slug } = createFeature(cwd, 'phone', 'Phone')
  writeDoc(cwd, slug, 'spec.md', 'SPEC BODY')
  writeDoc(cwd, slug, 'discovery.md', 'DISCOVERY BODY')
  writeFileSync(join(featureDir(cwd, slug), 'research-1.md'), 'RESEARCH BODY')
  const { pi, commands } = fakePi()
  register(pi)
  const { ctx } = fakeCtx(cwd)
  let sent = ''
  ctx.newSession = async ({ withSession }) => {
    await withSession({
      sendUserMessage: async (content: string) => {
        sent = content
      },
    })
    return { cancelled: false }
  }
  await command(commands, 'plan').handler('', ctx)
  for (const part of [
    'SPEC BODY',
    'DISCOVERY BODY',
    'RESEARCH BODY',
    'ask_user',
    'sdd_save_plan with feature "phone"',
    '## Acceptance criteria',
  ]) {
    expect(sent).toContain(part)
  }
  expect(readFileSync(join(featureDir(cwd, slug), 'state.json'), 'utf8').includes('"phase": "spec"')).toBe(true)
})

test('feature names that are not slugs never reach the filesystem', async () => {
  const cwd = tmp()
  expect(() => featureDir(cwd, '../x')).toThrow(/Invalid feature name/)
  mkdirSync(join(cwd, '.pi', 'x'), { recursive: true })
  writeFileSync(join(cwd, '.pi', 'x', 'plan.md'), VALID_PLAN)
  const { pi, tools } = fakePi()
  register(pi)
  const result = await tool(tools, 'sdd_complete').execute(
    'id',
    { feature: '../x', results: [{ criterion: 'c', status: 'pass', evidence: 'e' }] },
    undefined,
    undefined,
    fakeCtx(cwd).ctx,
  )
  expect(toolText(result)).toMatch(/Unknown feature/)
  expect(readFileSync(join(cwd, '.pi', 'x', 'plan.md'), 'utf8')).toBe(VALID_PLAN)
  const saved = await tool(tools, 'sdd_save_plan').execute(
    'id',
    { feature: '../x', markdown: VALID_PLAN, decisions: [] },
    undefined,
    undefined,
    fakeCtx(cwd).ctx,
  )
  expect(toolText(saved)).toMatch(/Unknown feature/)
})

test('sdd_complete replaces earlier results instead of stacking them', async () => {
  const cwd = tmp()
  const { slug } = createFeature(cwd, 'phone', 'Phone')
  writeDoc(cwd, slug, 'plan.md', `${VALID_PLAN}\n## Verification\n\n- verdict: APPROVE\n\nreport\n`)
  const { pi, tools } = fakePi()
  register(pi)
  const complete = (status: string) =>
    tool(tools, 'sdd_complete').execute(
      'id',
      { feature: slug, results: [{ criterion: 'c', status, evidence: 'e' }] },
      undefined,
      undefined,
      fakeCtx(cwd).ctx,
    )
  await complete('fail')
  expect(readState(cwd, slug)?.phase).toBe('implementing')
  await complete('pass')
  const plan = readDoc(cwd, slug, 'plan.md') ?? ''
  expect(plan.split('## Results').length).toBe(2)
  expect(plan).toMatch(/- \[x\] c: pass - e\n$/)
  expect(plan.startsWith(VALID_PLAN.trimEnd())).toBe(true)
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepo(): string {
  const cwd = tmp()
  git(cwd, ['init', '-b', 'main'])
  git(cwd, ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'])
  return cwd
}

function writeAgentDefs(cwd: string) {
  mkdirSync(join(cwd, 'agent', 'agents'), { recursive: true })
  for (const name of ['code-reviewer', 'test-engineer', 'comment-auditor']) {
    writeFileSync(
      join(cwd, 'agent', 'agents', `${name}.md`),
      `---\nname: ${name}\ndisallowedTools: edit, write\n---\nbody`,
    )
  }
}

async function withAgentDir<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(cwd, 'agent')
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
  }
}

function verifyReports(verdictLine: 'APPROVE' | 'REQUEST CHANGES') {
  return {
    codeReviewer: {
      verdict: verdictLine,
      overview: 'Reviewed the change.',
      findings:
        verdictLine === 'APPROVE'
          ? []
          : [{ severity: 'critical', file: 'a.ts', line: 1, issue: 'null deref', fix: 'guard it' }],
      verificationStory: { testsReviewed: 'yes', buildVerified: 'yes', securityChecked: 'no' },
    },
    testEngineer: {
      verdict: verdictLine,
      overview: 'Coverage is fine.',
      findings: [],
      coverageGaps: [],
      smokeTest: { commands: ['npm test'], suite: 'passed', manual: '', blocked: [] },
    },
    commentAuditor: {
      verdict: verdictLine,
      overview: 'Comments are clean.',
      mustKill: verdictLine === 'APPROVE' ? [] : [{ file: 'a.ts', line: 3, issue: 'narration', fix: 'delete' }],
      correctness: [],
      nits: [],
      kept: [],
      skipped: [],
    },
  }
}

function featureRepo(): { cwd: string; slug: string } {
  const cwd = initRepo()
  const { slug } = createFeature(cwd, 'phone', 'Phone')
  writeDoc(cwd, slug, 'plan.md', VALID_PLAN)
  writeAgentDefs(cwd)
  writeFileSync(join(cwd, 'a.ts'), 'changed\n')
  return { cwd, slug }
}

function verifyRun(verdictLine: 'APPROVE' | 'REQUEST CHANGES') {
  return asMock<WorkflowRunner>(async () => asMock({ result: verifyReports(verdictLine) }))
}

test('sdd_verify returns the whole report as fix instructions and holds the feature in implementing', async () => {
  const { cwd, slug } = featureRepo()
  const { pi, tools, entries } = fakePi()
  register(pi, { run: verifyRun('REQUEST CHANGES') })
  await withAgentDir(cwd, async () => {
    const result = await tool(tools, 'sdd_verify').execute(
      'id',
      { feature: slug },
      undefined,
      undefined,
      fakeCtx(cwd).ctx,
    )
    const text = toolText(result)
    expect(text).toMatch(/REQUEST CHANGES \(round 1\)/)
    expect(text).toMatch(/## Verification Summary/)
    expect(text).toMatch(/null deref -> guard it/)
    expect(text).toMatch(/a\.ts:3 narration -> delete/)
  })
  expect(entries.map((e) => `${e.type} (${e.data.status})`)).toEqual(['verify-doc (REQUEST CHANGES)'])
  const plan = readDoc(cwd, slug, 'plan.md') ?? ''
  expect(plan).toMatch(/- verdict: REQUEST CHANGES\n\n## Verification Summary/)
  expect(plan).toMatch(/## Verification\n\n- verdict: REQUEST CHANGES/)
  expect(plan.split('\n## Verification\n').length - 1, 'the section is replaced, not stacked').toBe(1)
  expect(readState(cwd, slug)?.phase).toBe('implementing')
  expect(readState(cwd, slug)?.verifyRounds).toBe(1)
})

test('sdd_verify sets verifying and clears the round counter on APPROVE', async () => {
  const { cwd, slug } = featureRepo()
  const { pi, tools, entries } = fakePi()
  register(pi, { run: verifyRun('APPROVE') })
  setVerifyRounds(cwd, slug, 2)
  await withAgentDir(cwd, async () => {
    const result = await tool(tools, 'sdd_verify').execute(
      'id',
      { feature: slug },
      undefined,
      undefined,
      fakeCtx(cwd).ctx,
    )
    expect(toolText(result)).toMatch(/Verification approved/)
  })
  expect(entries.map((e) => e.data.status)).toEqual(['APPROVE'])
  expect(readDoc(cwd, slug, 'plan.md') ?? '').toMatch(/## Verification\n\n- verdict: APPROVE/)
  expect(readState(cwd, slug)?.phase).toBe('verifying')
  expect(readState(cwd, slug)?.verifyRounds).toBe(0)
})

test('sdd_verify approves without an agent pass when the scope has no changes', async () => {
  const cwd = initRepo()
  const { slug } = createFeature(cwd, 'phone', 'Phone')
  writeDoc(cwd, slug, 'plan.md', VALID_PLAN)
  git(cwd, ['add', '-A'])
  git(cwd, ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-m', 'feature'])
  const run = verifyRun('REQUEST CHANGES')
  const { pi, tools, entries } = fakePi()
  register(pi, { run })
  const result = await tool(tools, 'sdd_verify').execute(
    'id',
    { feature: slug },
    undefined,
    undefined,
    fakeCtx(cwd).ctx,
  )
  expect(toolText(result)).toMatch(/No changed files/)
  expect(entries.length, 'nothing rendered').toBe(0)
  expect(readDoc(cwd, slug, 'plan.md') ?? '').toMatch(/## Verification\n\n- verdict: APPROVE\n\nNo changed files/)
  expect(readState(cwd, slug)?.phase).toBe('verifying')
})

test('sdd_verify asks the user for a decision on the third REQUEST CHANGES round and can stop', async () => {
  const { cwd, slug } = featureRepo()
  const { pi, tools } = fakePi()
  register(pi, { run: verifyRun('REQUEST CHANGES') })
  const gate = (ctx: FakeCtx) => tool(tools, 'sdd_verify').execute('id', { feature: slug }, undefined, undefined, ctx)
  await withAgentDir(cwd, async () => {
    expect(toolText(await gate(fakeCtx(cwd).ctx))).toMatch(/round 1/)
    expect(toolText(await gate(fakeCtx(cwd).ctx))).toMatch(/round 2/)
    const stopped = fakeCtx(cwd, [], [], [false])
    const text = toolText(await gate(stopped.ctx))
    expect(text).toMatch(/Stopped after 3 REQUEST CHANGES rounds/)
    expect(text).toMatch(/ask_user/)
    expect(readState(cwd, slug)?.phase).toBe('implementing')
  })
  expect(readState(cwd, slug)?.verifyRounds).toBe(3)
})

test('sdd_verify reports a failed verification pass instead of throwing', async () => {
  const { cwd, slug } = featureRepo()
  const { pi, tools } = fakePi()
  register(pi, {
    run: asMock<WorkflowRunner>(async () => {
      throw new Error('verify was stopped')
    }),
  })
  await withAgentDir(cwd, async () => {
    const result = await tool(tools, 'sdd_verify').execute(
      'id',
      { feature: slug },
      undefined,
      undefined,
      fakeCtx(cwd).ctx,
    )
    expect(toolText(result)).toMatch(/Verification did not finish: verify was stopped/)
  })
  expect(readState(cwd, slug)?.phase, 'phase is untouched').toBe('spec')
})

test('toQuestions assigns ids that cannot collide', async () => {
  const { toQuestions } = await import('../agent/extensions/sdd/index.ts')
  const opts = [{ label: 'a' }, { label: 'b' }]
  const qs = toQuestions({
    questions: [
      { id: 'q2', header: 'A very long header', question: 'A?', options: opts },
      { id: 'x', header: 'B', question: 'B?', options: [{ label: 'only' }] },
      { id: 'q2', header: 'C', question: 'C?', options: opts, multiSelect: true },
    ],
  })
  expect(qs.map((q) => [q.id, q.header, q.multiSelect])).toEqual([
    ['q1', 'A very long header', false],
    ['q2', 'C', true],
  ])
  const schema = asMock<{ properties: { questions: { items: { required: string[] } } } }>(
    enrichArgs('r', '').questions.schema,
  )
  expect(schema.properties.questions.items.required.includes('multiSelect')).toBe(true)
})

function withSessions(ctx: FakeCtx, handlers: Map<string, FakeHandler>) {
  let sent = ''
  ctx.newSession = async ({ withSession }) => {
    await handler(handlers, 'session_start')({ reason: 'new' }, ctx)
    await withSession({
      sendUserMessage: async (content: string) => {
        sent = content
      },
    })
    return { cancelled: false }
  }
  ctx.ui.confirm = async () => false
  return () => sent
}

test('/implement marks the feature implementing only once the new session starts', async () => {
  const cwd = tmp()
  const { slug } = createFeature(cwd, 'phone', 'Phone')
  writeDoc(cwd, slug, 'plan.md', VALID_PLAN)
  const { pi, commands, handlers, entries, active } = fakePi()
  const switched: unknown[] = []
  pi.getThinkingLevel = () => 'medium'
  pi.setModel = async (m: unknown) => switched.push(m) > 0
  pi.setThinkingLevel = (level: string) => {
    switched.push(level)
  }
  register(pi)
  const { ctx } = fakeCtx(cwd)
  const selected = { provider: 'p', id: 'selected' }
  ctx.model = selected
  ctx.modelRegistry.find = (provider: string, id: string) =>
    provider === 'p' && id === 'selected' ? selected : undefined
  const sent = withSessions(ctx, handlers)
  await command(commands, 'implement').handler(slug, ctx)
  expect(switched, 'the new session keeps the selected model and thinking level').toEqual([selected, 'medium'])
  expect(readState(cwd, slug)?.phase).toBe('implementing')
  expect(sent()).toMatch(/sdd_complete with feature "phone"/)
  expect(active()).toEqual(['read', 'sdd_complete', 'sdd_verify'])
  expect(entries.at(-1)).toEqual({ type: 'sdd-session', data: { kind: 'implement', slug } })

  setPhase(cwd, slug, 'done')
  let started = false
  ctx.newSession = async () => {
    started = true
    return { cancelled: false }
  }
  await command(commands, 'implement').handler(slug, ctx)
  expect(started, 'a done feature needs confirmation').toBe(false)
})

test('a failed session switch does not leak the handoff into the next session', async () => {
  const cwd = tmp()
  const { slug } = createFeature(cwd, 'phone', 'Phone')
  writeDoc(cwd, slug, 'spec.md', 'SPEC')
  const { pi, commands, handlers, entries } = fakePi()
  register(pi)
  const { ctx, notes } = fakeCtx(cwd)
  ctx.newSession = async () => {
    throw new Error('boom')
  }
  await command(commands, 'plan').handler(slug, ctx)
  expect(notes.some((n) => n.includes('/plan: boom'))).toBe(true)
  await handler(handlers, 'session_start')({ reason: 'new' }, ctx)
  expect(entries.filter((e) => e.type === 'sdd-session').length).toBe(0)
})

test('commands refuse to run without UI and report handler errors', async () => {
  const cwd = tmp()
  const { slug } = createFeature(cwd, 'phone', 'Phone')
  writeDoc(cwd, slug, 'spec.md', 'SPEC')
  const { pi, commands } = fakePi()
  register(pi, { run: asMock<WorkflowRunner>(async () => asMock({ result: { markdown: '' } })) })
  const headless = fakeCtx(cwd)
  headless.ctx.hasUI = false
  await command(commands, 'sdd').handler('', headless.ctx)
  expect(headless.notes[0]).toMatch(/needs the interactive UI/)
  const { ctx, notes } = fakeCtx(cwd)
  await command(commands, 'discover').handler(slug, ctx)
  expect(notes[0]).toMatch(/\/discover: Discovery returned no report/)
  await command(commands, 'plan').handler('nope', ctx)
  expect(notes[1]).toMatch(/Unknown feature "nope"/)
})

interface WidgetComponent {
  render(width: number): string[]
  dispose?(): void
}

type WidgetFactory = (tui: TUI, theme: Theme) => WidgetComponent

const plainPaint = { fg: (_c: string, t: string) => t, bold: (t: string) => t }

test('runSdd stops on Escape, rejects empty results and clears its widget', async () => {
  const { runSdd } = await import('../agent/extensions/sdd/runner.ts')
  const widgets: unknown[] = []
  let onInput: ((data: string) => unknown) | undefined
  const ctx = asMock<ExtensionContext>({
    cwd: tmp(),
    mode: 'tui',
    hasUI: true,
    model: { provider: 'p', id: 'm' },
    ui: {
      setWidget: (_k: string, v: unknown) => widgets.push(v),
      onTerminalInput: (fn: (data: string) => unknown) => {
        onInput = fn
        return () => {
          onInput = undefined
        }
      },
    },
  })
  let seen: WorkflowRunOptions | undefined
  const escaped = runSdd(
    ctx,
    'script',
    {},
    {
      label: 'demo',
      maxAgents: 1,
      run: async (_s, options) => {
        seen = options
        options.onAgentStart?.({ id: '1', label: 'agent one', prompt: '' })
        expect(onInput?.('\u001b')).toEqual({ consume: true })
        return asMock<WorkflowRunResult<unknown>>({ result: {} })
      },
    },
  )
  await expect(escaped).rejects.toThrow(/demo was stopped/)
  expect(seen?.mainModel).toBe('p/m')
  expect(seen?.providerMiddlewareExtensions).toEqual(['pi-web-access'])
  expect(must(seen?.agentRegistry, 'agent registry').has('sdd-scout')).toBe(true)
  expect(onInput, 'escape listener removed').toBeUndefined()
  expect(widgets.at(-1), 'widget cleared').toBeUndefined()
  const widget = asMock<WidgetFactory>(widgets[0])(asMock<TUI>({ requestRender: () => {} }), asMock<Theme>(plainPaint))
  expect(widget.render(60).some((l) => l.includes('agent one'))).toBe(true)
  widget.dispose?.()
  await expect(
    runSdd(
      ctx,
      's',
      {},
      { label: 'empty', maxAgents: 1, run: async () => asMock<WorkflowRunResult<unknown>>({ result: null }) },
    ),
  ).rejects.toThrow(/empty returned no result/)
})

test('plan sections ignore headings inside code fences', () => {
  const plan = VALID_PLAN.replace(
    '- `mise run test` - unit tests',
    '```bash\n# run everything\nmise run test\n```\n- `mise run test` - unit tests',
  )
  expect(validatePlan(plan)).toEqual([])
  expect(validatePlan(VALID_PLAN.replace('## Tasks', '## tasks'))).toEqual([])
})

test('progress widget draws a bordered box with a spinner, recent results and stats', async () => {
  const { renderProgress, formatTokens } = await import('../agent/extensions/sdd/progress.ts')
  const { visibleWidth } = await import('@earendil-works/pi-tui')
  const running = new Map<string, string>(
    Array.from({ length: 12 }, (_, i) => [`r${i}`, `probe ${i + 1}: ${'long title '.repeat(6)}`]),
  )
  const state: ProgressState = {
    label: 'discovery',
    phase: 'Probe',
    running,
    finished: [
      { label: 'probe 0: ok', failed: false },
      { label: 'probe x', failed: true },
    ],
    done: 1,
    failed: 1,
    tokens: 632284,
  }
  const lines = renderProgress(state, plainPaint, 50, 3)
  expect(lines.filter((l) => visibleWidth(l) !== 50)).toEqual([])
  expect(lines[0]).toMatch(/^╭─ discovery · Probe ─+╮$/)
  expect(stripAnsi(lines.at(-1) ?? ''), 'footer is cut to fit').toMatch(
    /^╰─ 1 done · 1 failed · 12 running · 632k tokens …╯$/,
  )
  expect(renderProgress(state, plainPaint, 80, 0).at(-1) ?? '').toMatch(
    /^╰─ 1 done · 1 failed · 12 running · 632k tokens · esc to stop ─+╯$/,
  )
  expect(lines[1]).toMatch(/│ ✓ probe 0: ok/)
  expect(lines[2]).toMatch(/│ ✗ probe x/)
  expect(lines[3]).toMatch(/│ ⠸ probe 1: long title/)
  expect(lines.length, '8 rows plus 2 borders').toBe(10)
  expect(lines[8]).toMatch(/\+7 more running/)
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(1_250_000)).toBe('1.3M')
  const empty = renderProgress(
    { ...state, running: new Map(), finished: [], done: 0, failed: 0, tokens: 0 },
    plainPaint,
    30,
    0,
  )
  expect(empty[1]).toMatch(/⠋ starting/)
})

test('formatTokens rounds across unit boundaries', async () => {
  const { formatTokens } = await import('../agent/extensions/sdd/progress.ts')
  expect([999, 1_000, 999_499, 999_600, 1_000_000].map(formatTokens)).toEqual(['999', '1k', '999k', '1.0M', '1.0M'])
})

test('progress widget without the TUI pushes plain bordered lines', async () => {
  const { progressWidget } = await import('../agent/extensions/sdd/progress.ts')
  const widgets: unknown[] = []
  const ctx = asMock<ExtensionContext>({
    mode: 'rpc',
    hasUI: true,
    ui: { setWidget: (_k: string, v: unknown) => widgets.push(v) },
  })
  const view = progressWidget(ctx, 'discovery')
  expect(asMock<string[]>(widgets[0])[1]).toMatch(/starting/)
  view.options.onAgentStart({ id: '1', label: 'probe 1' })
  view.options.onAgentEnd({ id: '1', label: 'probe 1', tokens: 1500 })
  const last = asMock<string[]>(widgets.at(-1))
  expect(last.every((l) => l.length === 80)).toBe(true)
  expect(last.join('\n')).toMatch(/✓ probe 1[\s\S]*1 done · 0 running · 2k tokens/)
  view.clear()
  expect(widgets.at(-1)).toBeUndefined()
})

test('progress widget spinner redraws on a timer and stops on dispose', async () => {
  vi.useFakeTimers()
  try {
    const { progressWidget } = await import('../agent/extensions/sdd/progress.ts')
    let factory: WidgetFactory | undefined
    const ctx = asMock<ExtensionContext>({
      mode: 'tui',
      hasUI: true,
      ui: {
        setWidget: (_k: string, v: unknown) => {
          factory = asMock<WidgetFactory>(v)
        },
      },
    })
    const view = progressWidget(ctx, 'discovery')
    let renders = 0
    const widget = must(factory, 'widget factory')(
      asMock<TUI>({ requestRender: () => renders++ }),
      asMock<Theme>(plainPaint),
    )
    const first = widget.render(40)[1]
    vi.advanceTimersByTime(80)
    expect(renders).toBe(1)
    expect(widget.render(40)[1], 'spinner frame advanced').not.toBe(first)
    view.options.onAgentStart({ id: '1', label: 'probe 1' })
    expect(renders, 'events redraw immediately').toBe(2)
    widget.dispose?.()
    vi.advanceTimersByTime(800)
    expect(renders, 'no redraws after dispose').toBe(2)
  } finally {
    vi.useRealTimers()
  }
})

test('every SDD workflow agent runs read-only and is told not to write files', async () => {
  const runs = [
    await runStub(
      SINGLE_SCRIPT,
      { prompt: 'p', label: 'draft spec', tier: 'small', schema: { type: 'object' } },
      () => ({}),
    ),
    await runStub(ENRICH_SCRIPT, enrichArgs('r', ''), () => ({})),
    await runStub(DISCOVERY_SCRIPT, discoveryArgs('SPEC', undefined, ''), (c) =>
      c.label === 'synthesize' ? { markdown: 'm' } : { probes: [], findings: [] },
    ),
    await runStub(RESEARCH_SCRIPT, researchArgs('t', 'SPEC', undefined), () => ({
      queries: ['q'],
      sources: [],
      supported: [],
    })),
  ]
  const calls = runs.flatMap((r) => r.calls)
  expect(calls.length).toBe(11)
  expect(calls.filter((c) => !c.scout).map((c) => c.label)).toEqual([])
  const synth = runs[2]?.calls.find((c) => c.label === 'synthesize')
  expect(synth?.prompt ?? '').toMatch(/return it in the markdown field\. Do not create or edit any file/)
  expect(synth?.prompt ?? '').not.toMatch(/Write discovery\.md/)
})
