import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(import.meta.dirname, 'fixtures', 'sdd-golden')

// Fixtures captured from the pre-port renderers. Never regenerate them from the
// templates: a deliberate prompt change edits the fixture, and an accidental one
// must fail here.
export function golden(name: string): string {
  return readFileSync(join(DIR, `${name}.txt`), 'utf8')
}
