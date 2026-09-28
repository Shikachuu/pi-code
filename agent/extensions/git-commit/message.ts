export const COMMIT_TYPES = ['feat', 'fix', 'chore', 'refactor'] as const
export type CommitType = (typeof COMMIT_TYPES)[number]

export const COMMIT_RULES = [
  'Subject: `<type>: <summary>` where type is feat, fix, chore or refactor.',
  'Summary: lowercase, present tense, at most 72 characters.',
  'Body: only when the reason for the change is not obvious from the diff.',
]

export const COMMIT_GUIDELINES = [
  ...COMMIT_RULES,
  'Call the commit tool without a message to read the staged diff, then call it again with the message.',
  'The commit tool never stages files; stage them with git add first. Commits are non-destructive and need no approval gate.',
  'Show the commit message in your reply for transparency, and set push true only after the user agrees to push.',
]

export function renderRules(): string {
  return COMMIT_RULES.map((rule) => `- ${rule}`).join('\n')
}

const PAST_TENSE_WORDS =
  /^(added|removed|fixed|updated|created|changed|refactored|implemented|moved|deleted|adjusted|improved|renamed|introduced|replaced|corrected|resolved|bumped|reverted|dropped|ensured|allowed|enabled|disabled)\b/i

export function isPastTense(summary: string): boolean {
  const first = summary.trim().split(/\s+/)[0] ?? ''
  if (PAST_TENSE_WORDS.test(first)) return true
  return /ed$/i.test(first) && first.length > 3
}

/**
 * Advisory hints for a commit subject. A non-empty array never blocks the commit.
 */
export function validateSubject(subject: string): string[] {
  const hints: string[] = []
  const firstLine = (subject.split('\n')[0] ?? '').trim()
  const match = /^([A-Za-z]+):\s*(.+)$/.exec(firstLine)
  if (!match) {
    hints.push(`Subject must match "<type>: <summary>"; type must be one of ${COMMIT_TYPES.join(', ')}.`)
    if (firstLine !== firstLine.toLowerCase()) hints.push('Write the summary in lowercase.')
    if (firstLine.length > 72) hints.push('Keep the subject to 72 characters or fewer.')
    return hints
  }
  const type = match[1] ?? ''
  const summary = match[2] ?? ''
  if (!(COMMIT_TYPES as readonly string[]).includes(type)) {
    hints.push(`Type "${type}" is outside ${COMMIT_TYPES.join(', ')}.`)
  }
  if (summary !== summary.toLowerCase()) hints.push('Write the summary in lowercase.')
  if (isPastTense(summary)) hints.push('Write the summary in the present tense.')
  if (firstLine.length > 72) hints.push('Keep the subject to 72 characters or fewer.')
  return hints
}
