import { expect, test } from 'vitest'

test('UPDATE_GOLDENS is unset in a normal test run', () => {
  expect(process.env.UPDATE_GOLDENS).toBeUndefined()
})
