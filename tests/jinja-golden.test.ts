import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { assert, expect, test } from 'vitest'

import {
  PLAN_TEMPLATE,
  SPEC_TEMPLATE,
  implementPrompt,
  planPrompt,
  renderResearch,
} from '../agent/extensions/sdd/prompts.ts'
import { MAX_PROBES, draftArgs, discoveryArgs, enrichArgs, researchArgs } from '../agent/extensions/sdd/workflows.ts'
import { type Reports, renderSummary } from '../agent/extensions/verification/report.ts'
import type { Scope } from '../agent/extensions/verification/scope.ts'
import { golden } from './golden.ts'

const SPEC = '# Phone\n\n## Goal\nAdd a phone field.\n'
const DISCOVERY = '# Discovery\n\n## Summary\nFound things.\n'
const RESEARCH = [
  { path: 'research-1.md', content: '# Research: formats\n\nE.164 wins.\n' },
  { path: 'research-2.md', content: '# Research: storage\n\nStore normalized.\n' },
]
const MEMORY = '<memory>\nProject memory:\n- uses pnpm\n</memory>'

const SCOPE: Scope = {
  target: 'main',
  kind: 'default',
  base: 'main',
  files: ['a.ts', 'b.ts'],
  wholeFiles: [],
  commands: ['git diff main...HEAD'],
  stats: { files: 2, insertions: 10, deletions: 2 },
  notes: [],
}

function reports(overrides: Partial<Reports> = {}): Reports {
  return {
    codeReviewer: {
      verdict: 'APPROVE',
      overview: 'Looks fine.',
      findings: [],
      verificationStory: { testsReviewed: 'yes', buildVerified: 'yes', securityChecked: 'yes' },
    },
    testEngineer: {
      verdict: 'APPROVE',
      overview: 'Coverage is fine.',
      findings: [],
      coverageGaps: [],
      smokeTest: { commands: ['npm test'], suite: 'passed', manual: '', blocked: [] },
    },
    commentAuditor: {
      verdict: 'APPROVE',
      overview: 'Comments are clean.',
      mustKill: [],
      correctness: [],
      nits: [],
      kept: [],
      skipped: [],
    },
    ...overrides,
  }
}

test('rendered sdd templates match the pre-port goldens byte for byte', () => {
  expect(SPEC_TEMPLATE).toBe(golden('spec-template'))
  expect(PLAN_TEMPLATE).toBe(golden('plan-template'))
})

test('planPrompt matches the pre-port goldens for every branch', () => {
  expect(
    planPrompt({
      slug: 'phone',
      dir: '.pi/sdd/phone',
      spec: SPEC,
      discovery: DISCOVERY,
      research: RESEARCH,
      memory: MEMORY,
    }),
  ).toBe(golden('plan-prompt-full'))
  expect(
    planPrompt({ slug: 'phone', dir: '.pi/sdd/phone', spec: SPEC, discovery: undefined, research: [], memory: '' }),
  ).toBe(golden('plan-prompt-minimal'))
  expect(
    planPrompt({
      slug: 'phone',
      dir: '.pi/sdd/phone',
      spec: SPEC,
      discovery: DISCOVERY,
      research: RESEARCH,
      memory: '',
    }),
  ).toBe(golden('plan-prompt-research'))
  expect(
    planPrompt({ slug: 'phone', dir: '.pi/sdd/phone', spec: SPEC, discovery: undefined, research: [], memory: MEMORY }),
  ).toBe(golden('plan-prompt-memory'))
})

test('implementPrompt matches the pre-port golden', () => {
  expect(
    implementPrompt({
      slug: 'phone',
      plan: PLAN_TEMPLATE,
      planPath: '.pi/sdd/phone/plan.md',
      docs: ['.pi/sdd/phone/spec.md', '.pi/sdd/phone/research-1.md'],
    }),
  ).toBe(golden('implement-prompt'))
})

test('renderResearch matches the pre-port golden', () => {
  expect(
    renderResearch({
      question: 'Phone validation',
      summary: 'Use libphonenumber',
      findings: [
        { claim: 'E.164 is the standard', sources: ['https://a'] },
        { claim: 'Max 15 digits', sources: ['https://a', 'https://b'] },
      ],
      implications: ['Store E.164'],
      recommendation: 'Normalize on write',
      openQuestions: [],
    }),
  ).toBe(golden('research-report'))
})

test('enrich, draft and discovery prompts match the pre-port goldens', () => {
  const enrich = enrichArgs('add a phone field', MEMORY)
  expect(enrich.scope.prompt).toBe(golden('enrich-scope'))
  expect(enrich.repo.prompt).toBe(golden('enrich-repo'))
  expect(enrich.questions.prompt).toBe(golden('enrich-questions'))

  const enrichment = {
    scope: { goal: 'add phone', inScope: ['users'], nonGoals: [], assumptions: [] },
    repo: { stack: 'ts', areas: [{ path: 'a.ts', why: 'user model' }], patterns: [] },
    questions: { questions: [] },
  }
  expect(draftArgs({ request: 'add phone', enrichment, answers: '', memory: MEMORY }).prompt).toBe(
    golden('draft-prompt'),
  )
  expect(
    draftArgs({
      request: 'add phone',
      enrichment,
      answers: 'E.164',
      memory: '',
      draft: '# Phone',
      feedback: 'mention limits',
    }).prompt,
  ).toBe(golden('draft-revise'))

  const discovery = discoveryArgs(SPEC, undefined, MEMORY)
  expect(discovery.plan.prompt).toBe(golden('discovery-plan'))
  expect(discovery.probe.prompt).toBe(golden('discovery-probe'))
  expect(discovery.synth.prompt).toBe(golden('discovery-synth'))
  expect(discoveryArgs(SPEC, DISCOVERY, '').synth.prompt).toBe(golden('discovery-synth-existing'))
})

test('prompt builders with empty optional inputs match the pre-port goldens', () => {
  expect(enrichArgs('add a phone field', '').scope.prompt).toBe(golden('enrich-scope-empty'))
  expect(enrichArgs('add a phone field', '').questions.prompt).toBe(golden('enrich-questions-empty'))
  expect(discoveryArgs(SPEC, undefined, '').plan.prompt).toBe(golden('discovery-plan-empty'))
  expect(researchArgs('phone validation', SPEC, undefined).report.prompt).toBe(
    golden('research-report-prompt-no-discovery'),
  )
})

test('research prompts match the pre-port goldens', () => {
  const research = researchArgs('phone validation', SPEC, DISCOVERY)
  expect(research.queries.prompt).toBe(golden('research-queries'))
  expect(research.gather.prompt).toBe(golden('research-gather'))
  expect(research.verify.prompt).toBe(golden('research-verify'))
  expect(research.report.prompt).toBe(golden('research-report-prompt'))
})

test('renderSummary matches the pre-port goldens with and without a missing agent', () => {
  expect(renderSummary(SCOPE, reports())).toBe(golden('verification-summary'))
  expect(renderSummary(SCOPE, reports({ commentAuditor: null }))).toBe(golden('verification-summary-missing'))
})

test('sdd prompt builders carry their inputs independently of the goldens', () => {
  const enrichment = {
    scope: { goal: 'add phone', inScope: ['users'], nonGoals: [], assumptions: [] },
    repo: { stack: 'ts', areas: [{ path: 'a.ts', why: 'user model' }], patterns: [] },
    questions: { questions: [] },
  }
  const enrich = enrichArgs('add a phone field', MEMORY)
  expect(enrich.scope.prompt).toContain('add a phone field')
  expect(enrich.scope.prompt).toContain(MEMORY)
  expect(enrich.repo.prompt).not.toContain(MEMORY)

  expect(draftArgs({ request: 'add phone', enrichment, answers: '', memory: '' }).prompt).not.toContain(
    '<user-answers>',
  )
  expect(draftArgs({ request: 'add phone', enrichment, answers: 'E.164', memory: '' }).prompt).toContain(
    '<user-answers>\nE.164\n</user-answers>',
  )

  expect(discoveryArgs(SPEC, undefined, '').plan.prompt).toContain(`Propose up to ${MAX_PROBES} independent probes`)
  expect(discoveryArgs(SPEC, undefined, '').synth.prompt).not.toContain('<existing-discovery>')
  expect(discoveryArgs(SPEC, DISCOVERY, '').synth.prompt).toContain('<existing-discovery>')

  expect(researchArgs('topic', SPEC, undefined).queries.prompt).not.toContain('<discovery>')
  expect(researchArgs('topic', SPEC, DISCOVERY).queries.prompt).toContain('<discovery>')
})

test('planPrompt substitutes user content containing template delimiters verbatim', () => {
  const dirty = 'text {{ oops }} {% raw %} & <tag> "quote"'
  const prompt = planPrompt({
    slug: 'dirty',
    dir: '.pi/sdd/dirty',
    spec: dirty,
    discovery: dirty,
    research: [{ path: 'research-1.md', content: dirty }],
    memory: dirty,
  })
  expect(prompt).toContain(dirty)
})

test('renderResearch renders a finding with no sources as claim ()', () => {
  const md = renderResearch({
    question: 'Q',
    summary: 'S',
    findings: [{ claim: 'No sources', sources: [] }],
    implications: [],
    recommendation: 'R',
    openQuestions: [],
  })
  expect(md).toContain('- No sources ()')
})

test('every tracked template has at least one golden fixture', () => {
  const templates = ['sdd', 'verification'].flatMap((dir) =>
    readdirSync(join(import.meta.dirname, '..', 'agent', 'extensions', dir, 'templates'))
      .filter((file) => file.endsWith('.jinja'))
      .map((file) => file.replace(/\.jinja$/, '')),
  )
  const fixtures = new Set(
    readdirSync(join(import.meta.dirname, 'fixtures', 'sdd-golden')).map((file) => file.replace(/\.txt$/, '')),
  )
  const covered: Record<string, string[]> = {
    'spec-template': ['spec-template'],
    'plan-template': ['plan-template'],
    'plan-prompt': ['plan-prompt-full', 'plan-prompt-minimal', 'plan-prompt-research', 'plan-prompt-memory'],
    'implement-prompt': ['implement-prompt'],
    'research-report': ['research-report'],
    'enrich-scope': ['enrich-scope', 'enrich-scope-empty'],
    'enrich-repo': ['enrich-repo'],
    'enrich-questions': ['enrich-questions', 'enrich-questions-empty'],
    'draft-prompt': ['draft-prompt', 'draft-revise'],
    'discovery-plan': ['discovery-plan', 'discovery-plan-empty'],
    'discovery-probe': ['discovery-probe'],
    'discovery-synth': ['discovery-synth', 'discovery-synth-existing'],
    'research-queries': ['research-queries'],
    'research-gather': ['research-gather'],
    'research-verify': ['research-verify'],
    'research-report-prompt': ['research-report-prompt', 'research-report-prompt-no-discovery'],
    'verification-summary': ['verification-summary', 'verification-summary-missing'],
  }
  expect(Object.keys(covered).sort()).toEqual([...templates].sort())
  for (const [name, goldens] of Object.entries(covered)) {
    for (const fixture of goldens) expect(fixtures.has(fixture), `${name} -> ${fixture}`).toBe(true)
  }
})

test('rendered prompts contain no unrendered template syntax', () => {
  const enrichment = {
    scope: { goal: 'add phone', inScope: ['users'], nonGoals: [], assumptions: [] },
    repo: { stack: 'ts', areas: [{ path: 'a.ts', why: 'user model' }], patterns: [] },
    questions: { questions: [] },
  }
  const enrich = enrichArgs('add a phone field', MEMORY)
  const discovery = discoveryArgs(SPEC, undefined, MEMORY)
  const research = researchArgs('phone validation', SPEC, DISCOVERY)
  const rendered: [string, string][] = [
    ['spec-template', SPEC_TEMPLATE],
    ['plan-template', PLAN_TEMPLATE],
    [
      'plan-prompt',
      planPrompt({
        slug: 'phone',
        dir: '.pi/sdd/phone',
        spec: SPEC,
        discovery: DISCOVERY,
        research: RESEARCH,
        memory: MEMORY,
      }),
    ],
    [
      'implement-prompt',
      implementPrompt({ slug: 'phone', plan: PLAN_TEMPLATE, planPath: '.pi/sdd/phone/plan.md', docs: [] }),
    ],
    [
      'research-report',
      renderResearch({
        question: 'Q',
        summary: 'S',
        findings: [],
        implications: [],
        recommendation: 'R',
        openQuestions: [],
      }),
    ],
    ['enrich-scope', enrich.scope.prompt],
    ['enrich-repo', enrich.repo.prompt],
    ['enrich-questions', enrich.questions.prompt],
    ['draft-prompt', draftArgs({ request: 'add phone', enrichment, answers: '', memory: MEMORY }).prompt],
    ['discovery-plan', discovery.plan.prompt],
    ['discovery-probe', discovery.probe.prompt],
    ['discovery-synth', discovery.synth.prompt],
    ['research-queries', research.queries.prompt],
    ['research-gather', research.gather.prompt],
    ['research-verify', research.verify.prompt],
    ['research-report-prompt', research.report.prompt],
    ['verification-summary', renderSummary(SCOPE, reports())],
    ['verification-summary-missing', renderSummary(SCOPE, reports({ commentAuditor: null }))],
  ]
  for (const [name, text] of rendered) {
    assert.isFalse(text.includes('{{'), `${name} contains unrendered {{`)
    assert.isFalse(text.includes('{%'), `${name} contains unrendered {%`)
  }
})
