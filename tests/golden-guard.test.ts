import { expect, test } from 'vitest'

// `mise run golden` sets UPDATE_GOLDENS and runs only tests/jinja-golden.test.ts.
// A leaked variable would make every golden write instead of compare, so this
// guard fails a normal run if it is still set.
test('UPDATE_GOLDENS is unset in a normal test run', () => {
  expect(process.env.UPDATE_GOLDENS).toBeUndefined()
})
