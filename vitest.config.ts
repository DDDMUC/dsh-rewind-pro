import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'host',
          include: ['tests/host/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'client',
          include: ['tests/client/**/*.test.ts'],
          environment: 'happy-dom',
        },
      },
    ],
  },
})
