import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(import.meta.dirname, 'fixtures', 'sdd-golden')

export function golden(name: string): string {
  return readFileSync(join(DIR, `${name}.txt`), 'utf8')
}
