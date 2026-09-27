import { existsSync, readFileSync } from 'node:fs'

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { loadModelTierConfig, resolveModelSpecWithThinking } from '@quintinshaw/pi-dynamic-workflows'
import { Type } from 'typebox'

import { formatAnswers, interview, type Question } from '../ask-user/interview.ts'
import { reviewDocument, showDocument } from '../ask-user/review.ts'
import { memoryBlock } from './memory.ts'
import {
  implementPrompt,
  planPrompt,
  type ResearchReport,
  renderResearch,
  replaceSection,
  validatePlan,
} from './prompts.ts'
import { runSdd, type WorkflowRunner } from './runner.ts'
import {
  createFeature,
  docPath,
  type FeatureState,
  featureCompletions,
  featureDir,
  listFeatures,
  readDoc,
  readState,
  researchFiles,
  resolveFeature,
  setPhase,
  splitArgs,
  writeDoc,
  writeResearch,
} from './store.ts'
import {
  DISCOVERY_SCRIPT,
  discoveryArgs,
  draftArgs,
  ENRICH_SCRIPT,
  type EnrichResult,
  enrichArgs,
  MAX_PROBES,
  RESEARCH_SCRIPT,
  researchArgs,
  SINGLE_SCRIPT,
} from './workflows.ts'

type SessionKind = 'plan' | 'implement'

interface Handoff {
  kind: SessionKind
  slug: string
  model?: { provider: string; id: string } | undefined
  thinking?: string | undefined
}

const SESSION_ENTRY = 'sdd-session'
const SESSION_TOOLS: Record<SessionKind, string> = { plan: 'sdd_save_plan', implement: 'sdd_complete' }
// newSession() replaces the extension instance, so the old closure cannot set the new session's model.
// The command leaves the handoff here and the new instance picks it up in session_start.
const HANDOFF = Symbol.for('ultimate-harness/sdd-handoff')
const handoffSlot = globalThis as { [HANDOFF]?: Handoff }

interface Draft {
  slug: string
  title: string
  markdown: string
}

export function toQuestions(raw: EnrichResult['questions']): Question[] {
  return (raw?.questions ?? [])
    .filter((q) => q?.question && Array.isArray(q.options) && q.options.length >= 2)
    .slice(0, 4)
    .map((q, i) => ({
      id: `q${i + 1}`,
      header: q.header || `Q${i + 1}`,
      question: q.question,
      options: q.options.slice(0, 4),
      multiSelect: q.multiSelect === true,
    }))
}

function requireFeature(ctx: ExtensionContext, name: string): FeatureState {
  const state = resolveFeature(ctx.cwd, name)
  if (!state)
    throw new Error(
      name
        ? `Unknown feature "${name}". Run /sdd to list features.`
        : 'No features yet. Start one with /spec <request>.',
    )
  return state
}

function requireDoc(ctx: ExtensionContext, slug: string, name: 'spec.md' | 'plan.md', hint: string): string {
  const doc = readDoc(ctx.cwd, slug, name)
  if (!doc) throw new Error(`${slug} has no ${name}. ${hint}`)
  return doc
}

function tierModel(
  ctx: ExtensionContext,
  tier: string,
): { provider: string; id: string; thinking?: string | undefined } | undefined {
  const spec = loadModelTierConfig({ cwd: ctx.cwd })?.tiers[tier]
  if (!spec) return undefined
  const resolved = resolveModelSpecWithThinking(spec, ctx.modelRegistry)
  if (!resolved.model) return undefined
  return { provider: resolved.model.provider, id: resolved.model.id, thinking: resolved.thinkingLevel }
}

export interface SddOptions {
  run?: WorkflowRunner
}

export default function (pi: ExtensionAPI, options: SddOptions = {}) {
  const run = options.run

  async function spec(ctx: ExtensionCommandContext, request: string): Promise<string | undefined> {
    const memory = memoryBlock(ctx.cwd)
    const enrichment = await runSdd<EnrichResult>(ctx, ENRICH_SCRIPT, enrichArgs(request, memory), {
      label: 'spec: enrich',
      maxAgents: 3,
      run,
    })
    const questions = toQuestions(enrichment.questions)
    let answers = ''
    if (questions.length) {
      const picked = await interview(ctx, questions)
      if (!picked) return void ctx.ui.notify('Spec cancelled', 'info')
      answers = formatAnswers(questions, picked)
    }
    const base = { request, enrichment, answers, memory }
    let draft = await runSdd<Draft>(ctx, SINGLE_SCRIPT, draftArgs(base), { label: 'spec: draft', maxAgents: 1, run })
    for (;;) {
      const review = await reviewDocument(pi, ctx, { title: `Spec: ${draft.title}`, markdown: draft.markdown })
      if (review.action === 'cancel') return void ctx.ui.notify('Spec discarded', 'info')
      if (review.action === 'accept') break
      const revised = await runSdd<Draft>(
        ctx,
        SINGLE_SCRIPT,
        draftArgs({ ...base, draft: draft.markdown, feedback: review.feedback }),
        { label: 'spec: revise', maxAgents: 1, run },
      )
      draft = { ...revised, slug: draft.slug }
    }
    const state = createFeature(ctx.cwd, draft.slug || draft.title, draft.title)
    const path = writeDoc(ctx.cwd, state.slug, 'spec.md', draft.markdown)
    ctx.ui.notify(`Saved ${path}`, 'info')
    return state.slug
  }

  async function discover(ctx: ExtensionCommandContext, slug: string): Promise<void> {
    const specDoc = requireDoc(ctx, slug, 'spec.md', 'Run /spec first.')
    const existing = readDoc(ctx.cwd, slug, 'discovery.md')
    const result = await runSdd<{ markdown?: string }>(
      ctx,
      DISCOVERY_SCRIPT,
      discoveryArgs(specDoc, existing, memoryBlock(ctx.cwd)),
      { label: 'discovery', maxAgents: MAX_PROBES + 2, run },
    )
    if (!result.markdown) throw new Error('Discovery returned no report')
    const path = writeDoc(ctx.cwd, slug, 'discovery.md', result.markdown)
    if (readState(ctx.cwd, slug)?.phase === 'spec') setPhase(ctx.cwd, slug, 'discovered')
    showDocument(pi, { title: `Discovery: ${slug}`, markdown: result.markdown }, 'saved')
    ctx.ui.notify(`Saved ${path}`, 'info')
  }

  async function research(ctx: ExtensionCommandContext, slug: string, topic: string): Promise<void> {
    const specDoc = requireDoc(ctx, slug, 'spec.md', 'Run /spec first.')
    const report = await runSdd<Omit<ResearchReport, 'question'>>(
      ctx,
      RESEARCH_SCRIPT,
      researchArgs(topic, specDoc, readDoc(ctx.cwd, slug, 'discovery.md')),
      { label: 'research', maxAgents: 7, run },
    )
    const markdown = renderResearch({
      question: topic,
      summary: report.summary ?? '',
      findings: report.findings ?? [],
      implications: report.implications ?? [],
      recommendation: report.recommendation ?? '',
      openQuestions: report.openQuestions ?? [],
    })
    const path = writeResearch(ctx.cwd, slug, markdown)
    showDocument(pi, { title: `Research: ${topic}`, markdown }, 'saved')
    ctx.ui.notify(`Saved ${path}`, 'info')
  }

  async function handoff(ctx: ExtensionCommandContext, next: Handoff, prompt: string): Promise<void> {
    handoffSlot[HANDOFF] = next
    try {
      await ctx.newSession({ withSession: async (fresh) => fresh.sendUserMessage(prompt) })
    } finally {
      delete handoffSlot[HANDOFF]
    }
  }

  async function plan(ctx: ExtensionCommandContext, slug: string): Promise<void> {
    const specDoc = requireDoc(ctx, slug, 'spec.md', 'Run /spec first.')
    const big = tierModel(ctx, 'big')
    if (!big)
      ctx.ui.notify('No "big" model tier is configured (/workflows-models); planning uses the current model', 'warning')
    const prompt = planPrompt({
      slug,
      dir: featureDir(ctx.cwd, slug),
      spec: specDoc,
      discovery: readDoc(ctx.cwd, slug, 'discovery.md'),
      research: researchFiles(ctx.cwd, slug).map((r) => ({ path: r.path, content: readFileSync(r.path, 'utf8') })),
      memory: memoryBlock(ctx.cwd),
    })
    const model = big && { provider: big.provider, id: big.id }
    await handoff(ctx, { kind: 'plan', slug, model, thinking: big?.thinking ?? 'high' }, prompt)
  }

  async function implement(ctx: ExtensionCommandContext, state: FeatureState): Promise<void> {
    const { slug } = state
    const planDoc = requireDoc(ctx, slug, 'plan.md', `Run /plan ${slug} first.`)
    if (
      state.phase === 'done' &&
      !(await ctx.ui.confirm('Feature is done', `${slug} already passed its acceptance criteria. Implement it again?`))
    )
      return
    const docs = [
      docPath(ctx.cwd, slug, 'spec.md'),
      docPath(ctx.cwd, slug, 'discovery.md'),
      ...researchFiles(ctx.cwd, slug).map((r) => r.path),
    ]
    const prompt = implementPrompt({
      slug,
      plan: planDoc,
      planPath: docPath(ctx.cwd, slug, 'plan.md'),
      docs: docs.filter((d) => existsSync(d)),
    })
    const model = ctx.model && { provider: ctx.model.provider, id: ctx.model.id }
    await handoff(ctx, { kind: 'implement', slug, model, thinking: pi.getThinkingLevel() }, prompt)
  }

  async function gate(ctx: ExtensionCommandContext, slug: string): Promise<void> {
    for (;;) {
      const choice = await ctx.ui.select(`Discovery for ${slug} is saved. Next step?`, [
        'Start planning',
        'Run research first',
        'Stop',
      ])
      if (choice === 'Start planning') return plan(ctx, slug)
      if (choice !== 'Run research first') return void ctx.ui.notify(`Continue later with /plan ${slug}`, 'info')
      const topic = await ctx.ui.input('Research topic')
      if (topic?.trim()) await research(ctx, slug, topic.trim())
    }
  }

  function command(
    name: string,
    description: string,
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
    phases?: FeatureState['phase'][],
  ) {
    let cwd = process.cwd()
    pi.registerCommand(name, {
      description,
      ...(phases ? { getArgumentCompletions: (prefix: string) => featureCompletions(cwd, prefix, phases) } : {}),
      handler: async (args, ctx) => {
        cwd = ctx.cwd
        if (!ctx.hasUI) return void ctx.ui.notify(`/${name} needs the interactive UI`, 'error')
        try {
          await handler(args, ctx)
        } catch (error) {
          ctx.ui.notify(`/${name}: ${(error as Error).message}`, 'error')
        }
      },
    })
  }

  const all: FeatureState['phase'][] = ['spec', 'discovered', 'planned', 'implementing', 'done']

  command('spec', 'Interview and write a feature spec, then run discovery', async (args, ctx) => {
    if (!args.trim()) return void ctx.ui.notify('Usage: /spec <what you want to change>', 'warning')
    const slug = await spec(ctx, args.trim())
    if (!slug) return
    await discover(ctx, slug)
    await gate(ctx, slug)
  })

  command(
    'discover',
    'Run or refresh discovery for a feature',
    async (args, ctx) => {
      const { slug } = requireFeature(ctx, args.trim())
      await discover(ctx, slug)
      await gate(ctx, slug)
    },
    all,
  )

  command(
    'research',
    'Deep web research on a topic for a feature: /research [feature] <topic>',
    async (args, ctx) => {
      const { feature, rest } = splitArgs(args)
      const known = feature && readState(ctx.cwd, feature)
      const state = known || requireFeature(ctx, '')
      const topic = (known ? rest : args.trim()) || (await ctx.ui.input('Research topic'))?.trim()
      if (!topic) return
      await research(ctx, state.slug, topic)
    },
    all,
  )

  command(
    'plan',
    'Plan a feature in a fresh session on the big model',
    async (args, ctx) => plan(ctx, requireFeature(ctx, args.trim()).slug),
    all,
  )

  command(
    'implement',
    'Implement a planned feature in a fresh session',
    async (args, ctx) => implement(ctx, requireFeature(ctx, args.trim())),
    ['planned', 'implementing'],
  )

  command('sdd', 'List spec-driven features and their next step', async (_args, ctx) => {
    const next = {
      spec: '/discover',
      discovered: '/plan',
      planned: '/implement',
      implementing: '/implement',
      done: '-',
    }
    const features = listFeatures(ctx.cwd)
    ctx.ui.notify(
      features.length
        ? features.map((f) => `${f.slug} [${f.phase}] ${f.title} -> ${next[f.phase]}`).join('\n')
        : 'No features yet. Start with /spec <request>.',
      'info',
    )
  })

  pi.registerTool({
    name: SESSION_TOOLS.plan,
    label: 'Save plan',
    description:
      'Validate an SDD implementation plan, show it to the user for review, and save it as plan.md when accepted.',
    promptSnippet: "Save a reviewed SDD plan to the feature's plan.md",
    parameters: Type.Object({
      feature: Type.String({ description: 'Feature slug' }),
      markdown: Type.String({ description: 'The full plan in the required template' }),
      decisions: Type.Array(Type.String(), {
        description: 'Key technical decisions, one sentence each, to store in project memory',
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: {} })
      const state = readState(ctx.cwd, params.feature)
      if (!state) return text(`Unknown feature "${params.feature}"`)
      const errors = validatePlan(params.markdown)
      if (errors.length) return text(`Plan rejected. Fix these and call sdd_save_plan again:\n- ${errors.join('\n- ')}`)
      const review = await reviewDocument(pi, ctx, { title: `Plan: ${state.title}`, markdown: params.markdown })
      if (review.action === 'revise') {
        return text(
          `The user requested changes:\n${review.feedback}\n\nRevise the plan, use ask_user for any new decision, and call sdd_save_plan again.`,
        )
      }
      if (review.action === 'cancel') return text('The user rejected the plan. Stop and ask what should change.')
      const path = writeDoc(ctx.cwd, state.slug, 'plan.md', params.markdown)
      setPhase(ctx.cwd, state.slug, 'planned')
      const memory = params.decisions.length
        ? `\nRecord each decision in project memory: call memory_add with target "project" once per decision:\n- ${params.decisions.join('\n- ')}`
        : ''
      return text(`Saved ${path}.${memory}\nThen tell the user to run /implement ${state.slug}.`)
    },
  })

  pi.registerTool({
    name: SESSION_TOOLS.implement,
    label: 'Complete implementation',
    description:
      'Record acceptance-criteria results for an SDD feature in its plan.md and close the feature when all pass.',
    promptSnippet: "Record SDD acceptance results in the feature's plan.md",
    parameters: Type.Object({
      feature: Type.String({ description: 'Feature slug' }),
      results: Type.Array(
        Type.Object({
          criterion: Type.String(),
          status: Type.Union([Type.Literal('pass'), Type.Literal('fail')]),
          evidence: Type.String({ description: 'Command output summary or manual check' }),
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: {} })
      const state = readState(ctx.cwd, params.feature)
      if (!state) return text(`Unknown feature "${params.feature}"`)
      const planDoc = readDoc(ctx.cwd, state.slug, 'plan.md')
      if (!planDoc) return text(`Feature "${state.slug}" has no plan.md`)
      const lines = params.results.map(
        (r) => `- [${r.status === 'pass' ? 'x' : ' '}] ${r.criterion}: ${r.status} - ${r.evidence}`,
      )
      writeDoc(ctx.cwd, state.slug, 'plan.md', replaceSection(planDoc, 'Results', lines.join('\n')))
      const failed = params.results.filter((r) => r.status === 'fail').length
      setPhase(ctx.cwd, state.slug, failed ? 'implementing' : 'done')
      return text(
        failed
          ? `${failed} criteria failed; the feature stays in implementing.`
          : 'All criteria pass; the feature is done.',
      )
    },
  })

  function applySessionTools(kind: SessionKind | undefined) {
    const own = Object.values(SESSION_TOOLS)
    const active = pi.getActiveTools()
    const next = active.filter((name) => !own.includes(name))
    if (kind) next.push(SESSION_TOOLS[kind])
    if (next.length !== active.length || next.some((n, i) => n !== active[i])) pi.setActiveTools(next)
  }

  pi.on('session_start', async (event, ctx) => {
    const pending = event.reason === 'new' ? handoffSlot[HANDOFF] : undefined
    delete handoffSlot[HANDOFF]
    if (pending) {
      pi.appendEntry(SESSION_ENTRY, { kind: pending.kind, slug: pending.slug })
      pi.setSessionName(`${pending.kind}: ${pending.slug}`)
      if (pending.kind === 'implement' && readState(ctx.cwd, pending.slug))
        setPhase(ctx.cwd, pending.slug, 'implementing')
      const model = pending.model && ctx.modelRegistry.find(pending.model.provider, pending.model.id)
      if (model && !(await pi.setModel(model)))
        ctx.ui.notify(`No auth for ${pending.model?.provider}/${pending.model?.id}; using the current model`, 'warning')
      if (pending.thinking) pi.setThinkingLevel(pending.thinking as Parameters<typeof pi.setThinkingLevel>[0])
      return applySessionTools(pending.kind)
    }
    const entry = ctx.sessionManager
      .getEntries()
      .findLast((e) => e.type === 'custom' && e.customType === SESSION_ENTRY) as
      | { data?: { kind?: SessionKind } }
      | undefined
    applySessionTools(entry?.data?.kind)
  })
}
