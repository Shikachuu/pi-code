import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { AGENT_DIR } from './helpers.ts'

// Pi rewrites settings.json as JSON.stringify(settings, null, 2); matching it keeps runtime diffs to real value changes.
test("settings.json is in pi's own serialization", () => {
  const raw = readFileSync(join(AGENT_DIR, 'settings.json'), 'utf8')
  expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2))
})
