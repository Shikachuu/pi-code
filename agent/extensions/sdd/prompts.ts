import { join } from 'node:path'

import { renderTemplate } from '../lib/jinja.ts'

const TEMPLATES = join(import.meta.dirname, 'templates')

const template = (name: string) => join(TEMPLATES, `${name}.jinja`)

export const SPEC_TEMPLATE = renderTemplate(template('spec-template'))

export const PLAN_TEMPLATE = renderTemplate(template('plan-template'))

export interface ResearchReport {
  question: string
  summary: string
  findings: { claim: string; sources: string[] }[]
  implications: string[]
  recommendation: string
  openQuestions: string[]
}

function headingLines(lines: string[]): (string | undefined)[] {
  let fenced = false
  return lines.map((line) => {
    if (/^\s*```/.test(line)) fenced = !fenced
    const match = fenced ? null : /^(#{1,2})\s+(.*?)\s*$/.exec(line)
    return match ? `${match[1] ?? ''} ${(match[2] ?? '').toLowerCase()}` : undefined
  })
}

function sectionBounds(lines: string[], heading: string): { start: number; end: number } | undefined {
  const headings = headingLines(lines)
  const start = headings.indexOf(`## ${heading.toLowerCase()}`)
  if (start < 0) return undefined
  const end = headings.findIndex((h, i) => i > start && h !== undefined)
  return { start, end: end < 0 ? lines.length : end }
}

export function readSection(markdown: string, heading: string): string | undefined {
  const lines = markdown.split('\n')
  const bounds = sectionBounds(lines, heading)
  return (
    bounds &&
    lines
      .slice(bounds.start + 1, bounds.end)
      .join('\n')
      .trim()
  )
}

// A section body must not carry its own `##` heading, or sectionBounds reads it
// as the end of the section it is being written into.
export function demoteHeadings(markdown: string): string {
  let fenced = false
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced) return line
      return line.replace(/^(#{1,5})\s/, (_match, hashes: string) => `${hashes}# `)
    })
    .join('\n')
}

export function replaceSection(markdown: string, heading: string, body: string): string {
  const lines = markdown.trimEnd().split('\n')
  const bounds = sectionBounds(lines, heading)
  const block = [`## ${heading}`, '', body, '']
  if (!bounds) return [...lines, '', ...block].join('\n')
  return [...lines.slice(0, bounds.start), ...block, ...lines.slice(bounds.end)].join('\n').trimEnd() + '\n'
}

export function validatePlan(markdown: string): string[] {
  const errors: string[] = []
  const tasks = readSection(markdown, 'Tasks')
  if (!tasks || !/^\s*- \[[ x]\]/m.test(tasks)) errors.push('"## Tasks" needs at least one "- [ ]" checkbox item')
  const criteria = readSection(markdown, 'Acceptance criteria')
  if (!criteria || !/^\s*[-*\d]/m.test(criteria)) errors.push('"## Acceptance criteria" needs at least one list item')
  const pipeline = readSection(markdown, 'Validation pipeline')
  if (!pipeline || !/`[^`]+`/.test(pipeline))
    errors.push('"## Validation pipeline" needs at least one command in backticks')
  return errors
}

export function renderResearch(report: ResearchReport): string {
  const sources = [...new Set(report.findings.flatMap((f) => f.sources))]
  return renderTemplate(template('research-report'), {
    report: {
      question: report.question,
      summary: report.summary,
      findings: report.findings.map((f) => `${f.claim} (${f.sources.join(', ')})`),
      implications: report.implications,
      recommendation: report.recommendation,
      openQuestions: report.openQuestions,
      sources,
    },
  })
}

export interface PlanPromptInput {
  slug: string
  dir: string
  spec: string
  discovery?: string | undefined
  research: { path: string; content: string }[]
  memory: string
}

export function planPrompt(input: PlanPromptInput): string {
  const research = input.research.map((r) => `<research path="${r.path}">\n${r.content}\n</research>`).join('\n\n')
  return renderTemplate(template('plan-prompt'), {
    slug: input.slug,
    dir: input.dir,
    spec: input.spec,
    discovery: input.discovery ?? '',
    research,
    memory: input.memory,
    planTemplate: PLAN_TEMPLATE,
  })
}

export interface ImplementPromptInput {
  slug: string
  plan: string
  planPath: string
  docs: string[]
}

export function implementPrompt(input: ImplementPromptInput): string {
  return renderTemplate(template('implement-prompt'), {
    slug: input.slug,
    plan: input.plan,
    planPath: input.planPath,
    docs: input.docs.join(', '),
  })
}
