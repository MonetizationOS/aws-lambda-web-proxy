import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const shim = (name: string) => fileURLToPath(new URL(`./test/shims/${name}.ts`, import.meta.url))

export default defineConfig({
    resolve: {
        alias: { 'cloudflare:test': shim('cloudflareTest'), 'cloudflare:workers': shim('cloudflareWorkers') },
    },
    test: {
        include: ['test/**/*.spec.ts'],
        setupFiles: ['test/setup.ts'],
    },
})
