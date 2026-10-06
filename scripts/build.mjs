// dsh-rewind-pro build: esbuild -> lib/index.js (host ESM) + lib/client.js
// (loader closure for window.__ModuleLoader__) + .d.ts via tsc.
//
// The client bundle is NOT an IIFE: the DSH web shell materializes client
// plugins by calling window.__ModuleLoader__.load({ id, factory }). The
// factory receives a `require` that resolves the shell's frozen module table
// (react, @deepseek-ai/dsh-client-ui-*), so every host-provided module is an
// esbuild external and the bundle body runs inside our factory closure with
// hand-declared `module`/`exports` (matching the closure contract).

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const libDir = path.join(root, 'lib')
const PLUGIN_ID = 'dsh-rewind-pro'

// Host-provided modules resolved through the loader closure at runtime.
const CLIENT_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-runtime',
]

const tscDts = (args) => {
  const res = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ...args], {
    cwd: root,
    stdio: 'inherit',
  })
  if (res.status !== 0) {
    console.error('[build] tsc .d.ts emission failed')
    process.exit(res.status ?? 1)
  }
}

await rm(libDir, { recursive: true, force: true })
await mkdir(libDir, { recursive: true })

// --- host: plain ESM for Node ---
await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(libDir, 'index.js'),
  sourcemap: 'external',
  logLevel: 'info',
  banner: { js: '// dsh-rewind-pro host half (generated; source in src/)' },
})

// --- client: loader closure (external imports resolve via the factory `require`) ---
await build({
  // No extension: esbuild resolves index.tsx (the client entry uses JSX).
  entryPoints: [path.join(root, 'src/client/index')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  outfile: path.join(libDir, 'client.js'),
  sourcemap: 'external',
  logLevel: 'info',
  external: CLIENT_EXTERNALS,
  banner: {
    js:
      `// dsh-rewind-pro client half (generated; source in src/client/)\n` +
      `window.__ModuleLoader__.load({\n` +
      `  id: ${JSON.stringify(PLUGIN_ID)},\n` +
      `  factory: (require) => {\n` +
      `    var module = { exports: {} };\n` +
      `    var exports = module.exports;\n`,
  },
  footer: { js: `    return module.exports;\n  },\n});` },
})

// --- type declarations: lib/types (host) ---
// tsc refuses `--project` mixed with source files (TS5042), and none of the
// committed tsconfigs emits declarations, so we generate a throwaway project
// config (declarationDir -> lib/types, rootDir -> src) and delete it after.
const dtsConfig = path.join(libDir, '.tsconfig-dts.json')
await mkdir(path.join(libDir, 'types'), { recursive: true })
await writeFile(
  dtsConfig,
  JSON.stringify(
    {
      compilerOptions: {
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2023',
        lib: ['es2023'],
        strict: true,
        skipLibCheck: true,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: path.join(libDir, 'types'),
        rootDir: path.join(root, 'src'),
        types: ['node'],
        noUnusedLocals: false,
        noUnusedParameters: false,
      },
      include: [path.join(root, 'src', '**', '*.ts').replaceAll('\\', '/')],
      exclude: [path.join(root, 'src', 'client').replaceAll('\\', '/')],
    },
    null,
    2,
  ),
)
tscDts(['-p', dtsConfig])
await rm(dtsConfig, { force: true })

console.log('[build] done: lib/index.js, lib/client.js, lib/types')
