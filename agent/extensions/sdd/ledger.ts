import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MergedFinding } from '../verification/report.ts'
import { featureDir, type Verdict } from './store.ts'

export interface VerifyRound {
  round: number
  at: string
  verdict: Verdict
  findings: MergedFinding[]
}

interface Ledger {
  rounds: VerifyRound[]
  lessonsThrough?: number
}

export interface Recurring {
  category: string
  findings: number
  rounds: number
  example: string
}

const LEDGER_FILE = 'findings.json'

function ledgerPath(cwd: string, slug: string): string {
  return join(featureDir(cwd, slug), LEDGER_FILE)
}

function readLedger(cwd: string, slug: string): Ledger {
  try {
    const data = JSON.parse(readFileSync(ledgerPath(cwd, slug), 'utf8')) as Partial<Ledger>
    if (!Array.isArray(data.rounds)) return { rounds: [] }
    return {
      rounds: data.rounds,
      ...(typeof data.lessonsThrough === 'number' ? { lessonsThrough: data.lessonsThrough } : {}),
    }
  } catch {
    return { rounds: [] }
  }
}

function writeLedger(cwd: string, slug: string, ledger: Ledger): void {
  writeFileSync(ledgerPath(cwd, slug), `${JSON.stringify(ledger, null, 2)}\n`)
}

export function readFindings(cwd: string, slug: string): VerifyRound[] {
  return readLedger(cwd, slug).rounds
}

export function appendFindings(
  cwd: string,
  slug: string,
  entry: { verdict: Verdict; findings: MergedFinding[] },
  now = new Date(),
): VerifyRound {
  const ledger = readLedger(cwd, slug)
  const round: VerifyRound = { round: ledger.rounds.length + 1, at: now.toISOString(), ...entry }
  writeLedger(cwd, slug, { ...ledger, rounds: [...ledger.rounds, round] })
  return round
}

export function isBlocking(finding: MergedFinding): boolean {
  return finding.severity === 'critical' || finding.severity === 'important'
}

export function priorFindings(cwd: string, slug: string): MergedFinding[] {
  return (readFindings(cwd, slug).at(-1)?.findings ?? []).filter(isBlocking)
}

export function byCategory(findings: MergedFinding[]): Map<string, MergedFinding[]> {
  const groups = new Map<string, MergedFinding[]>()
  for (const finding of findings) groups.set(finding.category, [...(groups.get(finding.category) ?? []), finding])
  return groups
}

export function recurringSinceLessons(cwd: string, slug: string): { recurring: Recurring[]; through: number } {
  const ledger = readLedger(cwd, slug)
  const rounds = ledger.rounds.filter((r) => r.round > (ledger.lessonsThrough ?? 0))
  const stats = new Map<string, Recurring>()
  for (const round of rounds) {
    for (const [category, findings] of byCategory(round.findings.filter(isBlocking))) {
      const seen = stats.get(category)
      if (seen) {
        seen.findings += findings.length
        seen.rounds += 1
      } else stats.set(category, { category, findings: findings.length, rounds: 1, example: findings[0]?.issue ?? '' })
    }
  }
  const recurring = [...stats.values()]
    .filter((s) => s.rounds >= 2 || s.findings >= 3)
    .sort((a, b) => b.findings - a.findings || a.category.localeCompare(b.category))
  return { recurring, through: ledger.rounds.at(-1)?.round ?? 0 }
}

export function markLessons(cwd: string, slug: string, through: number): void {
  writeLedger(cwd, slug, { ...readLedger(cwd, slug), lessonsThrough: through })
}

export function fixInstructions(findings: MergedFinding[]): string {
  const groups = [...byCategory(findings.filter(isBlocking))]
  if (groups.length === 0) return ''
  const lines = groups.map(
    ([category, items]) => `- ${category} (${items.length}): ${items.map((f) => `${f.file}:${f.line}`).join(', ')}`,
  )
  return `Each blocking finding is one instance of its category. For every category below, search the whole diff (\`git diff main...HEAD\` plus uncommitted changes) for other instances of the same problem and fix all of them, not only the cited file:line:\n${lines.join('\n')}\n\n`
}

export function lessonsText(recurring: Recurring[]): string {
  if (recurring.length === 0) return ''
  const lines = recurring.map(
    (r) => `- ${r.category}: ${r.findings} finding(s) over ${r.rounds} round(s), e.g. "${r.example}"`,
  )
  return `\nThe review gate kept finding these categories. Record each as a lesson in project memory: call memory_add with target "project" once per category, with one imperative sentence stating the rule that would have prevented it in the first implementation:\n${lines.join('\n')}`
}
