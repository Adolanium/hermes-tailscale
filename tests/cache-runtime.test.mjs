import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { source } from './helpers.mjs'

const status = JSON.stringify({ BackendState: 'Running', Peer: {}, User: {} })
const outPath = '/plugins/hermes-tailscale/status-cache.json'

// Execute the production cache orchestration, with only the SDK/IPC mocked.
function runtime({ read, write, inline = status } = {}) {
  const commands = []
  const context = vm.createContext({
    host: {
      state: { gateway: { get: () => 'open' }, connectionId: { get: () => 'local' } },
      request: async (method, { command }) => {
        assert.equal(method, 'shell.exec')
        commands.push(command)
        if (command.includes(' > ')) return write ? write() : { code: 0 }
        if (command === "'tailscale' status --json") return { code: 0, stdout: inline }
        return { code: 0, stdout: '{}' }
      }
    },
    window: { hermesDesktop: { readFileText: read || (async () => ({ text: status })) } }
  })
  const start = source.indexOf('const TAILDROP = {')
  const end = source.indexOf('async function refresh()')
  assert.ok(start >= 0 && end > start)
  vm.runInContext(`
    const TAILDROP_AVAILABLE = 1;
    let cachedBin = { path: 'tailscale' };
    let cachedOutPath = ${JSON.stringify(outPath)};
    ${source.slice(start, end)}
    globalThis.runtime = { loadSnapshot, readStatusViaCache };
  `, context)
  return { ...context.runtime, commands }
}

for (const [name, broken] of [
  ['malformed JSON with closing brace', { text: '{"BackendState":}' }],
  ['empty cache', { text: ' ' }],
  ['missing cache', new Error('ENOENT: missing cache')]
]) {
  test(`runtime rebuilds ${name} once and reads the rebuilt status`, async () => {
    let reads = 0
    const r = runtime({ read: async () => {
      if (++reads > 1) return { text: status }
      if (broken instanceof Error) throw broken
      return broken
    } })
    const result = await r.loadSnapshot()
    assert.equal(result.kind, 'ready')
    assert.equal(reads, 2)
    assert.equal(r.commands.filter(c => c.includes(' > ')).length, 2)
    assert.equal(r.commands.filter(c => c === `rm -f '${outPath}'`).length, 1)
    assert.ok(!r.commands.includes("'tailscale' status --json"))
  })
}

test('persistent corruption stops after one rebuild and falls back inline', async () => {
  const r = runtime({ read: async () => ({ text: '{broken}' }) })
  assert.equal((await r.loadSnapshot()).kind, 'ready')
  assert.equal(r.commands.filter(c => c.includes(' > ')).length, 2)
  assert.equal(r.commands.filter(c => c === "'tailscale' status --json").length, 1)
})

test('persistent corruption and unusable inline output report the cache path and reason', async () => {
  const r = runtime({ read: async () => ({ text: '{broken}' }), inline: 'truncated}' })
  const result = await r.loadSnapshot()
  assert.equal(result.kind, 'error')
  assert.ok(result.message.includes(outPath))
  assert.match(result.message, /not a complete JSON object/)
  assert.equal(r.commands.filter(c => c.includes(' > ')).length, 2)
})

test('a rejected cache write still allows a successful inline status', async () => {
  const r = runtime({ write: async () => { throw new Error('command timed out (30s)') } })
  assert.equal((await r.loadSnapshot()).kind, 'ready')
  assert.equal(r.commands.filter(c => c === "'tailscale' status --json").length, 1)
})

test('a rejected write with unusable inline output preserves the write reason', async () => {
  const r = runtime({ write: async () => { throw new Error('cache request failed') }, inline: 'tail}' })
  const result = await r.loadSnapshot()
  assert.equal(result.kind, 'error')
  assert.ok(result.message.includes(outPath))
  assert.match(result.message, /cache write failed.*cache request failed/)
})

test('gateway unavailability keeps the gateway card without retrying', async () => {
  const r = runtime({ write: async () => { throw new Error('gateway unavailable') } })
  assert.equal((await r.loadSnapshot()).kind, 'gateway')
  assert.equal(r.commands.length, 1)
})

test('unreadable bridge data falls back inline without a destructive rebuild', async () => {
  const r = runtime({ read: async () => { throw new Error('EACCES: permission denied') } })
  assert.equal((await r.loadSnapshot()).kind, 'ready')
  assert.equal(r.commands.filter(c => c.includes(' > ')).length, 1)
  assert.ok(!r.commands.some(c => c.startsWith('rm ')))
})
