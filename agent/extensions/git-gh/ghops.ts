export interface CommitSubject {
  subject: string
  body?: string | undefined
}

export interface PrView {
  number?: number | undefined
  title?: string | undefined
  state?: string | undefined
  isDraft?: boolean | undefined
  url?: string | undefined
  headRefName?: string | undefined
  baseRefName?: string | undefined
  mergeable?: string | undefined
  reviewDecision?: string | undefined
  author?: string | undefined
}

export interface Check {
  name?: string | undefined
  bucket?: string | undefined
  state?: string | undefined
  description?: string | undefined
  link?: string | undefined
}

export interface RepoView {
  nameWithOwner?: string | undefined
  description?: string | undefined
  url?: string | undefined
  defaultBranch?: string | undefined
  isPrivate?: boolean | undefined
  isFork?: boolean | undefined
  viewerPermission?: string | undefined
  stargazerCount?: number | undefined
}

const RECORD_SEPARATOR = '\x1e'

export const PR_VIEW_FIELDS = [
  'number',
  'title',
  'state',
  'isDraft',
  'url',
  'headRefName',
  'baseRefName',
  'mergeable',
  'reviewDecision',
  'author',
]

export const PR_CHECKS_FIELDS = ['name', 'bucket', 'state', 'description', 'link']

export const REPO_VIEW_FIELDS = [
  'nameWithOwner',
  'description',
  'url',
  'defaultBranchRef',
  'isPrivate',
  'isFork',
  'viewerPermission',
  'stargazerCount',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function authArgs(json: boolean): string[] {
  return json ? ['auth', 'status', '--json', 'hosts'] : ['auth', 'status']
}

export function prViewArgs(target: string | undefined): string[] {
  const args = ['pr', 'view']
  if (target) args.push(target)
  args.push('--json', PR_VIEW_FIELDS.join(','))
  return args
}

export function prChecksArgs(target: string | undefined): string[] {
  const args = ['pr', 'checks']
  if (target) args.push(target)
  args.push('--json', PR_CHECKS_FIELDS.join(','))
  return args
}

export function repoViewArgs(): string[] {
  return ['repo', 'view', '--json', REPO_VIEW_FIELDS.join(',')]
}

export function prCreateArgs(draft: { title: string; body: string; base?: string | undefined }): string[] {
  const args = ['pr', 'create', '--title', draft.title, '--body', draft.body]
  if (draft.base) args.push('--base', draft.base)
  return args
}

export function prEditArgs(
  target: string | undefined,
  fields: { title?: string | undefined; body?: string | undefined },
): string[] {
  const args = ['pr', 'edit']
  if (target) args.push(target)
  if (fields.title !== undefined) args.push('--title', fields.title)
  if (fields.body !== undefined) args.push('--body', fields.body)
  return args
}

export function gitLogArgs(base: string): string[] {
  return ['log', '-n', '50', `--format=%s%n%b${RECORD_SEPARATOR}`, `${base}..HEAD`]
}

export function parseCommits(raw: string): CommitSubject[] {
  return raw
    .split(RECORD_SEPARATOR)
    .map((chunk) => chunk.replace(/^\n+/, '').replace(/\n+$/, ''))
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const lines = chunk.split('\n')
      const subject = (lines[0] ?? '').trim()
      const body = lines.slice(1).join('\n').trim()
      return body ? { subject, body } : { subject }
    })
}

export function buildPrBody(commits: CommitSubject[]): string {
  if (commits.length === 0) return 'No local commits ahead of the base branch.'
  const summary = commits
    .map((commit) => {
      if (!commit.body) return `- ${commit.subject}`
      return `- ${commit.subject}\n\n  ${commit.body.replaceAll('\n', '\n  ')}`
    })
    .join('\n')
  const list = commits.map((commit) => `- ${commit.subject}`).join('\n')
  const cap = commits.length >= 50 ? '\n\n(Showing the latest 50 commits.)' : ''
  return `## Summary\n\n${summary}\n\n## Commits\n\n${list}${cap}`
}

export function parsePrView(raw: string): PrView | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(data)) return undefined
  const author = isRecord(data.author) ? asString(data.author.login) : asString(data.author)
  return {
    number: asNumber(data.number),
    title: asString(data.title),
    state: asString(data.state),
    isDraft: asBoolean(data.isDraft),
    url: asString(data.url),
    headRefName: asString(data.headRefName),
    baseRefName: asString(data.baseRefName),
    mergeable: asString(data.mergeable),
    reviewDecision: asString(data.reviewDecision),
    author,
  }
}

export function formatPrView(pr: PrView): string {
  const heading = `#${pr.number ?? '?'} ${pr.title ?? '(untitled)'}`
  const flags: string[] = []
  if (pr.state) flags.push(pr.state)
  if (pr.isDraft) flags.push('draft')
  const line1 = flags.length ? `${heading} [${flags.join(', ')}]` : heading
  const lines = [line1]
  if (pr.url) lines.push(pr.url)
  if (pr.headRefName || pr.baseRefName) lines.push(`${pr.headRefName ?? '?'} -> ${pr.baseRefName ?? '?'}`)
  const meta: string[] = []
  if (pr.mergeable) meta.push(`mergeable: ${pr.mergeable}`)
  if (pr.reviewDecision) meta.push(`review: ${pr.reviewDecision}`)
  if (pr.author) meta.push(`author: ${pr.author}`)
  if (meta.length) lines.push(meta.join(', '))
  return lines.join('\n')
}

export function parseChecks(raw: string): Check[] | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(data)) return undefined
  return data.filter(isRecord).map((entry) => ({
    name: asString(entry.name),
    bucket: asString(entry.bucket),
    state: asString(entry.state),
    description: asString(entry.description),
    link: asString(entry.link),
  }))
}

function isFailing(check: Check): boolean {
  return check.bucket === 'fail' || check.bucket === 'cancel' || check.state === 'FAILURE' || check.state === 'ERROR'
}

function isPending(check: Check): boolean {
  return (
    check.bucket === 'pending' || check.state === 'PENDING' || check.state === 'QUEUED' || check.state === 'IN_PROGRESS'
  )
}

export function summarizeChecks(checks: Check[]): string {
  if (checks.length === 0) return 'No checks reported for this pull request.'
  const failing = checks.filter(isFailing).length
  const pending = checks.filter(isPending).length
  const passing = checks.length - failing - pending
  const header = `${checks.length} checks: ${passing} passing, ${pending} pending, ${failing} failing`
  const lines = checks.map((check) => {
    const status = check.bucket ?? check.state ?? 'unknown'
    const detail = check.description ? ` - ${check.description}` : ''
    return `${status} ${check.name ?? '(unnamed)'}${detail}`
  })
  return `${header}\n${lines.join('\n')}`
}

export function parseAuthHosts(raw: string): string[] | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(data) || !isRecord(data.hosts)) return undefined
  const lines: string[] = []
  for (const [host, accounts] of Object.entries(data.hosts)) {
    if (!Array.isArray(accounts)) continue
    for (const account of accounts) {
      if (!isRecord(account)) continue
      const login = asString(account.login) ?? '(unknown)'
      const state = asString(account.state) ?? 'unknown'
      const active = account.active === true ? ' (active)' : ''
      lines.push(`${host}: ${login} ${state}${active}`)
    }
  }
  return lines
}

export function parseRepoView(raw: string): RepoView | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(data)) return undefined
  const defaultBranch = isRecord(data.defaultBranchRef) ? asString(data.defaultBranchRef.name) : undefined
  return {
    nameWithOwner: asString(data.nameWithOwner),
    description: asString(data.description),
    url: asString(data.url),
    defaultBranch,
    isPrivate: asBoolean(data.isPrivate),
    isFork: asBoolean(data.isFork),
    viewerPermission: asString(data.viewerPermission),
    stargazerCount: asNumber(data.stargazerCount),
  }
}

export function formatRepoView(repo: RepoView): string {
  const lines = [repo.nameWithOwner ?? '(unknown repo)']
  if (repo.description) lines.push(repo.description)
  if (repo.url) lines.push(repo.url)
  const meta: string[] = []
  if (repo.defaultBranch) meta.push(`default: ${repo.defaultBranch}`)
  if (repo.isPrivate !== undefined) meta.push(repo.isPrivate ? 'private' : 'public')
  if (repo.isFork) meta.push('fork')
  if (repo.viewerPermission) meta.push(`permission: ${repo.viewerPermission}`)
  if (repo.stargazerCount !== undefined) meta.push(`${repo.stargazerCount} stars`)
  if (meta.length) lines.push(meta.join(', '))
  return lines.join('\n')
}

/** gh pr create can exit non-zero while still printing the new PR URL. */
export function findPrUrl(stdout: string): string | undefined {
  const match = /https?:\/\/\S+\/pull\/\d+/.exec(stdout)
  return match?.[0]
}
