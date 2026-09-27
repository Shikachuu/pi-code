import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'

export type Phase = 'spec' | 'discovered' | 'planned' | 'implementing' | 'verifying' | 'done'

export type Verdict = 'APPROVE' | 'REQUEST CHANGES'

export interface FeatureState {
  slug: string
  title: string
  phase: Phase
  // The gate reads the verdict from here, never from plan.md: the implementing
  // agent can edit the plan, so a written verdict proves nothing.
  verification?: { verdict: Verdict; at: string }
  verifyRounds?: number
  createdAt: string
  updatedAt: string
}

export type DocName = 'spec.md' | 'discovery.md' | 'plan.md'

const STATE_FILE = 'state.json'
const RESEARCH_FILE = /^research-(\d+)\.md$/

export function sddRoot(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, 'sdd')
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/

export function featureDir(cwd: string, slug: string): string {
  if (!SLUG.test(slug)) throw new Error(`Invalid feature name "${slug}"`)
  return join(sddRoot(cwd), slug)
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug || 'feature'
}

export function uniqueSlug(cwd: string, text: string): string {
  const base = slugify(text)
  let slug = base
  for (let n = 2; existsSync(featureDir(cwd, slug)); n++) slug = `${base}-${n}`
  return slug
}

function writeState(cwd: string, state: FeatureState): FeatureState {
  writeFileSync(join(featureDir(cwd, state.slug), STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
  return state
}

export function createFeature(cwd: string, name: string, title: string, now = new Date()): FeatureState {
  const slug = uniqueSlug(cwd, name)
  mkdirSync(featureDir(cwd, slug), { recursive: true })
  const at = now.toISOString()
  return writeState(cwd, { slug, title, phase: 'spec', createdAt: at, updatedAt: at })
}

export function readState(cwd: string, slug: string): FeatureState | undefined {
  try {
    return JSON.parse(readFileSync(join(featureDir(cwd, slug), STATE_FILE), 'utf8'))
  } catch {
    return undefined
  }
}

export function setPhase(cwd: string, slug: string, phase: Phase, now = new Date()): FeatureState {
  const state = readState(cwd, slug)
  if (!state) throw new Error(`Unknown feature "${slug}"`)
  return writeState(cwd, { ...state, phase, updatedAt: now.toISOString() })
}

export function setVerifyRounds(cwd: string, slug: string, rounds: number, now = new Date()): FeatureState {
  const state = readState(cwd, slug)
  if (!state) throw new Error(`Unknown feature "${slug}"`)
  return writeState(cwd, { ...state, verifyRounds: rounds, updatedAt: now.toISOString() })
}

export function setVerification(cwd: string, slug: string, verdict: Verdict, now = new Date()): FeatureState {
  const state = readState(cwd, slug)
  if (!state) throw new Error(`Unknown feature "${slug}"`)
  return writeState(cwd, { ...state, verification: { verdict, at: now.toISOString() }, updatedAt: now.toISOString() })
}

export function listFeatures(cwd: string): FeatureState[] {
  const root = sddRoot(cwd)
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((slug) => SLUG.test(slug))
    .map((slug) => readState(cwd, slug))
    .filter((s): s is FeatureState => !!s)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function docPath(cwd: string, slug: string, name: DocName): string {
  return join(featureDir(cwd, slug), name)
}

export function readDoc(cwd: string, slug: string, name: DocName): string | undefined {
  const path = docPath(cwd, slug, name)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

export function writeDoc(cwd: string, slug: string, name: DocName, content: string): string {
  const path = docPath(cwd, slug, name)
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`)
  return path
}

export function researchFiles(cwd: string, slug: string): { n: number; path: string }[] {
  const dir = featureDir(cwd, slug)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((file) => ({ file, match: RESEARCH_FILE.exec(file) }))
    .flatMap(({ file, match }) => (match ? [{ n: Number(match[1]), path: join(dir, file) }] : []))
    .sort((a, b) => a.n - b.n)
}

export function nextResearchPath(cwd: string, slug: string): string {
  const last = researchFiles(cwd, slug).at(-1)?.n ?? 0
  return join(featureDir(cwd, slug), `research-${last + 1}.md`)
}

export function writeResearch(cwd: string, slug: string, content: string): string {
  const path = nextResearchPath(cwd, slug)
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`)
  return path
}

export function splitArgs(args: string): { feature: string; rest: string } {
  const trimmed = args.trim()
  const space = trimmed.search(/\s/)
  if (space < 0) return { feature: trimmed, rest: '' }
  return { feature: trimmed.slice(0, space), rest: trimmed.slice(space).trim() }
}

export function mostRecentFeature(cwd: string): FeatureState | undefined {
  return listFeatures(cwd)[0]
}

export function resolveFeature(cwd: string, name: string): FeatureState | undefined {
  return name ? readState(cwd, name) : mostRecentFeature(cwd)
}

export function featureCompletions(cwd: string, prefix: string, phases?: Phase[]) {
  const items = listFeatures(cwd)
    .filter((f) => !phases || phases.includes(f.phase))
    .filter((f) => f.slug.startsWith(prefix.trim()))
    .map((f) => ({ value: f.slug, label: f.slug, description: `${f.phase} - ${f.title}` }))
  return items.length ? items : null
}
