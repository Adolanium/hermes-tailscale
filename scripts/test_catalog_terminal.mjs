import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

// Exercise the shipped module with the host's three supported import surfaces.
// Only test-only exports are appended; its bundled loader and sizing code run.
const host = await build({
  stdin: {
    contents: `import * as R from 'react'; import * as J from 'react/jsx-runtime';
      export { R, J };
      export function atom(initial) { let value=initial; const listeners=new Set();
        return {get:()=>value,set:next=>{value=next;for(const f of listeners)f()},
          subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)}} }
      export const useValue=a=>R.useSyncExternalStore(a.subscribe,a.get);
      export const host={state:{}};
      export const Button=p=>R.createElement('button',p);
      export const Badge=p=>R.createElement('span',p);
      export const Tip=p=>p.children; export const haptic=()=>{};
      export const ROUTES_AREA='routes',SIDEBAR_NAV_AREA='sidebar',PALETTE_AREA='palette',
        KEYBINDS_AREA='keybinds',STATUSBAR_AREAS={};`,
    resolveDir: process.cwd(),
    sourcefile: 'catalog-browser-host.js',
  },
  bundle: true, write: false, format: 'esm',
  define: { 'process.env.NODE_ENV': '"development"' },
})
const plugin = (await readFile('catalog/desktop/plugin.js', 'utf8'))
  .replaceAll("from '@hermes/plugin-sdk'", "from '/host.js'")
  .replaceAll("from 'react'", "from '/react.js'")
  .replaceAll("from 'react/jsx-runtime'", "from '/jsx.js'") +
  '\nexport { loadTerminal, fitTerm };\n'
const resources = {
  '/': ['<!doctype html><meta charset="utf-8"><div id="term" style="width:720px;height:350px"></div>', 'text/html'],
  '/host.js': [host.outputFiles[0].text, 'text/javascript'],
  '/plugin.js': [plugin, 'text/javascript'],
  '/react.js': ["import {R} from '/host.js';export const {Fragment,useEffect,useMemo,useRef,useState}=R;", 'text/javascript'],
  '/jsx.js': ["import {J} from '/host.js';export const {jsx,jsxs}=J;", 'text/javascript'],
}
const server = createServer((req, res) => {
  const resource = resources[req.url]
  res.writeHead(resource ? 200 : 404, { 'Content-Type': resource?.[1] ?? 'text/plain' })
  res.end(resource?.[0] ?? 'Not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
const errors = [], external = []
let checks = 0
const equal = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label); checks++; console.log(`PASS ${label}`)
}
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/')) return route.continue()
    external.push(route.request().url()); return route.abort()
  })
  await page.goto(origin)
  await page.evaluate(async () => {
    // An unrelated global must never supply executable terminal code.
    window.Terminal = function UntrustedTerminal() { throw new Error('unexpected global loader') }
    window.originalGlobal = window.Terminal
    window.plugin = await import('/plugin.js')
    window.Ctor = await plugin.loadTerminal()
    window.term = new Ctor({ cols: 80, rows: 24, fontSize: 13, allowProposedApi: true })
    term.open(document.getElementById('term'))
    term.focus()
    window.keys = []
    window.subscription = term.onData(data => keys.push(data))
    await new Promise(resolve => term.write('\x1b[31mHello\x1b[0m world\r\n', resolve))
    await new Promise(resolve => term.write(new TextEncoder().encode('café 日本語\r\n'), resolve))
  })
  equal(await page.evaluate(async () => Ctor === await plugin.loadTerminal()), true, 'repeated terminal loads share the bundled constructor')
  equal(await page.evaluate(() => window.Terminal === originalGlobal), true, 'global Terminal is neither read nor replaced')
  equal(await page.evaluate(() => term.buffer.active.getLine(0).translateToString(true)), 'Hello world', 'ANSI text reaches the real terminal buffer')
  equal(await page.evaluate(() => term.buffer.active.getLine(0).getCell(0).getFgColor()), 1, 'ANSI red survives bundling')
  equal(await page.evaluate(() => term.buffer.active.getLine(1).translateToString(true)), 'café 日本語', 'UTF-8 bytes and wide characters render intact')
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('Hello world'))
  equal((await page.locator('.xterm-rows > div').first().textContent()).trim(), 'Hello world', 'terminal output is visible in the real browser renderer')
  await page.keyboard.type('hi')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowUp')
  equal(await page.evaluate(() => keys.join('')), 'hi\r\x1b[A', 'typed text, Enter and arrow keys emit PTY input')
  const sizes = await page.evaluate(() => {
    const el = document.getElementById('term')
    const initial = plugin.fitTerm(term, el)
    el.style.width = '360px'; el.style.height = '180px'
    const reduced = plugin.fitTerm(term, el)
    return { initial, reduced, actual: { cols: term.cols, rows: term.rows } }
  })
  equal(sizes.initial.cols > sizes.reduced.cols && sizes.initial.rows > sizes.reduced.rows, true, 'plugin sizing shrinks rows and columns with the container')
  equal(sizes.actual, sizes.reduced, 'reported dimensions match the live terminal')
  await page.evaluate(() => { subscription.dispose(); term.dispose(); keys.length = 0 })
  equal(await page.locator('.xterm').count(), 0, 'disposing removes the rendered terminal')
  await page.keyboard.type('unused')
  equal(await page.evaluate(() => keys), [], 'disposed input subscription sends no further keys')
  await page.evaluate(async () => {
    window.term = new Ctor({ cols: 80, rows: 24 })
    term.open(document.getElementById('term'))
    await new Promise(resolve => term.write('reopened', resolve))
  })
  equal(await page.evaluate(() => term.buffer.active.getLine(0).translateToString(true)), 'reopened', 'the cached constructor opens a fresh terminal after disposal')
  await page.evaluate(() => term.dispose())
  equal(await page.locator('style[data-hermes-terminal="xterm"],style[data-hermes-tailscale="xterm"]').count(), 1, 'terminal CSS is injected once')
  equal(external, [], 'all terminal behavior works with external requests blocked')
  equal(errors, [], 'no browser runtime errors')
  console.log(`${checks} packaged-terminal browser checks passed`)
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
