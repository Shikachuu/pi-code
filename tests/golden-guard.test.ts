import { expect, test } from 'vitest'

test('UPDATE_GOLDENS and UPDATE_SNAPSHOTS are unset in a normal test run', () => {
  expect(process.env.UPDATE_GOLDENS).toBeUndefined()
  expect(process.env.UPDATE_SNAPSHOTS).toBeUndefined()
})
