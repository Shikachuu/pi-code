import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type ScopeKind = 'default' | 'range' | 'ref' | 'path' | 'fallback'

export interface ScopeStats {
  files: number
  insertions: number
  deletions: number
}

export interface Scope {
  target: string
  kind: ScopeKind
  base?: string | undefined
  mergeBase?: string | undefined
  files: string[]
  wholeFiles: string[]
  commands: string[]
  stats: ScopeStats
  notes: string[]
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args)
  } catch {
    return undefined
  }
}

function isGitRepo(cwd: string): boolean {
  return tryGit(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true'
}

function detectBase(cwd: string): string | undefined {
  if (tryGit(cwd, ['rev-parse', '--verify', 'main']) !== undefined) return 'main'
  if (tryGit(cwd, ['rev-parse', '--verify', 'master']) !== undefined) return 'master'
  return undefined
}

function untrackedFiles(cwd: string, path?: string): string[] {
  const args = ['ls-files', '--others', '--exclude-standard']
  if (path) args.push('--', path)
  const out = tryGit(cwd, args)
  return out ? out.split('\n').filter(Boolean) : []
}

function nameList(cwd: string, args: string[]): string[] {
  const out = tryGit(cwd, args)
  return out ? out.split('\n').filter(Boolean) : []
}

function numstat(cwd: string, args: string[]): ScopeStats {
  const out = tryGit(cwd, args) ?? ''
  const lines = out.split('\n').filter(Boolean)
  let insertions = 0
  let deletions = 0
  const files = new Set<string>()
  for (const line of lines) {
    const [ins, del, ...rest] = line.split('\t')
    const file = rest.join('\t')
    if (file) files.add(file)
    const i = Number.parseInt(ins ?? '', 10)
    const d = Number.parseInt(del ?? '', 10)
    if (Number.isFinite(i)) insertions += i
    if (Number.isFinite(d)) deletions += d
  }
  return { files: files.size, insertions, deletions }
}

function mergeStats(a: ScopeStats, b: ScopeStats, totalFiles: number): ScopeStats {
  return { files: totalFiles, insertions: a.insertions + b.insertions, deletions: a.deletions + b.deletions }
}

function fallbackScope(cwd: string, target: string, note: string): Scope {
  const files = Array.from(new Set([...nameList(cwd, ['diff', '--name-only', 'HEAD']), ...untrackedFiles(cwd)])).sort()
  const stats = numstat(cwd, ['diff', '--numstat', 'HEAD'])
  return {
    target,
    kind: 'fallback',
    files,
    wholeFiles: [],
    commands: ['git diff HEAD', 'git status --short'],
    stats: { ...stats, files: files.length },
    notes: [note],
  }
}

function defaultScope(cwd: string, target: string, base: string): Scope {
  const mergeBase = tryGit(cwd, ['merge-base', base, 'HEAD'])
  if (mergeBase === undefined)
    return fallbackScope(cwd, target, `could not compute merge-base with ${base}; falling back to working tree`)
  const committed = nameList(cwd, ['diff', '--name-only', mergeBase, 'HEAD'])
  const uncommitted = nameList(cwd, ['diff', '--name-only', 'HEAD'])
  const untracked = untrackedFiles(cwd)
  const files = Array.from(new Set([...committed, ...uncommitted, ...untracked])).sort()
  const committedStats = numstat(cwd, ['diff', '--numstat', mergeBase, 'HEAD'])
  const uncommittedStats = numstat(cwd, ['diff', '--numstat', 'HEAD'])
  return {
    target,
    kind: 'default',
    base,
    mergeBase,
    files,
    wholeFiles: [],
    commands: [`git diff ${base}...HEAD`, 'git diff HEAD', 'git status --short'],
    stats: mergeStats(committedStats, uncommittedStats, files.length),
    notes: [],
  }
}

function rangeScope(cwd: string, target: string, arg: string): Scope {
  const separator = arg.includes('...') ? '...' : '..'
  const [left, right] = arg.split(separator)
  for (const side of [left, right]) {
    if (side && tryGit(cwd, ['rev-parse', '--verify', `${side}^{commit}`]) === undefined) {
      throw new Error(`unknown ref "${side}" in range "${arg}"`)
    }
  }
  const files = nameList(cwd, ['diff', '--name-only', arg, '--'])
  const stats = numstat(cwd, ['diff', '--numstat', arg, '--'])
  return {
    target,
    kind: 'range',
    files,
    wholeFiles: [],
    commands: [`git diff ${arg}`],
    stats: { ...stats, files: files.length },
    notes: [],
  }
}

function refScope(cwd: string, target: string, base: string, ref: string): Scope {
  const files = nameList(cwd, ['diff', '--name-only', `${base}...${ref}`])
  const stats = numstat(cwd, ['diff', '--numstat', `${base}...${ref}`])
  return {
    target,
    kind: 'ref',
    base,
    files,
    wholeFiles: [],
    commands: [`git diff ${base}...${ref}`],
    stats: { ...stats, files: files.length },
    notes: [],
  }
}

function pathScope(cwd: string, target: string, base: string | undefined, path: string): Scope {
  const mergeBase = base ? tryGit(cwd, ['merge-base', base, 'HEAD']) : undefined
  const committed = mergeBase ? nameList(cwd, ['diff', '--name-only', mergeBase, 'HEAD', '--', path]) : []
  const uncommitted = nameList(cwd, ['diff', '--name-only', 'HEAD', '--', path])
  const untracked = untrackedFiles(cwd, path)
  const files = Array.from(new Set([...committed, ...uncommitted, ...untracked])).sort()
  const commands = [
    mergeBase ? `git diff ${mergeBase} -- ${path}` : `git diff HEAD -- ${path}`,
    `git diff -- ${path}`,
    `git status --short -- ${path}`,
  ]
  let wholeFiles: string[] = []
  if (files.length === 0) {
    wholeFiles = nameList(cwd, ['ls-files', '--', path])
    if (wholeFiles.length === 0) wholeFiles = [path]
  }
  const committedStats = mergeBase
    ? numstat(cwd, ['diff', '--numstat', mergeBase, 'HEAD', '--', path])
    : { files: 0, insertions: 0, deletions: 0 }
  const uncommittedStats = numstat(cwd, ['diff', '--numstat', 'HEAD', '--', path])
  return {
    target,
    kind: 'path',
    base,
    mergeBase,
    files,
    wholeFiles,
    commands,
    stats: mergeStats(committedStats, uncommittedStats, files.length),
    notes: [],
  }
}

function looksLikePath(cwd: string, arg: string): boolean {
  if (tryGit(cwd, ['ls-files', '--error-unmatch', '--', arg]) !== undefined) return true
  const status = tryGit(cwd, ['status', '--porcelain', '--', arg])
  return status !== undefined && status.length > 0
}

export function resolveScope(cwd: string, arg: string | undefined): Scope {
  if (!isGitRepo(cwd)) throw new Error(`${cwd} is not a git repository`)
  const target = (arg ?? '').trim()
  if (target.startsWith('-')) throw new Error(`invalid target "${target}"`)
  if (
    target &&
    !target.includes('..') &&
    !looksLikePath(cwd, target) &&
    tryGit(cwd, ['rev-parse', '--verify', `${target}^{commit}`]) === undefined &&
    !existsSync(join(cwd, target))
  ) {
    throw new Error(`unknown ref or path "${target}"`)
  }

  try {
    if (!target) {
      const base = detectBase(cwd)
      if (!base) return fallbackScope(cwd, '(default)', 'no main or master branch found; falling back to working tree')
      return defaultScope(cwd, '(default)', base)
    }

    if (target.includes('..')) return rangeScope(cwd, target, target)

    const isPath = looksLikePath(cwd, target)
    if (!isPath) {
      const resolved = tryGit(cwd, ['rev-parse', '--verify', `${target}^{commit}`])
      if (resolved !== undefined) {
        const base = detectBase(cwd)
        if (base && (target === base || resolved === tryGit(cwd, ['rev-parse', '--verify', `${base}^{commit}`]))) {
          return defaultScope(cwd, target, base)
        }
        if (!base) return fallbackScope(cwd, target, 'no main or master branch found; falling back to working tree')
        return refScope(cwd, target, base, target)
      }
    }

    const base = detectBase(cwd)
    return pathScope(cwd, target, base, target)
  } catch (err) {
    return fallbackScope(
      cwd,
      target || '(default)',
      `git resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function isLarge(stats: ScopeStats): boolean {
  return stats.files > 100 || stats.insertions + stats.deletions > 10000
}

export function formatScope(scope: Scope): string {
  const lines: string[] = []
  lines.push(`Target: ${scope.target}`)
  lines.push(`Kind: ${scope.kind}`)
  if (scope.base) lines.push(`Base: ${scope.base}`)
  if (scope.files.length) {
    lines.push(`Files (${scope.files.length}):`)
    for (const f of scope.files) lines.push(`  ${f}`)
  } else {
    lines.push('Files: none')
  }
  if (scope.wholeFiles.length) {
    lines.push(`Whole files to read (unchanged vs base):`)
    for (const f of scope.wholeFiles) lines.push(`  ${f}`)
  }
  lines.push(`Stats: ${scope.stats.files} files, +${scope.stats.insertions}/-${scope.stats.deletions}`)
  lines.push('Commands to reproduce:')
  for (const c of scope.commands) lines.push(`  ${c}`)
  if (scope.notes.length) {
    lines.push('Notes:')
    for (const n of scope.notes) lines.push(`  ${n}`)
  }
  return lines.join('\n')
}
