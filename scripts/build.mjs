// Produces build/: the root of the deployment zip. Lambda loads index.js from the zip root.
// The bundled lol-html glue loads its .wasm from __dirname, so the .wasm sits beside index.js.
import { cpSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

rmSync('build', { recursive: true, force: true })

await build({
    entryPoints: ['src/server.ts'],
    outfile: 'build/index.js',
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    sourcemap: 'linked',
    logLevel: 'info',
})

cpSync('vendor/lol-html/dist/lol_html_bg.wasm', 'build/lol_html_bg.wasm')
// Pin the module type so the bundle loads the same here (under this "type": "module" package) as in the zip.
writeFileSync('build/package.json', '{ "type": "commonjs" }\n')
