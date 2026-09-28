import { readdirSync, readFileSync } from 'node:fs'
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
import { renderSummary } from '../agent/extensions/verification/report.ts'
import type { Scope } from '../agent/extensions/verification/scope.ts'
import { expectGolden } from './golden.ts'
import { reports } from './helpers.ts'

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

const ENRICHMENT = {
  scope: { goal: 'add phone', inScope: ['users'], nonGoals: [], assumptions: [] },
  repo: { stack: 'ts', areas: [{ path: 'a.ts', why: 'user model' }], patterns: [] },
  questions: { questions: [] },
}

const COVERED: Record<string, string[]> = {
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

test('rendered sdd templates match the pre-port goldens byte for byte', () => {
  expectGolden('spec-template', SPEC_TEMPLATE)
  expectGolden('plan-template', PLAN_TEMPLATE)
})

test('planPrompt matches the pre-port goldens for every branch', () => {
  expectGolden(
    'plan-prompt-full',
    planPrompt({
      slug: 'phone',
      dir: '.pi/sdd/phone',
      spec: SPEC,
      discovery: DISCOVERY,
      research: RESEARCH,
      memory: MEMORY,
    }),
  )
  expectGolden(
    'plan-prompt-minimal',
    planPrompt({ slug: 'phone', dir: '.pi/sdd/phone', spec: SPEC, discovery: undefined, research: [], memory: '' }),
  )
  expectGolden(
    'plan-prompt-research',
    planPrompt({
      slug: 'phone',
      dir: '.pi/sdd/phone',
      spec: SPEC,
      discovery: DISCOVERY,
      research: RESEARCH,
      memory: '',
    }),
  )
  expectGolden(
    'plan-prompt-memory',
    planPrompt({ slug: 'phone', dir: '.pi/sdd/phone', spec: SPEC, discovery: undefined, research: [], memory: MEMORY }),
  )
})

test('implementPrompt matches the pre-port golden', () => {
  expectGolden(
    'implement-prompt',
    implementPrompt({
      slug: 'phone',
      plan: PLAN_TEMPLATE,
      planPath: '.pi/sdd/phone/plan.md',
      docs: ['.pi/sdd/phone/spec.md', '.pi/sdd/phone/research-1.md'],
    }),
  )
})

test('renderResearch matches the pre-port golden', () => {
  expectGolden(
    'research-report',
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
  )
})

test('enrich prompts match the pre-port goldens', () => {
  const enrich = enrichArgs('add a phone field', MEMORY)
  expectGolden('enrich-scope', enrich.scope.prompt)
  expectGolden('enrich-repo', enrich.repo.prompt)
  expectGolden('enrich-questions', enrich.questions.prompt)
})

test('draft prompts match the pre-port goldens for the compose and revise branches', () => {
  expectGolden(
    'draft-prompt',
    draftArgs({ request: 'add phone', enrichment: ENRICHMENT, answers: '', memory: MEMORY }).prompt,
  )
  expectGolden(
    'draft-revise',
    draftArgs({
      request: 'add phone',
      enrichment: ENRICHMENT,
      answers: 'E.164',
      memory: '',
      draft: '# Phone',
      feedback: 'mention limits',
    }).prompt,
  )
})

test('draftArgs revises when a draft is present even without feedback', () => {
  const args = draftArgs({
    request: 'add phone',
    enrichment: ENRICHMENT,
    answers: '',
    memory: '',
    draft: '# D',
    feedback: '',
  })
  expect(args.label).toBe('revise spec')
  expect(args.prompt).toContain('Revise this spec draft')
  expect(args.prompt).toContain('<draft>\n# D\n</draft>')
  expect(args.prompt).not.toContain('Compose a feature spec')
})

test('draftArgs renders a whitespace-only feedback block in the revise branch', () => {
  const args = draftArgs({
    request: 'add phone',
    enrichment: ENRICHMENT,
    answers: '',
    memory: '',
    draft: '# D',
    feedback: '   ',
  })
  expect(args.label).toBe('revise spec')
  expect(args.prompt).toContain('<feedback>\n   \n</feedback>')
})

test('discovery prompts match the pre-port goldens', () => {
  const discovery = discoveryArgs(SPEC, undefined, MEMORY)
  expectGolden('discovery-plan', discovery.plan.prompt)
  expectGolden('discovery-probe', discovery.probe.prompt)
  expectGolden('discovery-synth', discovery.synth.prompt)
  expectGolden('discovery-synth-existing', discoveryArgs(SPEC, DISCOVERY, '').synth.prompt)
})

test('prompt builders with empty optional inputs match the pre-port goldens', () => {
  expectGolden('enrich-scope-empty', enrichArgs('add a phone field', '').scope.prompt)
  expectGolden('enrich-questions-empty', enrichArgs('add a phone field', '').questions.prompt)
  expectGolden('discovery-plan-empty', discoveryArgs(SPEC, undefined, '').plan.prompt)
  expectGolden('research-report-prompt-no-discovery', researchArgs('phone validation', SPEC, undefined).report.prompt)
})

test('research prompts match the pre-port goldens', () => {
  const research = researchArgs('phone validation', SPEC, DISCOVERY)
  expectGolden('research-queries', research.queries.prompt)
  expectGolden('research-gather', research.gather.prompt)
  expectGolden('research-verify', research.verify.prompt)
  expectGolden('research-report-prompt', research.report.prompt)
})

test('renderSummary matches the pre-port goldens with and without a missing agent', () => {
  expectGolden('verification-summary', renderSummary(SCOPE, reports()))
  expectGolden('verification-summary-missing', renderSummary(SCOPE, reports({ commentAuditor: null })))
})

test('sdd prompt builders carry their inputs independently of the goldens', () => {
  const enrich = enrichArgs('add a phone field', MEMORY)
  expect(enrich.scope.prompt).toContain('add a phone field')
  expect(enrich.scope.prompt).toContain(MEMORY)
  expect(enrich.repo.prompt).not.toContain(MEMORY)

  expect(draftArgs({ request: 'add phone', enrichment: ENRICHMENT, answers: '', memory: '' }).prompt).not.toContain(
    '<user-answers>',
  )
  expect(draftArgs({ request: 'add phone', enrichment: ENRICHMENT, answers: 'E.164', memory: '' }).prompt).toContain(
    '<user-answers>\nE.164\n</user-answers>',
  )

  expect(discoveryArgs(SPEC, undefined, '').plan.prompt).toContain(`Propose up to ${MAX_PROBES} independent probes`)
  expect(discoveryArgs(SPEC, undefined, '').synth.prompt).not.toContain('<existing-discovery>')
  expect(discoveryArgs(SPEC, DISCOVERY, '').synth.prompt).toContain('<existing-discovery>')

  expect(researchArgs('topic', SPEC, undefined).queries.prompt).not.toContain('<discovery>')
  expect(researchArgs('topic', SPEC, DISCOVERY).queries.prompt).toContain('<discovery>')
})

test('planPrompt keeps a research block whose content is empty', () => {
  const prompt = planPrompt({
    slug: 's',
    dir: 'd',
    spec: SPEC,
    discovery: undefined,
    research: [{ path: 'r1.md', content: '' }],
    memory: '',
  })
  expect(prompt).toContain('<research path="r1.md">\n\n</research>')
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

test('every tracked template has a golden fixture and every fixture is asserted', () => {
  const templates = ['sdd', 'verification'].flatMap((dir) =>
    readdirSync(join(import.meta.dirname, '..', 'agent', 'extensions', dir, 'templates'))
      .filter((file) => file.endsWith('.jinja'))
      .map((file) => file.replace(/\.jinja$/, '')),
  )
  const fixtures = new Set(
    readdirSync(join(import.meta.dirname, 'fixtures', 'sdd-golden')).map((file) => file.replace(/\.txt$/, '')),
  )
  expect(Object.keys(COVERED).sort()).toEqual([...templates].sort())
  const referenced = new Set(Object.values(COVERED).flat())
  for (const [name, goldens] of Object.entries(COVERED)) {
    for (const fixture of goldens) assert.isTrue(fixtures.has(fixture), `${name} -> ${fixture}`)
  }
  for (const fixture of fixtures) assert.isTrue(referenced.has(fixture), `orphan fixture ${fixture}`)
  const source = readFileSync(join(import.meta.dirname, 'jinja-golden.test.ts'), 'utf8')
  const asserted = new Set([...source.matchAll(/expectGolden\(\s*'([^']+)'/g)].map((match) => match[1]))
  for (const fixture of referenced) assert.isTrue(asserted.has(fixture), `golden not asserted: ${fixture}`)
})

test('tracked .jinja templates use LF line endings', () => {
  for (const dir of ['sdd', 'verification']) {
    const templatesDir = join(import.meta.dirname, '..', 'agent', 'extensions', dir, 'templates')
    for (const file of readdirSync(templatesDir).filter((name) => name.endsWith('.jinja'))) {
      assert.isFalse(readFileSync(join(templatesDir, file), 'utf8').includes('\r'), file)
    }
  }
})

test('rendered prompts contain no unrendered template syntax', () => {
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
    ['draft-prompt', draftArgs({ request: 'add phone', enrichment: ENRICHMENT, answers: '', memory: MEMORY }).prompt],
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
    assert.isFalse(text.includes('\r'), `${name} contains a carriage return`)
  }
})
