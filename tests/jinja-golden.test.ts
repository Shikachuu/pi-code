import { expect, test } from 'vitest'

import {
  PLAN_TEMPLATE,
  SPEC_TEMPLATE,
  implementPrompt,
  planPrompt,
  renderResearch,
} from '../agent/extensions/sdd/prompts.ts'
import { draftArgs, discoveryArgs, enrichArgs, researchArgs } from '../agent/extensions/sdd/workflows.ts'
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

test('rendered prompts contain no unrendered template syntax', () => {
  const enrichment = {
    scope: { goal: 'add phone', inScope: ['users'], nonGoals: [], assumptions: [] },
    repo: { stack: 'ts', areas: [{ path: 'a.ts', why: 'user model' }], patterns: [] },
    questions: { questions: [] },
  }
  const enrich = enrichArgs('add a phone field', MEMORY)
  const discovery = discoveryArgs(SPEC, undefined, MEMORY)
  const research = researchArgs('phone validation', SPEC, DISCOVERY)
  const rendered = [
    SPEC_TEMPLATE,
    PLAN_TEMPLATE,
    planPrompt({
      slug: 'phone',
      dir: '.pi/sdd/phone',
      spec: SPEC,
      discovery: DISCOVERY,
      research: RESEARCH,
      memory: MEMORY,
    }),
    implementPrompt({ slug: 'phone', plan: PLAN_TEMPLATE, planPath: '.pi/sdd/phone/plan.md', docs: [] }),
    renderResearch({
      question: 'Q',
      summary: 'S',
      findings: [],
      implications: [],
      recommendation: 'R',
      openQuestions: [],
    }),
    enrich.scope.prompt,
    enrich.repo.prompt,
    enrich.questions.prompt,
    draftArgs({ request: 'add phone', enrichment, answers: '', memory: MEMORY }).prompt,
    discovery.plan.prompt,
    discovery.probe.prompt,
    discovery.synth.prompt,
    research.queries.prompt,
    research.gather.prompt,
    research.verify.prompt,
    research.report.prompt,
    renderSummary(SCOPE, reports()),
    renderSummary(SCOPE, reports({ commentAuditor: null })),
  ]
  for (const text of rendered) {
    expect(text).not.toContain('{{')
    expect(text).not.toContain('{%')
  }
})
