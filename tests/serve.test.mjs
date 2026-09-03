// Publish (tailscale serve). The port is user-editable and checked before
// anything on the tailnet can reach it.

import assert from 'node:assert/strict'
import test from 'node:test'
import { loadHelpers } from './helpers.mjs'

const h = loadHelpers()

test('parsePort accepts 1..65535 and nothing else', () => {
  assert.equal(h.parsePort(9119), 9119)
  assert.equal(h.parsePort('9119'), 9119)
  assert.equal(h.parsePort(' 8080 '), 8080)
  assert.equal(h.parsePort('1'), 1)
  assert.equal(h.parsePort('65535'), 65535)
  for (const bad of ['0', '65536', '-1', '80.5', '1e3', 'abc', '', null, undefined, '9119; reboot', '9119 --funnel', '0x23']) {
    assert.equal(h.parsePort(bad), 0, JSON.stringify(bad))
  }
})

test('serveArgs is always serve --bg --yes plus a clean integer, never funnel', () => {
  assert.equal(h.serveArgs(9119), 'serve --bg --yes 9119')
  assert.equal(h.serveArgs('3000'), 'serve --bg --yes 3000')
  assert.equal(h.serveArgs('3000; tailscale funnel 3000'), 'serve --bg --yes 0')
  assert.doesNotMatch(h.serveArgs(9119), /funnel/)
})

test('portProbeCommand hits loopback only and discards the body per platform', () => {
  assert.equal(h.portProbeCommand(9119, 'windows'), 'curl.exe -s -o NUL -m 3 http://127.0.0.1:9119/', 'curl.exe so PowerShell does not alias it to Invoke-WebRequest')
  assert.equal(h.portProbeCommand(9119, 'linux'), 'curl -s -o /dev/null -m 3 http://127.0.0.1:9119/')
  assert.equal(h.portProbeCommand(9119, 'darwin'), 'curl -s -o /dev/null -m 3 http://127.0.0.1:9119/')
  assert.equal(h.portProbeCommand('9119; id', 'linux'), 'curl -s -o /dev/null -m 3 http://127.0.0.1:0/')
})

test('classifyPortProbe reads curl exit codes', () => {
  assert.equal(h.classifyPortProbe({ code: 0 }), 'open')
  assert.equal(h.classifyPortProbe({ code: 22 }), 'open', 'HTTP 4xx/5xx still means something is listening')
  assert.equal(h.classifyPortProbe({ code: 7 }), 'closed')
  assert.equal(h.classifyPortProbe({ code: 28 }), 'unknown', 'timeout')
  assert.equal(h.classifyPortProbe({ code: 127 }), 'unknown', 'curl missing on posix')
  assert.equal(h.classifyPortProbe({ code: 9009 }), 'unknown', 'curl missing on windows')
  assert.equal(h.classifyPortProbe({ code: 1 }), 'unknown')
  assert.equal(h.classifyPortProbe(null), 'unknown')
  assert.equal(h.classifyPortProbe({}), 'unknown')
})
