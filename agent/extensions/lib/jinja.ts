import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Template } from '@huggingface/jinja'

const cache = new Map<string, Template>()

export function templatePath(dir: string, name: string): string {
  return join(dir, `${name}.jinja`)
}

export function renderTemplate(path: string, context: Record<string, unknown> = {}): string {
  let template = cache.get(path)
  if (!template) {
    const source = readFileSync(path, 'utf8')
    try {
      template = new Template(source)
    } catch (error) {
      throw new Error(`cannot parse template ${path}: ${(error as Error).message}`)
    }
    cache.set(path, template)
  }
  const rendered = template.render(context)
  // @huggingface/jinja strips one trailing newline from the source before
  // parsing, so a template ending in a loop or variable still renders one.
  return rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered
}
