// Builds the card Soft Yes draws inside a chat: one HTML file, script and styles inline, nothing fetched.
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

const out = await build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  minify: !process.argv.includes('--dev'),
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  write: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
})
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
const css = (await build({ entryPoints: ['src/style.css'], bundle: true, minify: true, write: false })).outputFiles[0].text
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Soft Yes</title>
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script>${js}</script>
</body>
</html>
`
writeFileSync('../softyes/mcp_app.html', html)
console.log(`mcp_app.html ${(html.length / 1024).toFixed(1)} KB (js ${(js.length / 1024).toFixed(1)}, css ${(css.length / 1024).toFixed(1)})`)
