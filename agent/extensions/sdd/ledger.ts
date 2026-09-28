import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MergedFinding } from '../verification/report.ts'
import { featureDir, type Verdict } from './store.ts'

export interface VerifyRun {
  run: number
  at: string
  verdict: Verdict
  findings: MergedFinding[]
}

interface Ledger {
  runs: VerifyRun[]
  lessonsThrough?: number
}

export interface Recurring {
  category: string
  findings: number
  runs: number
  example: string
}

const LEDGER_FILE = 'findings.json'

function ledgerPath(cwd: string, slug: string): string {
  return join(featureDir(cwd, slug), LEDGER_FILE)
}

function readLedger(cwd: string, slug: string): Ledger {
  try {
    const data = JSON.parse(readFileSync(ledgerPath(cwd, slug), 'utf8')) as Partial<Ledger>
    if (!Array.isArray(data.runs)) return { runs: [] }
    return {
      runs: data.runs.filter((r) => typeof r?.run === 'number' && Array.isArray(r.findings)),
      ...(typeof data.lessonsThrough === 'number' ? { lessonsThrough: data.lessonsThrough } : {}),
    }
  } catch {
    return { runs: [] }
  }
}

function writeLedger(cwd: string, slug: string, ledger: Ledger): void {
  writeFileSync(ledgerPath(cwd, slug), `${JSON.stringify(ledger, null, 2)}\n`)
}

export function readFindings(cwd: string, slug: string): VerifyRun[] {
  return readLedger(cwd, slug).runs
}

export function appendFindings(
  cwd: string,
  slug: string,
  entry: { verdict: Verdict; findings: MergedFinding[] },
  now = new Date(),
): VerifyRun {
  const ledger = readLedger(cwd, slug)
  const run: VerifyRun = { run: (ledger.runs.at(-1)?.run ?? 0) + 1, at: now.toISOString(), ...entry }
  writeLedger(cwd, slug, { ...ledger, runs: [...ledger.runs, run] })
  return run
}

export function isBlocking(finding: MergedFinding): boolean {
  return finding.severity === 'critical' || finding.severity === 'important'
}

export function priorFindings(cwd: string, slug: string): MergedFinding[] {
  return (readFindings(cwd, slug).at(-1)?.findings ?? []).filter(isBlocking)
}

export function byCategory(findings: MergedFinding[]): Map<string, MergedFinding[]> {
  const groups = new Map<string, MergedFinding[]>()
  for (const finding of findings) {
    const category = finding.category || 'uncategorized'
    groups.set(category, [...(groups.get(category) ?? []), finding])
  }
  return groups
}

export function recurringSinceLessons(cwd: string, slug: string): { recurring: Recurring[]; through: number } {
  const ledger = readLedger(cwd, slug)
  const runs = ledger.runs.filter((r) => r.run > (ledger.lessonsThrough ?? 0))
  const stats = new Map<string, Recurring>()
  for (const run of runs) {
    for (const [category, findings] of byCategory(run.findings.filter(isBlocking))) {
      const seen = stats.get(category)
      if (seen) {
        seen.findings += findings.length
        seen.runs += 1
      } else stats.set(category, { category, findings: findings.length, runs: 1, example: findings[0]?.issue ?? '' })
    }
  }
  const recurring = [...stats.values()]
    .filter((s) => s.runs >= 2 || s.findings >= 3)
    .sort((a, b) => b.findings - a.findings || a.category.localeCompare(b.category))
  return { recurring, through: ledger.runs.at(-1)?.run ?? 0 }
}

export function markLessons(cwd: string, slug: string, through: number): void {
  writeLedger(cwd, slug, { ...readLedger(cwd, slug), lessonsThrough: through })
}

export function fixInstructions(findings: MergedFinding[], diffCommands: string[]): string {
  const groups = [...byCategory(findings.filter(isBlocking))]
  if (groups.length === 0) return ''
  const lines = groups.map(
    ([category, items]) => `- ${category} (${items.length}): ${items.map((f) => `${f.file}:${f.line}`).join(', ')}`,
  )
  return `Each blocking finding is one instance of its category. For every category below, search the whole verify scope (${diffCommands.map((c) => `\`${c}\``).join(', ')}) for other instances of the same problem and fix all of them, not only the cited file:line:\n${lines.join('\n')}\n\n`
}

export function lessonsText(recurring: Recurring[]): string {
  if (recurring.length === 0) return ''
  const lines = recurring.map(
    (r) => `- ${r.category}: ${r.findings} finding(s) over ${r.runs} verify run(s), e.g. "${r.example}"`,
  )
  return `\nThe review gate blocked on these categories more than once. Record each as a lesson in project memory: call memory_add with target "project" once per category, with one imperative sentence stating the rule that would have prevented it in the first implementation:\n${lines.join('\n')}`
}
