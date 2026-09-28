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
 * @huggingface/jinja only strips a trailing newline from the template source, so
 * loop bodies and substituted values can still leave one. The result is
 * normalized to never end in a newline.
 */
export function renderTemplate(path: string, context: Record<string, unknown> = {}): string {
  let template = cache.get(path)
  if (!template) {
    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch (error) {
      throw new Error(`cannot read template ${path}: ${(error as Error).message}`, { cause: error })
    }
    try {
      template = new Template(source)
    } catch (error) {
      throw new Error(`cannot parse template ${path}: ${(error as Error).message}`, { cause: error })
    }
    cache.set(path, template)
  }
  try {
    return stripTrailingNewline(template.render(context))
  } catch (error) {
    throw new Error(`cannot render template ${path}: ${(error as Error).message}`, { cause: error })
  }
}
