// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

const trimTrailingWhitespace = {
  name: 'trim-trailing-whitespace',
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type === 'chunk') {
        output.code = output.code.replace(/[\t ]+$/gmu, '')
      }
    }
  }
}

// A GitHub Action ships as a single committed file (`dist/index.js`). The
// `@actions/attest` dependency (bundled for the first time by the `github`
// signer) pulls in transitive code that uses dynamic `import()` — notably the
// proxy-agent stack, which lazily and optionally loads native auth backends
// (e.g. `kerberos`) inside guarded try/catch blocks. Rollup would otherwise
// emit multiple chunks, which is incompatible with a single `output.file`, so
// dynamic imports are inlined into the one chunk.
const OPTIONAL_NATIVE_DEPS = new Set(['kerberos'])

const config = {
  input: 'src/index.ts',
  output: {
    esModule: true,
    file: 'dist/index.js',
    format: 'es',
    inlineDynamicImports: true,
    sourcemap: true
  },
  // Optional native dependencies are only reached down guarded dynamic-import
  // paths this action never exercises (proxy Negotiate auth); keep them as
  // external so an unresolved-module warning cannot fail the build.
  onwarn(warning, defaultHandler) {
    if (
      warning.code === 'UNRESOLVED_IMPORT' &&
      typeof warning.exporter === 'string' &&
      OPTIONAL_NATIVE_DEPS.has(warning.exporter)
    ) {
      return
    }
    defaultHandler(warning)
  },
  plugins: [
    typescript(),
    json(),
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    trimTrailingWhitespace
  ]
}

export default config
