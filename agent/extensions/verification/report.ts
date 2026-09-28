import { join } from 'node:path'

import { renderTemplate, templatePath } from '../lib/jinja.ts'
import type { Scope } from './scope.ts'

const SUMMARY_TEMPLATE = templatePath(join(import.meta.dirname, 'templates'), 'verification-summary')

const str = { type: 'string' } as const
const strList = { type: 'array', items: str } as const
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
})

export type Severity = 'critical' | 'important' | 'nit'

export interface Finding {
  severity: Severity
  category: string
  file: string
  line: number
  issue: string
  fix: string
}

const FINDING_SCHEMA = obj({
  severity: { type: 'string', enum: ['critical', 'important', 'nit'] },
  category: str,
  file: str,
  line: { type: 'number' },
  issue: str,
  fix: str,
})

const BASE_REPORT = {
  verdict: { type: 'string', enum: ['APPROVE', 'REQUEST CHANGES'] },
  overview: str,
  findings: { type: 'array', items: FINDING_SCHEMA },
}

export interface BaseReport {
  verdict: 'APPROVE' | 'REQUEST CHANGES'
  overview: string
  findings: Finding[]
}

export interface CodeReviewerReport extends BaseReport {
  verificationStory: { testsReviewed: string; buildVerified: string; securityChecked: string }
}

export const CODE_REVIEWER_SCHEMA = obj({
  ...BASE_REPORT,
  verificationStory: obj({ testsReviewed: str, buildVerified: str, securityChecked: str }),
})

export interface TestEngineerReport extends BaseReport {
  coverageGaps: string[]
  smokeTest: { commands: string[]; suite: string; manual: string; blocked: string[] }
}

export const TEST_ENGINEER_SCHEMA = obj({
  ...BASE_REPORT,
  coverageGaps: strList,
  smokeTest: obj({ commands: strList, suite: str, manual: str, blocked: strList }),
})

export interface AuditItem {
  file: string
  line: number
  issue: string
  fix?: string
}

const AUDIT_ITEM_SCHEMA = obj({ file: str, line: { type: 'number' }, issue: str, fix: str }, ['file', 'line', 'issue'])

export interface CommentAuditorReport {
  verdict: 'APPROVE' | 'REQUEST CHANGES'
  overview: string
  mustKill: AuditItem[]
  correctness: AuditItem[]
  nits: AuditItem[]
  kept: AuditItem[]
  skipped: string[]
}

export const COMMENT_AUDITOR_SCHEMA = obj({
  verdict: { type: 'string', enum: ['APPROVE', 'REQUEST CHANGES'] },
  overview: str,
  mustKill: { type: 'array', items: AUDIT_ITEM_SCHEMA },
  correctness: { type: 'array', items: AUDIT_ITEM_SCHEMA },
  nits: { type: 'array', items: AUDIT_ITEM_SCHEMA },
  kept: { type: 'array', items: AUDIT_ITEM_SCHEMA },
  skipped: strList,
})

export interface Reports {
  codeReviewer: CodeReviewerReport | null
  testEngineer: TestEngineerReport | null
  commentAuditor: CommentAuditorReport | null
}

export interface MergedFinding extends Finding {
  agents: string[]
}

const AGENT_ORDER = ['code-reviewer', 'test-engineer', 'comment-auditor'] as const

function attribution(agents: string[]): string {
  const set = new Set(agents)
  if (AGENT_ORDER.every((a) => set.has(a))) return '[all]'
  return `[${AGENT_ORDER.filter((a) => set.has(a)).join(', ')}]`
}

function auditToFindings(report: CommentAuditorReport | null): { agent: string; findings: Finding[] } {
  if (!report) return { agent: 'comment-auditor', findings: [] }
  const findings: Finding[] = [
    ...report.correctness.map((i) => ({
      severity: 'critical' as const,
      category: 'comment-correctness',
      file: i.file,
      line: i.line,
      issue: i.issue,
      fix: i.fix ?? '',
    })),
    ...report.mustKill.map((i) => ({
      severity: 'important' as const,
      category: 'comment-must-kill',
      file: i.file,
      line: i.line,
      issue: i.issue,
      fix: i.fix ?? '',
    })),
    ...report.nits.map((i) => ({
      severity: 'nit' as const,
      category: 'comment-nit',
      file: i.file,
      line: i.line,
      issue: i.issue,
      fix: i.fix ?? '',
    })),
  ]
  return { agent: 'comment-auditor', findings }
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, important: 2, nit: 1 }

function higherSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b
}

export function mergeFindings(reports: Reports): MergedFinding[] {
  const sources: { agent: string; findings: Finding[] }[] = [
    { agent: 'code-reviewer', findings: reports.codeReviewer?.findings ?? [] },
    { agent: 'test-engineer', findings: reports.testEngineer?.findings ?? [] },
    auditToFindings(reports.commentAuditor),
  ]

  const byKey = new Map<string, MergedFinding>()
  for (const { agent, findings } of sources) {
    for (const f of findings) {
      const key = `${f.file}:${f.line}`
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, { ...f, agents: [agent] })
        continue
      }
      existing.severity = higherSeverity(existing.severity, f.severity)
      if (!existing.agents.includes(agent)) existing.agents.push(agent)
      if (!existing.issue.includes(f.issue)) existing.issue = `${existing.issue}; ${f.issue}`
      if (f.fix && !existing.fix.includes(f.fix)) existing.fix = existing.fix ? `${existing.fix}; ${f.fix}` : f.fix
    }
  }
  return [...byKey.values()]
}

export function verdict(reports: Reports, merged: MergedFinding[]): 'APPROVE' | 'REQUEST CHANGES' {
  if (reports.codeReviewer === null || reports.testEngineer === null || reports.commentAuditor === null)
    return 'REQUEST CHANGES'
  if (reports.codeReviewer.verdict === 'REQUEST CHANGES') return 'REQUEST CHANGES'
  if (reports.testEngineer.verdict === 'REQUEST CHANGES') return 'REQUEST CHANGES'
  if (reports.commentAuditor.verdict === 'REQUEST CHANGES') return 'REQUEST CHANGES'
  if (merged.some((f) => f.severity === 'critical' || f.severity === 'important')) return 'REQUEST CHANGES'
  return 'APPROVE'
}

function bullet(text: string): string {
  return `- ${text}`
}

function findingLine(f: MergedFinding): string {
  return bullet(`${attribution(f.agents)} (${f.category}) ${f.file}:${f.line} ${f.issue}${f.fix ? ` -> ${f.fix}` : ''}`)
}

function auditLine(item: AuditItem, arrow: string): string {
  return bullet(`${item.file}:${item.line} ${item.issue}${item.fix ? ` ${arrow} ${item.fix}` : ''}`)
}

function smokeTestLines(smokeTest: TestEngineerReport['smokeTest']): string[] {
  return [
    bullet(`Commands: ${smokeTest.commands.join(', ') || 'none'}`),
    bullet(`Suite: ${smokeTest.suite || 'none'}`),
    bullet(`Manual: ${smokeTest.manual || 'none'}`),
    ...(smokeTest.blocked.length ? [bullet(`Blocked: ${smokeTest.blocked.join(', ')}`)] : []),
  ]
}

export function renderSummary(scope: Scope, reports: Reports): string {
  const merged = mergeFindings(reports)
  const overviewParts = [
    reports.codeReviewer?.overview,
    reports.testEngineer?.overview,
    reports.commentAuditor?.overview,
  ].filter(Boolean)
  const auditor = reports.commentAuditor
  const reviewer = reports.codeReviewer
  return renderTemplate(SUMMARY_TEMPLATE, {
    verdict: verdict(reports, merged),
    scope: `${scope.target} (${scope.kind}) - ${scope.files.length} file(s). Commands: ${scope.commands.join('; ')}`,
    overview: overviewParts.length ? overviewParts.join(' ') : 'No reports were returned.',
    critical: merged.filter((f) => f.severity === 'critical').map(findingLine),
    important: merged.filter((f) => f.severity === 'important').map(findingLine),
    nits: merged.filter((f) => f.severity === 'nit').map(findingLine),
    testEngineer: reports.testEngineer
      ? {
          coverageGaps: reports.testEngineer.coverageGaps.map(bullet),
          smokeTest: smokeTestLines(reports.testEngineer.smokeTest),
        }
      : null,
    codeReviewer: reviewer
      ? {
          verificationStory: [
            bullet(`Tests reviewed: ${reviewer.verificationStory.testsReviewed}`),
            bullet(`Build verified: ${reviewer.verificationStory.buildVerified}`),
            bullet(`Security checked: ${reviewer.verificationStory.securityChecked}`),
          ],
        }
      : null,
    commentAuditor: auditor
      ? {
          mustKill: auditor.mustKill.map((i) => auditLine(i, '->')),
          correctness: auditor.correctness.map((i) => auditLine(i, '->')),
          kept: auditor.kept.map((i) => auditLine(i, '-')),
          skipped: auditor.skipped.map(bullet),
        }
      : null,
  })
}
