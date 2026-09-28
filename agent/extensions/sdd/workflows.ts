import { join } from 'node:path'

import { renderTemplate } from '../lib/jinja.ts'
import { SPEC_TEMPLATE } from './prompts.ts'

const TEMPLATES = join(import.meta.dirname, 'templates')

const template = (name: string) => join(TEMPLATES, `${name}.jinja`)

export const MAX_PROBES = 10

export const SINGLE_SCRIPT = `export const meta = {
  name: 'sdd_single',
  description: 'Run one spec-driven-development agent',
  phases: [{ title: 'Run' }],
}
phase('Run')
return await agent(args.prompt, { label: args.label, tier: args.tier, agentType: 'sdd-scout', schema: args.schema })`

export const ENRICH_SCRIPT = `export const meta = {
  name: 'sdd_spec_enrich',
  description: 'Enrich a feature request before drafting its spec',
  phases: [{ title: 'Enrich' }],
}
phase('Enrich')
const results = await parallel([
  () => agent(args.scope.prompt, { label: 'scope', tier: 'small', agentType: 'sdd-scout', schema: args.scope.schema }),
  () => agent(args.repo.prompt, { label: 'repo context', tier: 'small', agentType: 'sdd-scout', schema: args.repo.schema }),
  () => agent(args.questions.prompt, { label: 'open questions', tier: 'small', agentType: 'sdd-scout', schema: args.questions.schema }),
])
return { scope: results[0], repo: results[1], questions: results[2] }`

export const DISCOVERY_SCRIPT = `export const meta = {
  name: 'sdd_discovery',
  description: 'Low-effort parallel discovery for a feature spec',
  phases: [{ title: 'Probe plan' }, { title: 'Probe' }, { title: 'Synthesize' }],
}
phase('Probe plan')
const plan = await agent(args.plan.prompt, { label: 'plan probes', tier: 'small', agentType: 'sdd-scout', schema: args.plan.schema })
let probes = plan && Array.isArray(plan.probes) ? plan.probes.filter((p) => p && p.question) : []
if (probes.length === 0) probes = [args.fallbackProbe]
probes = probes.slice(0, args.maxProbes)

phase('Probe')
const found = await parallel(probes.map((p, i) => () =>
  agent(
    args.probe.prompt + '\\n\\n<probe>\\n' + JSON.stringify(p, null, 2) + '\\n</probe>' + (p.kind === 'web' ? '\\n\\n' + args.probe.web : ''),
    { label: 'probe ' + (i + 1) + ': ' + p.title, tier: 'small', agentType: 'sdd-scout', schema: args.probe.schema }
  )
))
const results = probes.map((probe, i) => ({ probe, result: found[i] }))

phase('Synthesize')
const report = await agent(
  args.synth.prompt + '\\n\\n<probe-results>\\n' + JSON.stringify(results, null, 2) + '\\n</probe-results>',
  { label: 'synthesize', tier: 'small', agentType: 'sdd-scout', schema: args.synth.schema }
)
return { probes, results, markdown: report && report.markdown }`

export const RESEARCH_SCRIPT = `export const meta = {
  name: 'sdd_research',
  description: 'Deep web research on one topic of a feature',
  phases: [{ title: 'Queries' }, { title: 'Gather' }, { title: 'Verify' }, { title: 'Report' }],
}
phase('Queries')
const plan = await agent(args.queries.prompt, { label: 'plan queries', tier: 'small', agentType: 'sdd-scout', schema: args.queries.schema })
const planned = plan && Array.isArray(plan.queries) ? plan.queries.filter((q) => typeof q === 'string' && q.trim()) : []
const queries = (planned.length ? planned : [args.question]).slice(0, args.angles)

phase('Gather')
const gathered = await parallel(queries.map((q, i) => () =>
  agent(args.gather.prompt + '\\n\\nQuery: ' + q, { label: 'research ' + (i + 1), tier: 'small', agentType: 'sdd-scout', schema: args.gather.schema })
))
const sources = gathered.filter(Boolean).flatMap((g) => g.sources || [])

phase('Verify')
const verdict = await agent(
  args.verify.prompt + '\\n\\nSOURCES JSON:\\n' + JSON.stringify(sources),
  { label: 'cross-check', tier: 'medium', agentType: 'sdd-scout', schema: args.verify.schema }
)

phase('Report')
return await agent(
  args.report.prompt + '\\n\\nSUPPORTED CLAIMS JSON:\\n' + JSON.stringify((verdict && verdict.supported) || []),
  { label: 'write report', tier: 'medium', agentType: 'sdd-scout', schema: args.report.schema }
)`

const str = { type: 'string' } as const
const strList = { type: 'array', items: str } as const
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
})

const QUESTION_SCHEMA = obj({
  questions: {
    type: 'array',
    maxItems: 4,
    items: obj(
      {
        id: str,
        header: str,
        question: str,
        options: { type: 'array', minItems: 2, maxItems: 4, items: obj({ label: str, description: str }, ['label']) },
        multiSelect: { type: 'boolean' },
      },
      ['id', 'header', 'question', 'options', 'multiSelect'],
    ),
  },
})

const FINDINGS_SCHEMA = obj({
  findings: { type: 'array', items: obj({ claim: str, evidence: strList }) },
  answered: strList,
  gaps: strList,
})

const WEB_TOOLS =
  'Call web_enable first to activate the web tools. Then use web_search and fetch_content. Report only what fetched pages say, with the exact URL.'

export interface EnrichResult {
  scope?: { goal: string; inScope: string[]; nonGoals: string[]; assumptions: string[] }
  repo?: { stack: string; areas: { path: string; why: string }[]; patterns: string[] }
  questions?: {
    questions: {
      id: string
      header: string
      question: string
      options: { label: string; description?: string }[]
      multiSelect?: boolean
    }[]
  }
}

export function enrichArgs(request: string, memory: string) {
  return {
    scope: {
      prompt: renderTemplate(template('enrich-scope'), { request, memory }),
      schema: obj({ goal: str, inScope: strList, nonGoals: strList, assumptions: strList }),
    },
    repo: {
      prompt: renderTemplate(template('enrich-repo'), { request }),
      schema: obj({ stack: str, areas: { type: 'array', items: obj({ path: str, why: str }) }, patterns: strList }),
    },
    questions: {
      prompt: renderTemplate(template('enrich-questions'), { request, memory }),
      schema: QUESTION_SCHEMA,
    },
  }
}

export function draftArgs(input: {
  request: string
  enrichment: EnrichResult
  answers: string
  memory: string
  draft?: string
  feedback?: string
}) {
  return {
    label: input.draft ? 'revise spec' : 'draft spec',
    tier: 'small',
    prompt: renderTemplate(template('draft-prompt'), {
      request: input.request,
      enrichment: JSON.stringify(input.enrichment, null, 2),
      answers: input.answers,
      draft: input.draft ?? '',
      feedback: input.feedback ?? '',
      specTemplate: SPEC_TEMPLATE,
      memory: input.memory,
    }),
    schema: obj({ slug: str, title: str, markdown: str }),
  }
}

export function discoveryArgs(spec: string, existing: string | undefined, memory: string) {
  return {
    maxProbes: MAX_PROBES,
    fallbackProbe: {
      kind: 'code',
      title: 'related code',
      question: 'Which files, modules and tests does this spec touch?',
      hints: '',
    },
    plan: {
      prompt: renderTemplate(template('discovery-plan'), { spec, memory, maxProbes: MAX_PROBES }),
      schema: obj({
        probes: {
          type: 'array',
          maxItems: MAX_PROBES,
          items: obj({
            kind: { type: 'string', enum: ['code', 'schema', 'deps', 'web'] },
            title: str,
            question: str,
            hints: str,
          }),
        },
      }),
    },
    probe: {
      prompt: renderTemplate(template('discovery-probe'), { spec }),
      web: WEB_TOOLS,
      schema: FINDINGS_SCHEMA,
    },
    synth: {
      prompt: renderTemplate(template('discovery-synth'), { spec, existing: existing ?? '' }),
      schema: obj({ markdown: str }),
    },
  }
}

export function researchArgs(topic: string, spec: string, discovery: string | undefined) {
  return {
    question: topic,
    angles: 4,
    queries: {
      prompt: renderTemplate(template('research-queries'), { spec, discovery: discovery ?? '', topic }),
      schema: obj({ queries: strList }),
    },
    gather: {
      prompt: renderTemplate(template('research-gather')),
      schema: obj({ sources: { type: 'array', items: obj({ url: str, claims: strList }) } }),
    },
    verify: {
      prompt: renderTemplate(template('research-verify')),
      schema: obj({ supported: { type: 'array', items: obj({ claim: str, sources: strList }) }, discarded: strList }, [
        'supported',
      ]),
    },
    report: {
      prompt: renderTemplate(template('research-report-prompt'), { spec, discovery: discovery ?? '', topic }),
      schema: obj({
        summary: str,
        findings: { type: 'array', items: obj({ claim: str, sources: strList }) },
        implications: strList,
        recommendation: str,
        openQuestions: strList,
      }),
    },
  }
}
