// Links from Tailscale output are checked before they are shown or opened.

import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { loadHelpers, source } from './helpers.mjs'

const h = loadHelpers()

const rejected = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  '  javascript:alert(1)  ',
  '\tjavascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  '\u0000javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
  'vbscript:msgbox(1)',
  '//evil.example',
  '//evil.example/x',
  '/x',
  'x',
  'not a url',
  'http://',
  'https://',
  'http://[',
  'ssh://host',
  'blob:https://example.com/1',
  '',
  null,
  undefined,
  {}
]

const accepted = [
  ['HTTPS://Login.Tailscale.com/a/abc123', 'https://login.tailscale.com/a/abc123'],
  ['http://example.com:8080/a?b=1#c', 'http://example.com:8080/a?b=1#c'],
  ['https://[fd7a:115c:a1e0::1]:8443/', 'https://[fd7a:115c:a1e0::1]:8443/'],
  ['http://[::1]:8642/', 'http://[::1]:8642/'],
  ['https://box.tail1234.ts.net/path?q=1#f', 'https://box.tail1234.ts.net/path?q=1#f'],
  ['http://100.64.0.1:8642/', 'http://100.64.0.1:8642/'],
  ['http://100.100.100.100', 'http://100.100.100.100/'],
  ['  https://login.tailscale.com/a/x  ', 'https://login.tailscale.com/a/x']
]

test('safeWebUrl rejects anything that is not an absolute http(s) link', () => {
  for (const value of rejected) assert.equal(h.safeWebUrl(value), '', JSON.stringify(value))
})

test('safeWebUrl keeps real links and returns the checked href', () => {
  for (const [value, href] of accepted) assert.equal(h.safeWebUrl(value), href, value)
})

test('parseStatus only keeps a web login URL and flags a blocked one', () => {
  const base = { BackendState: 'NeedsLogin', Peer: {}, User: {} }
  const ok = h.parseStatus({ ...base, AuthURL: 'https://login.tailscale.com/a/abc' })
  assert.equal(ok.authUrl, 'https://login.tailscale.com/a/abc')
  assert.equal(ok.authUrlBlocked, false)
  const bad = h.parseStatus({ ...base, AuthURL: 'javascript:alert(1)' })
  assert.equal(bad.authUrl, '')
  assert.equal(bad.authUrlBlocked, true)
  const none = h.parseStatus(base)
  assert.equal(none.authUrl, '')
  assert.equal(none.authUrlBlocked, false)
})

test('parseServeStatus drops a serve address that is not a web link', () => {
  for (const key of ['javascript:alert(1)//x', 'file:///etc/passwd', 'data:text/html,x']) {
    const serve = h.parseServeStatus({ Web: { [key]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } } } })
    assert.equal(serve.empty, false)
    assert.equal(serve.url, '', key)
    assert.equal(serve.hostPort, key)
  }
  const ipv6 = h.parseServeStatus({ Web: { '[fd7a:115c:a1e0::1]:8443': { Handlers: {} } } })
  assert.equal(ipv6.url, 'https://[fd7a:115c:a1e0::1]:8443/')
  const tsnet = h.parseServeStatus({ Web: { 'box.tail1234.ts.net:443': { Handlers: {} } } })
  assert.equal(tsnet.url, 'https://box.tail1234.ts.net/')
})

// openUrl sits in the runtime section; run it with the SDK pieces mocked.
function bootOpenUrl() {
  const opened = []
  const notices = []
  const context = vm.createContext({ URL, opened, notices })
  const pick = name => {
    const at = source.indexOf(name)
    assert.ok(at >= 0, name)
    return source.slice(at, source.indexOf('\n}\n', at) + 3)
  }
  const start = source.indexOf('const BLOCKED_LINK_MESSAGE')
  vm.runInContext(
    `
    const os = { openExternal: url => opened.push(url) };
    function tap() {}
    function say(message) { notices.push(message) }
    ${pick('function safeWebUrl(')}
    ${source.slice(start, source.indexOf('\n', start) + 1)}
    ${pick('function openUrl(')}
    globalThis.openUrl = openUrl;
    globalThis.DOWNLOAD_URL = ${JSON.stringify(source.match(/const DOWNLOAD_URL = '([^']+)'/)[1])};
    globalThis.QUAD100_URL = ${JSON.stringify(source.match(/const QUAD100_URL = '([^']+)'/)[1])};
  `,
    context
  )
  return { openUrl: context.openUrl, context, opened, notices }
}

test('openUrl blocks non-web links with a message and opens the checked href', () => {
  const r = bootOpenUrl()
  for (const value of rejected) r.openUrl(value)
  assert.deepEqual(r.opened, [])
  assert.equal(r.notices.length, rejected.length)
  assert.match(r.notices[0], /not an http or https address/)
  for (const [value, href] of accepted) r.openUrl(value)
  assert.deepEqual(r.opened, accepted.map(([, href]) => href))
})

test('the plugin constants still open', () => {
  const r = bootOpenUrl()
  r.openUrl(r.context.DOWNLOAD_URL)
  r.openUrl(r.context.QUAD100_URL)
  assert.deepEqual(r.opened, ['https://tailscale.com/download', 'http://100.100.100.100/'])
  assert.deepEqual(r.notices, [])
})
