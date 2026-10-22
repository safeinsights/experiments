import { defineConfig } from 'vitest/config'

// Anchored here so `npm run enclave:test` from the repo root finds the same files as running it in this directory.
export default defineConfig({
    root: import.meta.dirname,
    test: {
        include: ['standin/*.test.ts'],
    },
})
