// Shell-host OS and the remote status route.
//
// A Windows desktop connected to a Linux gateway must not send `cmd` to that
// host, and must reassemble `tailscale status --json` from byte chunks instead
// of reading the desktop cache file. Local connections keep the cache route.

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { loadHelpers, source } from './helpers.mjs'

const h = loadHelpers()
const POSIX = process.platform !== 'win32'
const posixTest = POSIX ? test : test.skip
const WINDOWS_NAV = { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }

function chunkSize() {
  const match = source.match(/const REMOTE_STATUS_CHUNK = (\d+)/)
  assert.ok(match, 'REMOTE_STATUS_CHUNK missing')
  return Number(match[1])
}

function bigStatus() {
  const chunk = chunkSize()
  const head =
    '{"BackendState":"Running","Peer":{},"User":{},"Self":{"ID":"self","Online":true,"OS":"linux","TailscaleIPs":["100.1.1.1"],"HostName":"'
  const pad = 'a'.repeat(chunk - 1 - head.length)
  assert.ok(pad.length > 0, 'status head is longer than one chunk')
  const json = `${head}${pad}日${'b'.repeat(9000)}"}}`
  const bytes = new TextEncoder().encode(json)
  assert.ok(bytes.length > 8192)
  assert.equal(bytes[chunk - 1], 0xe6)
  assert.equal(bytes[chunk], 0x97)
  assert.equal(bytes[chunk + 1], 0xa5)
  assert.equal(JSON.parse(json).Self.HostName.includes('日'), true)
  return { json, bytes, chunk }
}

test('classifyShellHost maps uname, needs evidence for Windows, and leaves unclear answers empty', () => {
  assert.equal(h.classifyShellHost({ code: 0, stdout: 'Linux\n' }), 'linux')
  assert.equal(h.classifyShellHost({ code: 0, stdout: 'linux\r\n' }), 'linux')
  assert.equal(h.classifyShellHost({ code: 0, stdout: 'Darwin\n' }), 'darwin')
  assert.equal(h.classifyShellHost({ code: 0, stdout: 'FreeBSD\n' }), 'linux')
  assert.equal(h.classifyShellHost({ code: 1, stdout: '', stderr: "'uname' is not recognized as an internal or external command" }), 'windows')
  assert.equal(h.classifyShellHost({ code: 1, stdout: '', stderr: "The term 'uname' is not recognized as a name of a cmdlet" }), 'windows')
  assert.equal(h.classifyShellHost({ code: 9009, stdout: '', stderr: '' }), 'windows')
  assert.equal(h.classifyShellHost({ code: 127, stdout: '', stderr: 'uname: not found' }), '')
  assert.equal(h.classifyShellHost({ code: 0, stdout: '' }), '')
  assert.equal(h.classifyShellHost(null), '')
})

test('base64ToBytes rejoins a code point split across chunks', () => {
  const bytes = new TextEncoder().encode('日')
  assert.equal(bytes.length, 3)
  const parts = [bytes.slice(0, 2), bytes.slice(2)]
  const joined = new Uint8Array(3)
  let offset = 0
  for (const part of parts) {
    const decoded = h.base64ToBytes(h.bytesToBase64(part).replace(/(.{4})/g, '$1\n'))
    joined.set(decoded, offset)
    offset += decoded.length
  }
  assert.deepEqual(joined, bytes)
  assert.equal(new TextDecoder().decode(joined), '日')
})

test('remote status commands stay POSIX and reject unsafe paths', () => {
  const chunk = chunkSize()
  const capture = h.remoteStatusCaptureCommand({ path: 'tailscale' }, 'linux')
  assert.match(capture, /umask 077/)
  assert.match(capture, /mktemp "\$\{TMPDIR:-\/tmp\}\/hermes-tailscale-status\.XXXXXX"/)
  assert.match(capture, /'tailscale' status --json > "\$f"/)
  assert.equal(capture.includes('cmd '), false)
  assert.equal(
    h.remoteStatusChunkCommand('/tmp/hermes-tailscale-status.abc', 1, chunk),
    `tail -c +1 '/tmp/hermes-tailscale-status.abc' | head -c ${chunk} | base64`
  )
  assert.equal(h.remoteStatusChunkCommand('/tmp/hermes-tailscale-status.abc', 1, chunk + 1), '')
  assert.equal(h.remoteStatusChunkCommand('/tmp/$(id)', 1, 10), '')
  assert.equal(h.remoteStatusRemoveCommand('/tmp/hermes-tailscale-status.abc'), "rm -f '/tmp/hermes-tailscale-status.abc'")
  const parsed = h.parseRemoteStatusCapture('  42\n/tmp/hermes-tailscale-status.abc\n')
  assert.equal(parsed && parsed.path, '/tmp/hermes-tailscale-status.abc')
  assert.equal(parsed && parsed.size, 42)
  assert.equal(h.parseRemoteStatusCapture('1\n/tmp/$(id)\n'), null)
})

// probeLocalPort sits after refresh(), outside the runtime slice.
function portProbeSource() {
  const at = source.indexOf('async function probeLocalPort(')
  assert.ok(at >= 0)
  return source.slice(at, source.indexOf('\n}\n', at) + 3)
}

function bootRuntime({ connection, connectionId = 'local', nav = WINDOWS_NAV, cachedBin = { path: 'tailscale' }, request, readFileText, desktopPluginsRoot } = {}) {
  const link = connection || { id: connectionId }
  const commands = []
  let reads = 0
  let roots = 0
  const context = vm.createContext({
    TextDecoder,
    Uint8Array,
    navigator: nav,
    host: {
      state: {
        gateway: { get: () => 'open' },
        connectionId: { get: () => link.id }
      },
      request: async (method, args) => {
        assert.equal(method, 'shell.exec')
        commands.push(args.command)
        return request(args.command)
      }
    },
    window: {
      hermesDesktop: {
        readFileText: async path => {
          reads += 1
          if (readFileText) return readFileText(path)
          throw new Error(`readFileText ${path}`)
        },
        desktopPluginsRoot: async () => {
          roots += 1
          if (desktopPluginsRoot) return desktopPluginsRoot()
          throw new Error('desktopPluginsRoot')
        }
      }
    }
  })
  const start = source.indexOf('const TAILDROP = {')
  const end = source.indexOf('async function refresh()')
  assert.ok(start >= 0 && end > start)
  const binLiteral = cachedBin === null ? 'null' : JSON.stringify(cachedBin)
  vm.runInContext(
    `
    const TAILDROP_AVAILABLE = 1;
    const PLUGIN_ID = 'hermes-tailscale';
    const CACHE_FILE = 'status-cache.json';
    let cachedBin = ${binLiteral};
    let cachedRoot = '';
    let cachedOutPath = null;
    ${source.slice(start, end)}
    ${portProbeSource()}
    globalThis.runtime = { loadSnapshot, shellHostKind, removeCacheFile, probeLocalPort, terminalBin, setCachedOutPath: v => { cachedOutPath = v }, getCachedBin: () => cachedBin };
  `,
    context
  )
  return {
    ...context.runtime,
    context,
    commands,
    link,
    reads: () => reads,
    roots: () => roots
  }
}

function noCmd(commands) {
  for (const command of commands) assert.equal(command.includes('cmd '), false, command)
}

test('remote Linux gateway on a Windows desktop reassembles a status larger than 8 KB', async () => {
  const { json, bytes, chunk } = bigStatus()
  const tempPath = '/tmp/hermes-tailscale-status.abc'
  const r = bootRuntime({
    connectionId: 'linux-box',
    request(command) {
      if (command === 'uname -s') return { code: 0, stdout: 'Linux\n' }
      if (command.includes('mktemp')) return { code: 0, stdout: `${bytes.length}\n${tempPath}\n` }
      if (command.includes('| base64')) {
        const offset = Number(command.match(/tail -c \+(\d+)/)[1])
        const count = Number(command.match(/head -c (\d+)/)[1])
        const slice = bytes.subarray(offset - 1, offset - 1 + count)
        const wrapped = Buffer.from(slice).toString('base64').replace(/(.{76})/g, '$1\n')
        return { code: 0, stdout: `${wrapped}\n` }
      }
      if (command.startsWith('rm ')) return { code: 0, stdout: '' }
      if (command.includes('serve status')) return { code: 0, stdout: '{}' }
      if (command.includes('switch --list')) return { code: 0, stdout: '[]' }
      return { code: 0, stdout: '{}' }
    }
  })
  const result = await r.loadSnapshot()
  assert.equal(result.kind, 'ready')
  assert.equal(result.status.rows[0].hostName.includes('日'), true)
  assert.equal(result.status.rows[0].hostName.includes('\uFFFD'), false)
  assert.equal(JSON.stringify(result).includes(json.slice(json.indexOf('日'), json.indexOf('日') + 8)), true)
  noCmd(r.commands)
  assert.equal(r.reads(), 0)
  assert.equal(r.roots(), 0)
  const chunks = r.commands.filter(command => command.includes('| base64'))
  assert.ok(chunks.length >= 2)
  assert.match(chunks[0], new RegExp(`tail -c \\+1 .*\\| head -c ${chunk} \\| base64`))
  assert.equal(Number(chunks[1].match(/tail -c \+(\d+)/)[1]), chunk + 1)
  assert.equal(r.commands.filter(command => command === 'uname -s').length, 1)
  assert.ok(r.commands.some(command => command === `rm -f '${tempPath}'`))
  assert.equal(r.commands.some(command => command.includes('status-cache')), false)
})

test('remote POSIX status is probed once per connection and re-probed after a switch', async () => {
  const status = JSON.stringify({
    BackendState: 'Running',
    Peer: {},
    User: {},
    Self: { ID: 'self', HostName: 'box', Online: true, OS: 'linux' }
  })
  const bytes = new TextEncoder().encode(status)
  const tempPath = '/tmp/hermes-tailscale-status.switch'
  const r = bootRuntime({
    connection: { id: 'gw-a' },
    cachedBin: null,
    request(command) {
      if (command === 'uname -s') return { code: 0, stdout: r.link.id === 'gw-a' ? 'Linux\n' : 'Darwin\n' }
      if (command.includes('version --json')) return { code: 0, stdout: '{}' }
      if (command.includes('mktemp')) return { code: 0, stdout: `${bytes.length}\n${tempPath}\n` }
      if (command.includes('| base64')) {
        const offset = Number(command.match(/tail -c \+(\d+)/)[1])
        const count = Number(command.match(/head -c (\d+)/)[1])
        return { code: 0, stdout: Buffer.from(bytes.subarray(offset - 1, offset - 1 + count)).toString('base64') }
      }
      if (command.startsWith('rm ')) return { code: 0, stdout: '' }
      if (command.includes('serve status')) return { code: 0, stdout: '{}' }
      if (command.includes('switch --list')) return { code: 0, stdout: '[]' }
      return { code: 0, stdout: '{}' }
    }
  })
  assert.equal((await r.loadSnapshot()).kind, 'ready')
  assert.equal((await r.loadSnapshot()).kind, 'ready')
  assert.equal(r.commands.filter(command => command === 'uname -s').length, 1)
  assert.equal(r.commands.filter(command => command.includes('version --json')).length, 1)
  r.link.id = 'gw-b'
  assert.equal((await r.loadSnapshot()).kind, 'ready')
  assert.equal(r.commands.filter(command => command === 'uname -s').length, 2)
  assert.equal(r.commands.filter(command => command.includes('version --json')).length, 2)
  noCmd(r.commands)
  assert.equal(r.reads(), 0)
})

test('remote Linux daemon failure still removes the temp file', async () => {
  const tempPath = '/tmp/hermes-tailscale-status.daemon'
  const r = bootRuntime({
    connectionId: 'linux-box',
    request(command) {
      if (command === 'uname -s') return { code: 0, stdout: 'Linux\n' }
      if (command.includes('mktemp')) {
        return { code: 1, stdout: `0\n${tempPath}\n`, stderr: 'failed to connect to local tailscaled' }
      }
      if (command.startsWith('rm ')) return { code: 0, stdout: '' }
      return { code: 0, stdout: '{}' }
    }
  })
  const result = await r.loadSnapshot()
  assert.equal(result.kind, 'daemon')
  assert.ok(r.commands.some(command => command === `rm -f '${tempPath}'`))
  assert.equal(r.commands.some(command => command.includes('| base64')), false)
  assert.equal(r.reads(), 0)
  assert.equal(result.message.includes('status-cache'), false)
})

test('remote Windows gateway reports an honest limit when status does not fit', async () => {
  const r = bootRuntime({
    connectionId: 'win-box',
    request(command) {
      if (command === 'uname -s') {
        return { code: 1, stdout: '', stderr: "'uname' is not recognized as an internal or external command" }
      }
      if (command.includes('status --json')) return { code: 0, stdout: 'truncated-tail}' }
      return { code: 0, stdout: '{}' }
    }
  })
  const result = await r.loadSnapshot()
  assert.equal(result.kind, 'error')
  assert.match(result.message, /only part of the Tailscale status/)
  assert.match(result.message, /remote Windows gateway/)
  assert.match(result.message, /local connection/)
  assert.equal(result.message.includes('status-cache'), false)
  assert.equal(result.message.includes('cache write'), false)
  noCmd(r.commands)
  assert.equal(r.commands.some(command => command.includes('mktemp')), false)
  assert.equal(r.reads(), 0)
  assert.equal(r.roots(), 0)
})

test('remote Windows gateway accepts a status that fits in one response', async () => {
  const status = JSON.stringify({
    BackendState: 'Running',
    Peer: {},
    User: {},
    Self: { ID: 'self', HostName: 'winbox', Online: true, OS: 'windows' }
  })
  const r = bootRuntime({
    connectionId: 'win-box',
    request(command) {
      if (command === 'uname -s') return { code: 1, stdout: '', stderr: 'not recognized' }
      if (command.includes('serve status')) return { code: 0, stdout: '{}' }
      if (command.includes('switch --list')) return { code: 0, stdout: '[]' }
      if (command.includes('status --json')) return { code: 0, stdout: status }
      return { code: 0, stdout: '{}' }
    }
  })
  const result = await r.loadSnapshot()
  assert.equal(result.kind, 'ready')
  assert.equal(result.status.rows[0].hostName, 'winbox')
  assert.ok(r.commands.some(command => command.includes('"tailscale" status --json')))
  noCmd(r.commands)
  assert.equal(r.reads(), 0)
})

function localRequest(command) {
  if (command === 'uname -s') throw new Error('local connection probed the shell host')
  if (command.includes('serve status')) return { code: 0, stdout: '{}' }
  if (command.includes('switch --list')) return { code: 0, stdout: '[]' }
  if (command.includes(' > ') || command.includes('cmd /c')) return { code: 0, stdout: '' }
  return { code: 0, stdout: '{}' }
}

for (const [name, connectionId] of [
  ['local', 'local'],
  ['unknown', null]
]) {
  test(`${name} connection on Windows still uses the desktop cache`, async () => {
    const status = JSON.stringify({ BackendState: 'Running', Peer: {}, User: {} })
    const r = bootRuntime({
      connectionId,
      readFileText: async () => ({ text: status }),
      desktopPluginsRoot: async () => 'C:\\Users\\me\\AppData\\Local\\hermes\\desktop-plugins',
      request: localRequest
    })
    const result = await r.loadSnapshot()
    assert.equal(result.kind, 'ready')
    assert.equal(r.reads(), 1)
    assert.equal(r.roots(), 1)
    assert.ok(r.commands.some(command => command.includes('cmd /c')))
    assert.equal(r.commands.some(command => command === 'uname -s'), false)
    assert.equal(r.commands.some(command => command.includes('mktemp')), false)
    assert.equal(r.commands.some(command => command.includes('| base64')), false)
  })
}

posixTest('a real POSIX shell round-trips a chunked status and deletes the temp file', () => {
  const { json, bytes, chunk } = bigStatus()
  const dir = mkdtempSync(join(tmpdir(), 'hermes-ts-'))
  const script = join(dir, 'tailscale')
  const payload = join(dir, 'payload.json')
  try {
    writeFileSync(payload, json)
    writeFileSync(script, `#!/bin/sh\ncat ${JSON.stringify(payload)}\n`)
    chmodSync(script, 0o755)
    const captured = spawnSync('sh', ['-c', h.remoteStatusCaptureCommand({ path: script }, 'linux')], { encoding: 'utf8' })
    assert.equal(captured.status, 0, captured.stderr)
    const info = h.parseRemoteStatusCapture(captured.stdout)
    assert.ok(info)
    assert.equal(info.size, bytes.length)
    const parts = []
    let offset = 1
    while (offset <= info.size) {
      const count = Math.min(chunk, info.size - offset + 1)
      const chunkRun = spawnSync('sh', ['-c', h.remoteStatusChunkCommand(info.path, offset, count)], { encoding: 'utf8' })
      assert.equal(chunkRun.status, 0, chunkRun.stderr)
      assert.ok(chunkRun.stdout.length < 3900, `chunk stdout is ${chunkRun.stdout.length} chars`)
      const decoded = h.base64ToBytes(chunkRun.stdout)
      assert.equal(decoded.length, count)
      parts.push(decoded)
      offset += decoded.length
    }
    const all = new Uint8Array(bytes.length)
    let at = 0
    for (const part of parts) {
      all.set(part, at)
      at += part.length
    }
    assert.deepEqual(Buffer.from(all), Buffer.from(bytes))
    assert.equal(existsSync(info.path), true)
    const removed = spawnSync('sh', ['-c', h.remoteStatusRemoveCommand(info.path)], { encoding: 'utf8' })
    assert.equal(removed.status, 0, removed.stderr)
    assert.equal(existsSync(info.path), false)

    writeFileSync(script, '#!/bin/sh\necho failed to connect to local tailscaled >&2\nexit 1\n')
    chmodSync(script, 0o755)
    const failed = spawnSync('sh', ['-c', h.remoteStatusCaptureCommand({ path: script }, 'linux')], { encoding: 'utf8' })
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /failed to connect to local tailscaled/)
    const leaked = h.parseRemoteStatusCapture(failed.stdout)
    assert.ok(leaked)
    assert.equal(existsSync(leaked.path), true)
    spawnSync('sh', ['-c', h.remoteStatusRemoveCommand(leaked.path)], { encoding: 'utf8' })
    assert.equal(existsSync(leaked.path), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function posixGateway({ bytes, tempPath = '/tmp/hermes-tailscale-status.t', chunk = null, uname = () => ({ code: 0, stdout: 'Linux\n' }), inline } = {}) {
  return command => {
    if (command === 'uname -s') return uname()
    if (command.includes('version --json')) return { code: 0, stdout: '{}' }
    if (command.includes('mktemp')) return { code: 0, stdout: `${bytes.length}\n${tempPath}\n` }
    if (command.includes('| base64')) {
      const offset = Number(command.match(/tail -c \+(\d+)/)[1])
      const count = Number(command.match(/head -c (\d+)/)[1])
      if (chunk) return chunk(offset, count)
      return { code: 0, stdout: Buffer.from(bytes.subarray(offset - 1, offset - 1 + count)).toString('base64') }
    }
    if (command.startsWith('rm ')) return { code: 0, stdout: '' }
    if (command.includes('serve status')) return { code: 0, stdout: '{}' }
    if (command.includes('switch --list')) return { code: 0, stdout: '[]' }
    if (command.includes('status --json') && inline) return inline()
    return { code: 0, stdout: '{}' }
  }
}

const smallStatus = JSON.stringify({ BackendState: 'Running', Peer: {}, User: {}, Self: { ID: 's', HostName: 'gw', Online: true, OS: 'linux' } })

test('an unclear OS probe is not cached and the next poll probes again', async () => {
  const bytes = new TextEncoder().encode(smallStatus)
  let probes = 0
  const r = bootRuntime({
    connectionId: 'gw',
    request: posixGateway({ bytes, uname: () => (++probes === 1 ? { code: 1, stdout: '', stderr: 'timed out' } : { code: 0, stdout: 'Linux\n' }) })
  })
  const first = await r.loadSnapshot()
  assert.equal(first.kind, 'error')
  assert.match(first.message, /Could not tell which OS/)
  assert.equal((await r.loadSnapshot()).kind, 'ready')
  assert.equal(probes, 2)
  noCmd(r.commands)
})

test('overlapping callers share one OS probe', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let probes = 0
  const r = bootRuntime({
    connectionId: 'gw',
    request: async command => {
      if (command === 'uname -s') { probes += 1; await gate; return { code: 0, stdout: 'Linux\n' } }
      return { code: 0, stdout: '' }
    }
  })
  const both = Promise.all([r.shellHostKind(), r.shellHostKind()])
  release()
  assert.deepEqual(await both, ['linux', 'linux'])
  assert.equal(probes, 1)
})

test('a failed chunk still removes the temp file and falls back to one inline response', async () => {
  const bytes = new TextEncoder().encode(smallStatus)
  const tempPath = '/tmp/hermes-tailscale-status.fail'
  const r = bootRuntime({
    connectionId: 'gw',
    request: posixGateway({ bytes, tempPath, chunk: () => ({ code: 127, stdout: '', stderr: 'base64: not found' }), inline: () => ({ code: 0, stdout: smallStatus }) })
  })
  const result = await r.loadSnapshot()
  assert.equal(result.kind, 'ready')
  assert.ok(r.commands.includes(`rm -f '${tempPath}'`))
  assert.ok(r.commands.some(command => command === "'tailscale' status --json"))
})

test('a throw mid-read still removes the temp file', async () => {
  const bytes = new TextEncoder().encode(smallStatus)
  const tempPath = '/tmp/hermes-tailscale-status.throw'
  const r = bootRuntime({
    connectionId: 'gw',
    request: posixGateway({ bytes, tempPath, chunk: () => { throw new Error('shell.exec timed out') } })
  })
  const result = await r.loadSnapshot()
  assert.equal(result.kind, 'error')
  assert.ok(r.commands.includes(`rm -f '${tempPath}'`))
})

test('a short chunk is rejected instead of stitched at the wrong offset', async () => {
  const bytes = new TextEncoder().encode(smallStatus)
  const r = bootRuntime({
    connectionId: 'gw',
    request: posixGateway({
      bytes,
      chunk: (offset, count) => ({ code: 0, stdout: Buffer.from(bytes.subarray(offset - 1, offset - 2 + count)).toString('base64') }),
      inline: () => ({ code: 0, stdout: 'clipped}' })
    })
  })
  const result = await r.loadSnapshot()
  assert.equal(result.kind, 'error')
  assert.match(result.message, /only part of the Tailscale status/)
})

test('no temp file means one inline response, not a missing-CLI card', async () => {
  const r = bootRuntime({
    connectionId: 'gw',
    request: command => {
      if (command === 'uname -s') return { code: 0, stdout: 'Linux\n' }
      if (command.includes('mktemp')) return { code: 1, stdout: '', stderr: 'mktemp: No such file or directory' }
      if (command.includes('serve status')) return { code: 0, stdout: '{}' }
      if (command.includes('switch --list')) return { code: 0, stdout: '[]' }
      if (command.includes('status --json')) return { code: 0, stdout: smallStatus }
      return { code: 0, stdout: '' }
    }
  })
  const result = await r.loadSnapshot()
  assert.equal(result.kind, 'ready')
  assert.equal(r.commands.some(command => command.startsWith('rm ')), false)
})

test('remote CLI failures name the connected host', async () => {
  const r = bootRuntime({
    connectionId: 'gw',
    request: command => {
      if (command === 'uname -s') return { code: 0, stdout: 'Linux\n' }
      if (command.includes('mktemp')) return { code: 1, stdout: '0\n/tmp/hermes-tailscale-status.d\n', stderr: 'failed to connect to local tailscaled' }
      return { code: 0, stdout: '' }
    }
  })
  const result = await r.loadSnapshot()
  assert.equal(result.kind, 'daemon')
  assert.match(result.message, /connected host/)
})

test('capture command sweeps old temp files first and still runs under sh', () => {
  const capture = h.remoteStatusCaptureCommand({ path: 'tailscale' }, 'linux')
  assert.match(capture, /^find "\$\{TMPDIR:-\/tmp\}" -maxdepth 1 -name 'hermes-tailscale-status\.\*' -user "\$\(id -u\)" -mmin \+2 -exec rm -f \{\} \+ 2>\/dev\/null;/)
})

test('removeCacheFile does nothing on a remote connection', async () => {
  const r = bootRuntime({ connectionId: 'gw', request: () => ({ code: 0, stdout: '' }) })
  r.setCachedOutPath('/home/me/.local/share/hermes/desktop-plugins/hermes-tailscale/status-cache.json')
  r.removeCacheFile()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(r.commands, [])
})

test('desktop terminal commands on a remote connection never use the gateway binary', async () => {
  const r = bootRuntime({ connectionId: 'gw', cachedBin: { path: '/snap/bin/tailscale' }, request: () => ({ code: 0, stdout: '' }) })
  const picked = await r.terminalBin('windows')
  assert.equal(picked.bin.path, 'tailscale')
  assert.equal(r.getCachedBin().path, '/snap/bin/tailscale')
  assert.deepEqual(r.commands, [])
})

test('the port check skips the desktop fetch on a remote connection', async () => {
  let fetched = 0
  const r = bootRuntime({
    connectionId: 'gw',
    request: command => (command === 'uname -s' ? { code: 0, stdout: 'Linux\n' } : { code: 7, stdout: '', stderr: '' })
  })
  r.context.fetch = async () => { fetched += 1; return {} }
  r.context.AbortController = AbortController
  await r.probeLocalPort(8642)
  assert.equal(fetched, 0)
  assert.ok(r.commands.some(command => command.includes('8642')))
})
