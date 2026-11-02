import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// monaco-vscode-api ships CSS that its code imports as strings; the library's README requires this plugin.
const vscodeCssAsString: Plugin = {
  name: 'load-vscode-css-as-string',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    const resolved = await this.resolve(source, importer, options)
    if (resolved == null) return undefined
    if (/node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/.test(resolved.id)) {
      return { ...resolved, id: resolved.id + '?inline' }
    }
    return undefined
  }
}

// Cross-origin isolation: the TypeScript web server needs SharedArrayBuffer for cross-file semantics,
// and it also enables performance.measureUserAgentSpecificMemory() for the memory measurement.
const isolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'cross-origin'
}

export default defineConfig({
  base: './',
  plugins: [vscodeCssAsString, react()],
  build: { target: 'esnext', chunkSizeWarningLimit: 100_000 },
  worker: { format: 'es' },
  server: { port: 5174, strictPort: true, host: '127.0.0.1', headers: isolationHeaders },
  preview: { port: 5175, strictPort: true, host: '127.0.0.1', headers: isolationHeaders },
  optimizeDeps: {
    include: [
      '@codingame/monaco-vscode-api',
      '@codingame/monaco-vscode-api/extensions',
      '@codingame/monaco-vscode-api/monaco',
      'vscode/localExtensionHost'
    ]
  },
  resolve: { dedupe: ['vscode', 'monaco-editor'] }
})
