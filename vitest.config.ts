import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    isolate: true,
    coverage: {
      provider: 'v8',
      include: [
        'agent/extensions/git-commit/**',
        'agent/extensions/git-gh/**',
        'agent/extensions/git-worktree/**',
        'agent/extensions/lib/exec.ts',
      ],
      reporter: ['text'],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 95,
        perFile: true,
      },
    },
  },
})
