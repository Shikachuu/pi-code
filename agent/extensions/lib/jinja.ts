import { readFileSync } from 'node:fs'

import { Template } from '@huggingface/jinja'

const cache = new Map<string, Template>()

// Templates are tracked source read at runtime. A missing or unreadable file must
// fail loudly: rendering an empty prompt would silently ship a broken agent.
export function renderTemplate(path: string, context: Record<string, unknown> = {}): string {
  let template = cache.get(path)
  if (!template) {
    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch (error) {
      throw new Error(`cannot read template ${path}: ${(error as Error).message}`)
    }
    template = new Template(source)
    cache.set(path, template)
  }
  const rendered = template.render(context)
  // The library strips a trailing newline from the source before parsing, so a
  // rendered loop or variable still ends with one. Jinja's keep_trailing_newline
  // default is false, so strip it from the output too.
  return rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered
}
