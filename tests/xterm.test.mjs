// xterm supply chain. The SSH overlay only runs xterm bytes whose SHA-384
// matches the pin in plugin.js, whether they came from disk or a CDN.

import assert from 'node:assert/strict'
import { createHash, randomBytes, webcrypto } from 'node:crypto'
import test from 'node:test'
import { loadHelpers, source } from './helpers.mjs'

const h = loadHelpers()

function constant(name) {
  const match = source.match(new RegExp(`^const ${name} = (.+)$`, 'm'))
  assert.ok(match, `${name} missing`)
  return match[1]
}

const version = JSON.parse(constant('XTERM_VERSION').replace(/'/g, '"'))
const pin = JSON.parse(constant('XTERM_SHA384').replace(/'/g, '"'))
const urls = (() => {
  const start = source.indexOf('const XTERM_URLS = [')
  const end = source.indexOf(']', start)
  return source
    .slice(start, end)
    .split('\n')
    .slice(1)
    .map(line => line.trim().replace(/,$/, '').replace(/^`|`$/g, ''))
    .filter(Boolean)
    .map(line => line.replace('${XTERM_VERSION}', version).replace('${XTERM_FILE}', 'xterm.js'))
})()

test('the pin is a full sha384 and the URLs point at the raw npm file, not a CDN build', () => {
  assert.match(pin, /^sha384-[A-Za-z0-9+/]{64}$/)
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.ok(urls.length >= 2, 'need at least two mirrors')
  for (const url of urls) {
    assert.ok(url.startsWith('https://'), url)
    assert.ok(url.includes(`@xterm/xterm@${version}/lib/xterm.js`), url)
    assert.ok(!url.includes('+esm'), 'jsDelivr +esm output is generated and not pinnable')
    assert.ok(!url.includes('.min.js'), 'jsDelivr .min.js output is generated and not pinnable')
    assert.ok(!url.includes('esm.sh'), 'esm.sh rebuilds output and cannot be pinned')
  }
})

test('xtermSources tries the local copy first, then every mirror', () => {
  const list = h.xtermSources('C:\\Users\\me\\.hermes\\desktop-plugins\\', 'windows', 'hermes-tailscale', 'xterm.js', urls)
  assert.equal(list[0].kind, 'file')
  assert.equal(list[0].path, 'C:\\Users\\me\\.hermes\\desktop-plugins\\hermes-tailscale\\xterm.js')
  assert.deepEqual([...list.slice(1).map(s => s.url)], urls)
  assert.ok(list.slice(1).every(s => s.kind === 'url'))
})

test('xtermSources skips the local copy when the plugins root is unknown', () => {
  const list = h.xtermSources('', 'linux', 'hermes-tailscale', 'xterm.js', urls)
  assert.equal(list.length, urls.length)
  assert.ok(list.every(s => s.kind === 'url'))
  assert.equal(h.xtermSources('', 'linux', 'hermes-tailscale', 'xterm.js', []).length, 0)
})

test('integrityMatches needs an exact 64-char digest and tolerates the sha384- prefix', () => {
  const digest = pin.slice('sha384-'.length)
  assert.equal(h.integrityMatches(pin, digest), true)
  assert.equal(h.integrityMatches(digest, digest), true)
  assert.equal(h.integrityMatches(pin, digest.slice(0, -1) + (digest.endsWith('A') ? 'B' : 'A')), false)
  assert.equal(h.integrityMatches(pin, digest.slice(0, 63)), false)
  assert.equal(h.integrityMatches(pin, ''), false)
  assert.equal(h.integrityMatches('', ''), false)
  assert.equal(h.integrityMatches('sha384-short', 'short'), false)
  assert.equal(h.integrityMatches(pin, null), false)
})

test('bytesToBase64 agrees with Buffer for every padding case', () => {
  for (let len = 0; len <= 12; len += 1) {
    const bytes = randomBytes(len)
    assert.equal(h.bytesToBase64(new Uint8Array(bytes)), bytes.toString('base64'), `len ${len}`)
  }
  const big = randomBytes(4096)
  assert.equal(h.bytesToBase64(new Uint8Array(big)), big.toString('base64'))
  assert.equal(h.bytesToBase64(new Uint8Array([])), '')
  assert.equal(h.bytesToBase64(new Uint8Array([0xff, 0xfe, 0xfd])), '//79')
})

test('SHA-384 via WebCrypto plus bytesToBase64 matches node:crypto', async () => {
  const bytes = new TextEncoder().encode('!function(e,t){ /* pretend xterm */ }(globalThis)')
  const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-384', bytes))
  const viaHelper = h.bytesToBase64(digest)
  const viaNode = createHash('sha384').update(bytes).digest('base64')
  assert.equal(viaHelper, viaNode)
  assert.equal(h.integrityMatches(`sha384-${viaNode}`, viaHelper), true)
})

function importText(text) {
  return import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)
}

// A UMD header shaped like xterm's. Under plain ESM `typeof exports` may be
// 'object' (it is in Node), which would send Terminal to module.exports and
// lose it. The wrapper must force the global branch.
const fakeUmd = `!function(e,t){if("object"==typeof exports&&"object"==typeof module)module.exports=t();else if("function"==typeof define&&define.amd)define([],t);else{var i=t();for(var s in i)("object"==typeof exports?exports:e)[s]=i[s]}}(globalThis,(()=>({ Terminal: function FakeTerminal(){} })));`

test('wrapXtermModule makes a UMD bundle export Terminal when imported as ESM', async t => {
  t.after(() => {
    delete globalThis.Terminal
  })
  const mod = await importText(h.wrapXtermModule(fakeUmd))
  assert.equal(typeof mod.default, 'function')
  assert.equal(mod.default.name, 'FakeTerminal')
  assert.equal(globalThis.Terminal, mod.default)
})

test('wrapXtermModule leaves the verified source untouched in the middle', () => {
  const wrapped = h.wrapXtermModule(fakeUmd)
  assert.ok(wrapped.includes(`\n${fakeUmd}\n`))
  assert.ok(wrapped.startsWith('let exports, module, define;\n'))
})

// Opt-in. Downloads the pinned file from every mirror, checks the hash, and
// runs the first copy through the wrapper to prove Terminal comes out.
// Run when bumping XTERM_VERSION: XTERM_VERIFY=1 node --test tests/xterm.test.mjs
test('every mirror serves bytes that match the pin', { skip: !process.env.XTERM_VERIFY }, async t => {
  t.after(() => {
    delete globalThis.Terminal
  })
  let first = null
  for (const url of urls) {
    const response = await fetch(url)
    assert.equal(response.ok, true, `${url} returned ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const digest = createHash('sha384').update(bytes).digest('base64')
    assert.equal(h.integrityMatches(pin, digest), true, `${url} does not match the pin`)
    if (!first) first = bytes
  }
  const mod = await importText(h.wrapXtermModule(new TextDecoder().decode(first)))
  assert.equal(typeof mod.default, 'function', 'real xterm did not yield a Terminal constructor')
})
