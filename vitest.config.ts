import { defineConfig } from 'vitest/config'

// The git tool tests mutate the process-global PATH; forks with isolation keep
// that mutation inside one test file and one worker.
export default defineConfig({
  test: {
    pool: 'forks',
    isolate: true,
  },
})
