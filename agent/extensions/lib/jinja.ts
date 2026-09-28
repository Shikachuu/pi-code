import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Template } from '@huggingface/jinja'

const cache = new Map<string, Template>()

export function templatePath(dir: string, name: string): string {
  return join(dir, `${name}.jinja`)
}

function stripTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/**
 * Renders a tracked template file. The result never ends in a newline, matching
 * the pre-port renderers. @huggingface/jinja only strips a trailing newline from
 * the template source, so loop bodies and substituted values can still leave one.
 */
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
  try {
    return stripTrailingNewline(template.render(context))
  } catch (error) {
    throw new Error(`cannot render template ${path}: ${(error as Error).message}`)
  }
}
