export interface WtChanges {
  staged?: boolean | number | undefined
  modified?: boolean | number | undefined
  untracked?: boolean | number | undefined
  renamed?: boolean | number | undefined
  deleted?: boolean | number | undefined
  conflicted?: boolean | number | undefined
  diff?: { added?: number | undefined; deleted?: number | undefined } | undefined
}

export interface WtWorktree {
  path?: string | undefined
  main?: boolean | undefined
  current?: boolean | undefined
  changes?: WtChanges | undefined
}

export interface WtItem {
  branch?: string | undefined
  worktree?: WtWorktree | undefined
  marker?: string | undefined
}

export interface WtEnvelope {
  schema?: number | undefined
  items: WtItem[]
}

export interface WorktreeSummary {
  branch: string
  path: string
  current: boolean
  main: boolean
  marker?: string | undefined
  changes: WtChanges
  dirty: boolean
}

const CHANGE_KEYS = ['staged', 'modified', 'untracked', 'renamed', 'deleted', 'conflicted'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseChanges(value: Record<string, unknown>): WtChanges {
  const changes: WtChanges = {}
  for (const key of CHANGE_KEYS) {
    const flag = value[key]
    if (typeof flag === 'boolean' || typeof flag === 'number') changes[key] = flag
  }
  if (isRecord(value.diff)) {
    const diff: { added?: number | undefined; deleted?: number | undefined } = {}
    if (typeof value.diff.added === 'number') diff.added = value.diff.added
    if (typeof value.diff.deleted === 'number') diff.deleted = value.diff.deleted
    changes.diff = diff
  }
  return changes
}

function parseWorktree(value: Record<string, unknown>): WtWorktree {
  const worktree: WtWorktree = {}
  if (typeof value.path === 'string') worktree.path = value.path
  if (typeof value.main === 'boolean') worktree.main = value.main
  if (typeof value.current === 'boolean') worktree.current = value.current
  if (isRecord(value.changes)) worktree.changes = parseChanges(value.changes)
  return worktree
}

function parseItem(value: Record<string, unknown>): WtItem {
  const item: WtItem = {}
  if (typeof value.branch === 'string') item.branch = value.branch
  if (typeof value.marker === 'string') item.marker = value.marker
  if (isRecord(value.worktree)) item.worktree = parseWorktree(value.worktree)
  return item
}

function isChangeSet(value: boolean | number | undefined): boolean {
  return value === true || (typeof value === 'number' && value > 0)
}

export function parseEnvelope(raw: string): WtEnvelope | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(data)) return undefined
  const rawItems = data.items
  const items = Array.isArray(rawItems) ? rawItems.filter(isRecord).map(parseItem) : []
  return { schema: typeof data.schema === 'number' ? data.schema : undefined, items }
}

export function isDirty(changes: WtChanges): boolean {
  if (CHANGE_KEYS.some((key) => isChangeSet(changes[key]))) return true
  return (changes.diff?.added ?? 0) > 0 || (changes.diff?.deleted ?? 0) > 0
}

export function describeChanges(changes: WtChanges): string {
  const parts: string[] = CHANGE_KEYS.filter((key) => isChangeSet(changes[key]))
  const added = changes.diff?.added ?? 0
  const deleted = changes.diff?.deleted ?? 0
  if (added > 0 || deleted > 0) parts.push(`+${added}/-${deleted}`)
  return parts.length ? `dirty (${parts.join(', ')})` : 'clean'
}

export function summarize(item: WtItem): WorktreeSummary {
  const changes = item.worktree?.changes ?? {}
  return {
    branch: item.branch ?? '(detached)',
    path: item.worktree?.path ?? '(unknown)',
    current: item.worktree?.current === true,
    main: item.worktree?.main === true,
    marker: item.marker,
    changes,
    dirty: isDirty(changes),
  }
}

export function formatWorktree(summary: WorktreeSummary): string {
  const flags: string[] = []
  if (summary.current) flags.push('current')
  if (summary.main) flags.push('main')
  const suffix = flags.length ? ` [${flags.join(', ')}]` : ''
  const marker = summary.marker ? ` marker: ${summary.marker}` : ''
  return `${summary.branch} ${summary.path}${suffix} ${describeChanges(summary.changes)}${marker}`
}

export function formatList(envelope: WtEnvelope): string {
  if (envelope.items.length === 0) return 'No worktrees found.'
  return envelope.items.map((item) => formatWorktree(summarize(item))).join('\n')
}

export function findCurrent(envelope: WtEnvelope): WorktreeSummary | undefined {
  const item = envelope.items.find((candidate) => candidate.worktree?.current === true)
  return item ? summarize(item) : undefined
}

export function findByBranch(envelope: WtEnvelope, branch: string): WorktreeSummary | undefined {
  const item = envelope.items.find((candidate) => candidate.branch === branch)
  return item ? summarize(item) : undefined
}

/** Pre-check for `create`: wt switches to an existing worktree instead of erroring. */
export function existingWorktreeError(envelope: WtEnvelope, branch: string): string | undefined {
  const existing = findByBranch(envelope, branch)
  if (!existing) return undefined
  return `Branch "${branch}" already has a worktree at ${existing.path}. Use operation "switch" to move to it.`
}
