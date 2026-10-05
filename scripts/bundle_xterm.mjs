import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

// This is a build-time dependency. The catalog ships no runtime npm imports.
const result = await build({
  stdin: {
    contents: "import { Terminal } from '@xterm/xterm'; export { Terminal };",
    resolveDir: process.cwd(),
    sourcefile: 'catalog-xterm.js',
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'catalogXterm',
  target: 'es2022',
  minify: true,
  define: { self: 'globalThis' },
  legalComments: 'inline',
})
const license = await readFile('node_modules/@xterm/xterm/LICENSE', 'utf8')
// Keep initialization lazy and module-private. Do not add a global Terminal.
process.stdout.write(`/* Bundled @xterm/xterm 5.5.0.\n${license}\n*/\nfunction createCatalogTerminal() {\n${result.outputFiles[0].text}return catalogXterm.Terminal\n}\n`)
