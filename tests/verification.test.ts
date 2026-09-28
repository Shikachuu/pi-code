import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadAgentRegistry, parseWorkflowScript, runWorkflow } from '@quintinshaw/pi-dynamic-workflows'
import { expect, test } from 'vitest'

import type { WorkflowRunner } from '../agent/extensions/sdd/runner.ts'
import register from '../agent/extensions/verification/index.ts'
import { mergeFindings, renderSummary, verdict } from '../agent/extensions/verification/report.ts'
import { type Scope, formatScope, isLarge, resolveScope } from '../agent/extensions/verification/scope.ts'
import { VERIFY_SCRIPT, verifyArgs } from '../agent/extensions/verification/workflow.ts'
import { asMock, git, must, reports } from './helpers.ts'

const AGENT_DIR = join(import.meta.dirname, '..', 'agent')

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'verify-'))
}

function initRepo(): string {
  const cwd = tmp()
  git(cwd, ['init', '-b', 'main'])
  git(cwd, ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'])
  return cwd
}

function commitFile(cwd: string, path: string, content: string, message: string) {
  const full = join(cwd, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  git(cwd, ['add', path])
  git(cwd, ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-m', message])
}

test('resolveScope throws on a non-git directory', () => {
  const cwd = tmp()
  expect(() => resolveScope(cwd, undefined)).toThrow(/not a git repository/)
})

test('default scope is empty when there are no changes', () => {
  const cwd = initRepo()
  const scope = resolveScope(cwd, undefined)
  expect(scope.kind).toBe('default')
  expect(scope.files).toEqual([])
})

test('default scope combines committed, uncommitted and untracked changes vs main', () => {
  const cwd = initRepo()
  git(cwd, ['checkout', '-b', 'feature'])
  commitFile(cwd, 'a.ts', 'committed\n', 'add a')
  writeFileSync(join(cwd, 'a.ts'), 'committed\nmore\n')
  writeFileSync(join(cwd, 'untracked.ts'), 'new\n')
  const scope = resolveScope(cwd, undefined)
  expect(scope.kind).toBe('default')
  expect(scope.base).toBe('main')
  expect(scope.files).toEqual(['a.ts', 'untracked.ts'])
  expect(scope.commands.includes('git diff main...HEAD')).toBe(true)
})

test('range target diffs a specific commit range', () => {
  const cwd = initRepo()
  commitFile(cwd, 'a.ts', 'a\n', 'add a')
  commitFile(cwd, 'b.ts', 'b\n', 'add b')
  const scope = resolveScope(cwd, 'HEAD~1..HEAD')
  expect(scope.kind).toBe('range')
  expect(scope.files).toEqual(['b.ts'])
  expect(scope.commands).toEqual(['git diff HEAD~1..HEAD'])
})

test('a branch ref diffs against the base branch', () => {
  const cwd = initRepo()
  git(cwd, ['checkout', '-b', 'feature'])
  commitFile(cwd, 'a.ts', 'a\n', 'add a')
  git(cwd, ['checkout', 'main'])
  const scope = resolveScope(cwd, 'feature')
  expect(scope.kind).toBe('ref')
  expect(scope.files).toEqual(['a.ts'])
})

test('a changed path target diffs just that path', () => {
  const cwd = initRepo()
  commitFile(cwd, 'a.ts', 'a\n', 'add a')
  writeFileSync(join(cwd, 'a.ts'), 'a\nchanged\n')
  const scope = resolveScope(cwd, 'a.ts')
  expect(scope.kind).toBe('path')
  expect(scope.files).toEqual(['a.ts'])
  expect(scope.wholeFiles).toEqual([])
})

test('an unchanged path target reports whole files to read', () => {
  const cwd = initRepo()
  commitFile(cwd, 'a.ts', 'a\n', 'add a')
  const scope = resolveScope(cwd, 'a.ts')
  expect(scope.kind).toBe('path')
  expect(scope.files).toEqual([])
  expect(scope.wholeFiles).toEqual(['a.ts'])
})

test('falls back to the working tree when there is no main or master branch', () => {
  const cwd = tmp()
  git(cwd, ['init', '-b', 'trunk'])
  git(cwd, ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'])
  writeFileSync(join(cwd, 'a.ts'), 'new\n')
  const scope = resolveScope(cwd, undefined)
  expect(scope.kind).toBe('fallback')
  expect(scope.files).toEqual(['a.ts'])
  expect(scope.notes.length > 0).toBe(true)
})

test('an invalid target is rejected before any scope resolution', () => {
  const cwd = initRepo()
  expect(() => resolveScope(cwd, '-x')).toThrow(/invalid target "-x"/)
  expect(() => resolveScope(cwd, 'no-such-ref')).toThrow(/unknown ref or path "no-such-ref"/)
})

test('detectBase falls back to master and treats the base branch itself as the default scope', () => {
  const master = tmp()
  git(master, ['init', '-b', 'master'])
  git(master, ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'])
  git(master, ['checkout', '-b', 'feature'])
  commitFile(master, 'a.ts', 'committed\n', 'add a')
  writeFileSync(join(master, 'a.ts'), 'committed\nmore\n')
  const scope = resolveScope(master, undefined)
  expect(scope.kind).toBe('default')
  expect(scope.base).toBe('master')
  expect(scope.files).toEqual(['a.ts'])
  expect(scope.commands[0]).toMatch(/^git diff master\.\.\.HEAD$/)

  const main = initRepo()
  commitFile(main, 'a.ts', 'committed\n', 'add a')
  writeFileSync(join(main, 'a.ts'), 'committed\nmore\n')
  expect(resolveScope(main, 'main').kind, 'naming the base returns the default scope').toBe('default')
})

test('an invalid range falls back to the working tree with a note instead of reviewing a wrong scope', () => {
  const cwd = initRepo()
  writeFileSync(join(cwd, 'a.ts'), 'new\n')
  const scope = resolveScope(cwd, 'bad..ref')
  expect(scope.kind).toBe('fallback')
  expect(scope.files).toEqual(['a.ts'])
  expect(scope.notes.join('\n')).toMatch(/unknown ref "bad" in range "bad..ref"/)
  expect(scope.commands).toEqual(['git diff HEAD', 'git status --short'])
})

test('isLarge flags scopes over the file or line thresholds', () => {
  expect(isLarge({ files: 5, insertions: 10, deletions: 10 })).toBe(false)
  expect(isLarge({ files: 101, insertions: 0, deletions: 0 })).toBe(true)
  expect(isLarge({ files: 1, insertions: 6000, deletions: 5000 })).toBe(true)
})

test('formatScope renders target, files and commands', () => {
  const scope: Scope = {
    target: 'a.ts',
    kind: 'path',
    files: ['a.ts'],
    wholeFiles: [],
    commands: ['git diff -- a.ts'],
    stats: { files: 1, insertions: 1, deletions: 0 },
    notes: [],
  }
  const text = formatScope(scope)
  expect(text).toMatch(/Target: a\.ts/)
  expect(text).toMatch(/a\.ts/)
  expect(text).toMatch(/git diff -- a\.ts/)
})

test('verify workflow script parses', () => {
  expect(parseWorkflowScript(VERIFY_SCRIPT).meta.name).toBe('verify')
})

function baseScope(): Scope {
  return {
    target: 'main',
    kind: 'default',
    base: 'main',
    files: ['a.ts'],
    wholeFiles: [],
    commands: ['git diff main...HEAD'],
    stats: { files: 1, insertions: 1, deletions: 0 },
    notes: [],
  }
}

interface AgentCall {
  label?: string | undefined
  tier?: string | undefined
  readOnly?: boolean | undefined
  prompt: string
}

test('verify runs exactly three agent calls with identical scope, tier medium and read-only agentTypes', async () => {
  const calls: AgentCall[] = []
  const scope = baseScope()
  const registry = loadAgentRegistry('', {
    projectDir: '/does/not/exist',
    userDir: join(AGENT_DIR, 'agents'),
    legacyUserDir: '/does/not/exist',
  })
  const result = await runWorkflow(VERIFY_SCRIPT, {
    args: verifyArgs(scope),
    persistLogs: false,
    agentRegistry: registry,
    agent: {
      run: async (prompt, options) => {
        const deny = options?.disallowedToolNames ?? []
        calls.push({
          label: options?.label,
          tier: options?.tier,
          readOnly: deny.includes('edit') && deny.includes('write'),
          prompt,
        })
        return null
      },
    },
  })
  expect(calls.length).toBe(3)
  expect(calls.map((c) => c.label).sort()).toEqual(['code-reviewer', 'comment-auditor', 'test-engineer'])
  expect(calls.every((c) => c.tier === 'medium')).toBe(true)
  expect(
    calls.every((c) => c.readOnly),
    'every agentType denies edit and write',
  ).toBe(true)
  const scopeText = formatScope(scope)
  expect(calls.every((c) => c.prompt.includes(scopeText))).toBe(true)
  expect(JSON.stringify(result.result)).toBe(
    JSON.stringify({ codeReviewer: null, testEngineer: null, commentAuditor: null }),
  )
})

test('mergeFindings dedupes at file:line, keeps the higher severity, and attributes [all]', () => {
  const r = reports({
    codeReviewer: {
      ...must(reports().codeReviewer, 'code reviewer'),
      findings: [{ severity: 'nit', category: 'test-category', file: 'a.ts', line: 10, issue: 'naming', fix: '' }],
    },
    testEngineer: {
      ...must(reports().testEngineer, 'test engineer'),
      findings: [
        {
          severity: 'important',
          category: 'test-category',
          file: 'a.ts',
          line: 10,
          issue: 'no test',
          fix: 'add a test',
        },
      ],
    },
    commentAuditor: {
      ...must(reports().commentAuditor, 'comment auditor'),
      mustKill: [{ file: 'a.ts', line: 10, issue: 'dead comment' }],
    },
  })
  const merged = mergeFindings(r)
  const first = must(merged[0], 'merged finding')
  expect(merged.length).toBe(1)
  expect(first.severity).toBe('important')
  expect(first.file).toBe('a.ts')
  expect(first.line).toBe(10)
  expect(first.agents.sort()).toEqual(['code-reviewer', 'comment-auditor', 'test-engineer'])
  expect(first.issue.split('; ').sort()).toEqual(['dead comment', 'naming', 'no test'])
  expect(first.fix).toBe('add a test')
})

test('mergeFindings appends distinct issue text once and skips duplicates', () => {
  const r = reports({
    codeReviewer: {
      ...must(reports().codeReviewer, 'code reviewer'),
      findings: [{ severity: 'nit', category: 'test-category', file: 'a.ts', line: 1, issue: 'same', fix: '' }],
    },
    testEngineer: {
      ...must(reports().testEngineer, 'test engineer'),
      findings: [{ severity: 'nit', category: 'test-category', file: 'a.ts', line: 1, issue: 'same', fix: '' }],
    },
  })
  expect(must(mergeFindings(r)[0], 'merged finding').issue).toBe('same')
})

test('mergeFindings joins two distinct non-empty fixes', () => {
  const r = reports({
    codeReviewer: {
      ...must(reports().codeReviewer, 'code reviewer'),
      findings: [{ severity: 'nit', category: 'test-category', file: 'a.ts', line: 1, issue: 'x', fix: 'fix one' }],
    },
    testEngineer: {
      ...must(reports().testEngineer, 'test engineer'),
      findings: [{ severity: 'nit', category: 'test-category', file: 'a.ts', line: 1, issue: 'x', fix: 'fix two' }],
    },
  })
  expect(must(mergeFindings(r)[0], 'merged finding').fix).toBe('fix one; fix two')
})

test('verdict is REQUEST CHANGES when only test-engineer or comment-auditor requests changes', () => {
  const base = reports()
  expect(
    verdict(reports({ testEngineer: { ...must(base.testEngineer, 'test engineer'), verdict: 'REQUEST CHANGES' } }), []),
  ).toBe('REQUEST CHANGES')
  expect(
    verdict(
      reports({ commentAuditor: { ...must(base.commentAuditor, 'comment auditor'), verdict: 'REQUEST CHANGES' } }),
      [],
    ),
  ).toBe('REQUEST CHANGES')
})

test('renderSummary labels a finding flagged by all three agents as [all]', () => {
  const finding = (issue: string) => ({
    severity: 'nit' as const,
    category: 'test-category',
    file: 'a.ts',
    line: 5,
    issue,
    fix: '',
  })
  const md = renderSummary(
    baseScope(),
    reports({
      codeReviewer: { ...must(reports().codeReviewer, 'code reviewer'), findings: [finding('x')] },
      testEngineer: { ...must(reports().testEngineer, 'test engineer'), findings: [finding('y')] },
      commentAuditor: {
        ...must(reports().commentAuditor, 'comment auditor'),
        nits: [{ file: 'a.ts', line: 5, issue: 'z' }],
      },
    }),
  )
  expect(md).toMatch(/### Nits\n- \[all\] \(test-category\) a\.ts:5 x; y; z/)
})

test('comment-auditor categories map to severities', () => {
  const r = reports({
    commentAuditor: {
      ...must(reports().commentAuditor, 'comment auditor'),
      correctness: [{ file: 'a.ts', line: 1, issue: 'unjustified ts-ignore' }],
      mustKill: [{ file: 'b.ts', line: 2, issue: 'narration' }],
      nits: [{ file: 'c.ts', line: 3, issue: 'could tighten' }],
    },
  })
  const merged = mergeFindings(r)
  const bySev = Object.fromEntries(merged.map((f) => [f.file, f.severity]))
  expect(bySev['a.ts']).toBe('critical')
  expect(bySev['b.ts']).toBe('important')
  expect(bySev['c.ts']).toBe('nit')
})

test('comment-auditor buckets become the category of their findings', () => {
  const r = reports({
    commentAuditor: {
      ...must(reports().commentAuditor, 'comment auditor'),
      correctness: [{ file: 'a.ts', line: 1, issue: 'unjustified ts-ignore' }],
      mustKill: [{ file: 'b.ts', line: 2, issue: 'narration' }],
      nits: [{ file: 'c.ts', line: 3, issue: 'could tighten' }],
    },
  })
  const byFile = Object.fromEntries(mergeFindings(r).map((f) => [f.file, f.category]))
  expect(byFile).toEqual({ 'a.ts': 'comment-correctness', 'b.ts': 'comment-must-kill', 'c.ts': 'comment-nit' })
})

test('mergeFindings keeps the first category when agents flag the same line', () => {
  const [merged] = mergeFindings(
    reports({
      codeReviewer: {
        ...must(reports().codeReviewer, 'code reviewer'),
        findings: [{ severity: 'nit', category: 'naming', file: 'a.ts', line: 1, issue: 'x', fix: '' }],
      },
      testEngineer: {
        ...must(reports().testEngineer, 'test engineer'),
        findings: [
          { severity: 'important', category: 'untested-error-path', file: 'a.ts', line: 1, issue: 'y', fix: '' },
        ],
      },
    }),
  )
  expect(merged?.category).toBe('naming')
  expect(merged?.severity).toBe('important')
})

test('verifyArgs adds prior findings only to the agent that raised them', () => {
  const scope = baseScope()
  const plain = verifyArgs(scope)
  expect(verifyArgs(scope, [])).toEqual(plain)
  for (const args of Object.values(plain)) expect(args.prompt).not.toContain('<prior-findings>')

  const args = verifyArgs(scope, [
    {
      severity: 'critical',
      category: 'null-deref',
      file: 'a.ts',
      line: 1,
      issue: 'null deref',
      fix: '',
      agents: ['code-reviewer'],
    },
    {
      severity: 'important',
      category: 'comment-must-kill',
      file: 'b.ts',
      line: 2,
      issue: 'narration',
      fix: '',
      agents: ['comment-auditor'],
    },
  ])
  expect(args.codeReviewer.prompt).toContain(
    '<prior-findings>\n- [critical] (null-deref) a.ts:1 null deref\n</prior-findings>',
  )
  expect(args.codeReviewer.prompt).toMatch(/Review the full scope as usual/)
  expect(args.commentAuditor.prompt).toContain('- [important] (comment-must-kill) b.ts:2 narration')
  expect(args.commentAuditor.prompt).not.toContain('a.ts:1')
  expect(args.testEngineer.prompt).toBe(plain.testEngineer.prompt)
})

test('verifyArgs gives a finding raised by two agents to both of them', () => {
  const args = verifyArgs(baseScope(), [
    {
      severity: 'important',
      category: 'untested-error-path',
      file: 'a.ts',
      line: 7,
      issue: 'no test',
      fix: '',
      agents: ['code-reviewer', 'test-engineer'],
    },
  ])
  expect(args.codeReviewer.prompt).toContain('(untested-error-path) a.ts:7 no test')
  expect(args.testEngineer.prompt).toContain('(untested-error-path) a.ts:7 no test')
  expect(args.commentAuditor.prompt).not.toContain('<prior-findings>')
})

test('verdict is APPROVE only with no critical/important findings, every agent reporting and no agent requesting changes', () => {
  expect(verdict(reports(), [])).toBe('APPROVE')
  expect(
    verdict(reports(), [
      {
        severity: 'important',
        category: 'test-category',
        file: 'a.ts',
        line: 1,
        issue: 'x',
        fix: '',
        agents: ['code-reviewer'],
      },
    ]),
  ).toBe('REQUEST CHANGES')
  expect(
    verdict(reports(), [
      {
        severity: 'nit',
        category: 'test-category',
        file: 'a.ts',
        line: 1,
        issue: 'x',
        fix: '',
        agents: ['code-reviewer'],
      },
    ]),
  ).toBe('APPROVE')
  expect(verdict(reports({ testEngineer: null }), [])).toBe('REQUEST CHANGES')
  expect(
    verdict(
      reports({ codeReviewer: { ...must(reports().codeReviewer, 'code reviewer'), verdict: 'REQUEST CHANGES' } }),
      [],
    ),
  ).toBe('REQUEST CHANGES')
})

test('renderSummary contains every section in order with none for empty lists', () => {
  const md = renderSummary(baseScope(), reports())
  const headings = [
    '## Verification Summary',
    '**Verdict:**',
    '**Scope:**',
    '**Overview:**',
    '### Critical',
    '### Important',
    '### Nits',
    '### Coverage Gaps',
    '### Smoke Test Result',
    '### Verification Story',
    '### Comment Audit',
  ]
  let cursor = -1
  for (const h of headings) {
    const idx = md.indexOf(h)
    expect(idx > cursor, `expected "${h}" after previous heading`).toBe(true)
    cursor = idx
  }
  expect(md).toMatch(/### Critical\n- none/)
  expect(md).toMatch(/### Important\n- none/)
})

test('renderSummary reports a missing agent by name', () => {
  const md = renderSummary(baseScope(), reports({ commentAuditor: null }))
  expect(md).toMatch(/comment-auditor did not return a report/)
})

test('renderSummary handles all three reports missing', () => {
  const md = renderSummary(baseScope(), { codeReviewer: null, testEngineer: null, commentAuditor: null })
  expect(md).toMatch(/\*\*Verdict:\*\* REQUEST CHANGES/)
  expect(md).toContain('No reports were returned.')
  expect(md).toMatch(/code-reviewer did not return a report/)
  expect(md).toMatch(/test-engineer did not return a report/)
  expect(md).toMatch(/comment-auditor did not return a report/)
})

test('renderSummary reports missing test-engineer and code-reviewer under both their headings', () => {
  const noEngineer = renderSummary(baseScope(), reports({ testEngineer: null }))
  expect(noEngineer).toMatch(/### Coverage Gaps \(from test-engineer\)\ntest-engineer did not return a report/)
  expect(noEngineer).toMatch(/### Smoke Test Result \(from test-engineer\)\ntest-engineer did not return a report/)
  expect(noEngineer).toMatch(/\*\*Verdict:\*\* REQUEST CHANGES/)

  const noReviewer = renderSummary(baseScope(), reports({ codeReviewer: null }))
  expect(noReviewer).toMatch(/### Verification Story \(from code-reviewer\)\ncode-reviewer did not return a report/)
  expect(noReviewer).toMatch(/\*\*Verdict:\*\* REQUEST CHANGES/)
})

test('renderSummary renders finding arrows, blocked smoke tests and audit arrows', () => {
  const md = renderSummary(
    baseScope(),
    reports({
      codeReviewer: {
        ...must(reports().codeReviewer, 'code reviewer'),
        findings: [
          { severity: 'critical', category: 'test-category', file: 'a.ts', line: 3, issue: 'bad', fix: 'fix it' },
        ],
      },
      testEngineer: {
        ...must(reports().testEngineer, 'test engineer'),
        smokeTest: { commands: [], suite: '', manual: '', blocked: ['network'] },
      },
      commentAuditor: {
        ...must(reports().commentAuditor, 'comment auditor'),
        mustKill: [{ file: 'b.ts', line: 2, issue: 'narration', fix: 'delete' }],
        kept: [{ file: 'c.ts', line: 1, issue: 'good', fix: 'keep' }],
      },
    }),
  )
  expect(md).toMatch(/### Critical\n- \[code-reviewer\] \(test-category\) a\.ts:3 bad -> fix it/)
  expect(md).toMatch(/- Commands: none\n- Suite: none\n- Manual: none\n- Blocked: network/)
  expect(md).toMatch(/\*\*MUST KILL\*\*\n- b\.ts:2 narration -> delete/)
  expect(md).toMatch(/\*\*Kept\*\*\n- c\.ts:1 good - keep/)
})

test('renderSummary renders every populated list under its own heading', () => {
  const md = renderSummary(
    baseScope(),
    reports({
      codeReviewer: {
        ...must(reports().codeReviewer, 'code reviewer'),
        findings: [
          { severity: 'important', category: 'test-category', file: 'i.ts', line: 4, issue: 'missing', fix: 'add it' },
        ],
      },
      testEngineer: {
        ...must(reports().testEngineer, 'test engineer'),
        coverageGaps: ['gap one', 'gap two'],
        findings: [{ severity: 'nit', category: 'test-category', file: 'n.ts', line: 5, issue: 'tidy', fix: '' }],
      },
      commentAuditor: {
        ...must(reports().commentAuditor, 'comment auditor'),
        mustKill: [{ file: 'm.ts', line: 2, issue: 'narration', fix: 'delete' }],
        correctness: [{ file: 'c.ts', line: 1, issue: 'wrong', fix: 'fix' }],
        kept: [{ file: 'k.ts', line: 3, issue: 'good', fix: 'keep' }],
        skipped: ['not our code'],
      },
    }),
  )
  expect(md).toMatch(/### Important\n- \[code-reviewer\] \(test-category\) i\.ts:4 missing -> add it/)
  expect(md).toMatch(/### Nits\n- \[test-engineer\] \(test-category\) n\.ts:5 tidy/)
  expect(md).toMatch(/### Coverage Gaps \(from test-engineer\)\n- gap one\n- gap two/)
  expect(md).toMatch(/\*\*MUST KILL\*\*\n- m\.ts:2 narration -> delete/)
  expect(md).toMatch(/\*\*Correctness\*\*\n- c\.ts:1 wrong -> fix/)
  expect(md).toMatch(/\*\*Kept\*\*\n- k\.ts:3 good - keep/)
  expect(md).toMatch(/\*\*Skipped\*\*\n- not our code/)
})

test('all three agentTypes are registered, read-only, and use the expected thinking level', () => {
  const registry = loadAgentRegistry('', {
    projectDir: '/does/not/exist',
    userDir: join(AGENT_DIR, 'agents'),
    legacyUserDir: '/does/not/exist',
  })
  const expected: Record<string, string> = { 'code-reviewer': 'low', 'test-engineer': 'low', 'comment-auditor': 'high' }
  for (const [name, thinking] of Object.entries(expected)) {
    const def = must(registry.get(name), `${name} agent`)
    expect(def.disallowedTools?.includes('edit')).toBe(true)
    expect(def.disallowedTools?.includes('write')).toBe(true)
    expect(def.thinking).toBe(thinking)
  }
})

interface FakeCtx {
  cwd: string
  mode: 'rpc'
  hasUI: boolean
  ui: { notify(message: string, level?: string): void; setWidget(key: string, content: unknown): void }
}

interface FakeCommand {
  handler(args: string, ctx: FakeCtx): Promise<void>
}

interface RenderedComponent {
  children?: unknown[]
}

type FakeTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string }

interface FakeRenderer {
  (
    entry: { data: Record<string, string> },
    options: { expanded: boolean },
    theme: FakeTheme,
  ): RenderedComponent | undefined
}

type Entry = { type: string; data: Record<string, string> }

function fakePi() {
  const commands = new Map<string, FakeCommand>()
  const entries: Entry[] = []
  const messages: { display?: boolean; customType?: string }[] = []
  const renderers = new Map<string, FakeRenderer>()
  const pi = {
    registerCommand: (name: string, cmd: FakeCommand) => commands.set(name, cmd),
    registerEntryRenderer: (type: string, renderer: FakeRenderer) => renderers.set(type, renderer),
    appendEntry: (type: string, data: Record<string, string>) => entries.push({ type, data }),
    sendMessage: (message: { display?: boolean; customType?: string }) => messages.push(message),
  }
  return { pi: asMock<ExtensionAPI>(pi), commands, entries, messages, renderers }
}

function fakeCtx(cwd: string) {
  const notes: { message: string; level: string }[] = []
  const ctx: FakeCtx = {
    cwd,
    mode: 'rpc',
    hasUI: true,
    ui: {
      notify: (message: string, level = 'info') => notes.push({ message, level }),
      setWidget: () => {},
    },
  }
  return { notes, ctx }
}

const command = (commands: Map<string, FakeCommand>, name: string): FakeCommand =>
  must(commands.get(name), `${name} command`)
const entry = (entries: Entry[], i: number): Entry => must(entries[i], 'entry')

test('/verify reports nothing to verify when the scope is empty', async () => {
  const { pi, commands } = fakePi()
  register(pi)
  const cwd = initRepo()
  const { ctx, notes } = fakeCtx(cwd)
  await command(commands, 'verify').handler('', ctx)
  expect(notes.some((n) => /Nothing to verify/.test(n.message))).toBe(true)
})

test('/verify surfaces a scope resolution error instead of throwing', async () => {
  const { pi, commands } = fakePi()
  register(pi)
  const { ctx, notes } = fakeCtx(tmp())
  await command(commands, 'verify').handler('', ctx)
  expect(
    notes.some((n) => n.level === 'error' && /\/verify:/.test(n.message) && /not a git repository/.test(n.message)),
  ).toBe(true)
})

test('/verify fails fast when an agentType is missing', async () => {
  const { pi, commands } = fakePi()
  register(pi)
  const cwd = initRepo()
  commitFile(cwd, 'a.ts', 'a\n', 'add a')
  writeFileSync(join(cwd, 'a.ts'), 'a\nchanged\n')
  const { ctx, notes } = fakeCtx(cwd)
  const prevDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(tmp(), 'agent')
  try {
    await command(commands, 'verify').handler('', ctx)
  } finally {
    if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevDir
  }
  expect(notes.some((n) => n.level === 'error' && /not registered/.test(n.message))).toBe(true)
})

function writeAgentDefs(scopeCwd: string, disallowedTools: Record<string, string[]> = {}) {
  mkdirSync(join(scopeCwd, 'agent', 'agents'), { recursive: true })
  for (const name of ['code-reviewer', 'test-engineer', 'comment-auditor']) {
    const deny = disallowedTools[name] ?? ['edit', 'write']
    writeFileSync(
      join(scopeCwd, 'agent', 'agents', `${name}.md`),
      `---\nname: ${name}\ndisallowedTools: ${deny.join(', ')}\n---\nbody`,
    )
  }
}

async function withAgentDir<T>(scopeCwd: string, fn: () => Promise<T>): Promise<T> {
  const prevDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(scopeCwd, 'agent')
  try {
    return await fn()
  } finally {
    if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevDir
  }
}

test('/verify renders a doc entry with the exact verdict and sends a non-displayed message', async () => {
  const { pi, commands, entries, messages } = fakePi()
  let ran = false
  const run = async () => {
    ran = true
    return { result: reports() }
  }
  register(pi, { run: asMock<WorkflowRunner>(run) })
  const scopeCwd = initRepo()
  commitFile(scopeCwd, 'a.ts', 'a\n', 'add a')
  writeFileSync(join(scopeCwd, 'a.ts'), 'a\nchanged\n')
  writeAgentDefs(scopeCwd)
  await withAgentDir(scopeCwd, async () => {
    const { ctx } = fakeCtx(scopeCwd)
    await command(commands, 'verify').handler('', ctx)
  })
  expect(ran, 'the workflow runner should have been invoked').toBe(true)
  expect(entries.length).toBe(1)
  expect(entry(entries, 0).data.markdown).toMatch(/## Verification Summary/)
  expect(entry(entries, 0).data.status).toBe('APPROVE')
  expect(messages.length).toBe(1)
  expect(must(messages[0], 'message').display).toBe(false)
  expect(must(messages[0], 'message').customType).toBe('verify-report')
})

test("/verify's entry renderer always shows the full markdown, not gated on the collapsed/expanded toggle", async () => {
  const { pi, commands, entries, renderers } = fakePi()
  register(pi, { run: asMock<WorkflowRunner>(async () => ({ result: reports() })) })
  const scopeCwd = initRepo()
  commitFile(scopeCwd, 'a.ts', 'a\n', 'add a')
  writeFileSync(join(scopeCwd, 'a.ts'), 'a\nchanged\n')
  writeAgentDefs(scopeCwd)
  await withAgentDir(scopeCwd, async () => {
    const { ctx } = fakeCtx(scopeCwd)
    await command(commands, 'verify').handler('', ctx)
  })
  const renderer = must(renderers.get('verify-doc'), 'verify renderer')
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s }
  const collapsed = renderer({ data: entry(entries, 0).data }, { expanded: false }, theme)
  const expanded = renderer({ data: entry(entries, 0).data }, { expanded: true }, theme)
  expect(collapsed, 'collapsed render must still return a component').toBeTruthy()
  expect(expanded, 'expanded render must return a component').toBeTruthy()
  const childCount = (c: RenderedComponent | undefined) => c?.children?.length
  expect(childCount(collapsed), 'the report body must not depend on the expanded flag').toBe(childCount(expanded))
  expect(
    childCount(collapsed) ?? 0,
    'the collapsed render must already include the markdown body, not just a header',
  ).toBeGreaterThanOrEqual(2)
})

test('/verify uses REQUEST CHANGES as the doc status when a report is missing', async () => {
  const { pi, commands, entries } = fakePi()
  const run = async () => ({ result: reports({ commentAuditor: null }) })
  register(pi, { run: asMock<WorkflowRunner>(run) })
  const scopeCwd = initRepo()
  commitFile(scopeCwd, 'a.ts', 'a\n', 'add a')
  writeFileSync(join(scopeCwd, 'a.ts'), 'a\nchanged\n')
  writeAgentDefs(scopeCwd)
  await withAgentDir(scopeCwd, async () => {
    const { ctx } = fakeCtx(scopeCwd)
    await command(commands, 'verify').handler('', ctx)
  })
  expect(entry(entries, 0).data.status).toBe('REQUEST CHANGES')
})

test('/verify refuses to run when an agentType denies edit but not write', async () => {
  const { pi, commands } = fakePi()
  let ran = false
  const run = async () => {
    ran = true
    return { result: reports() }
  }
  register(pi, { run: asMock<WorkflowRunner>(run) })
  const scopeCwd = initRepo()
  commitFile(scopeCwd, 'a.ts', 'a\n', 'add a')
  writeFileSync(join(scopeCwd, 'a.ts'), 'a\nchanged\n')
  writeAgentDefs(scopeCwd, { 'test-engineer': ['edit'] })
  await withAgentDir(scopeCwd, async () => {
    const { ctx, notes } = fakeCtx(scopeCwd)
    await command(commands, 'verify').handler('', ctx)
    expect(notes.some((n) => n.level === 'error' && /test-engineer/.test(n.message) && /write/.test(n.message))).toBe(
      true,
    )
  })
  expect(ran, 'the workflow should never run when the guard fails').toBe(false)
})

test('/verify warns on a large scope but still runs', async () => {
  const { pi, commands } = fakePi()
  let ran = false
  const run = async () => {
    ran = true
    return { result: reports() }
  }
  register(pi, { run: asMock<WorkflowRunner>(run) })
  const scopeCwd = initRepo()
  for (let i = 0; i < 101; i++) writeFileSync(join(scopeCwd, `f${i}.ts`), `content ${i}\n`)
  git(scopeCwd, ['add', '-A'])
  git(scopeCwd, ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-m', 'add many'])
  writeAgentDefs(scopeCwd)
  await withAgentDir(scopeCwd, async () => {
    const { ctx, notes } = fakeCtx(scopeCwd)
    await command(commands, 'verify').handler('HEAD~1..HEAD', ctx)
    expect(notes.some((n) => n.level === 'warning' && /Large scope/.test(n.message))).toBe(true)
  })
  expect(ran, 'a large scope should still run, not block').toBe(true)
}, 20_000)
