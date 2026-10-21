import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { source } from './helpers.mjs'

function runtime(request, sessionId = 'local-chat') {
  const context = vm.createContext({
    host: { request, state: { activeSessionId: { get: () => sessionId } } },
    navigator: { platform: 'MacIntel' }
  })
  const start = source.indexOf('const TAILDROP = {')
  const end = source.indexOf('async function refresh()')
  vm.runInContext(`
    const TAILDROP_AVAILABLE = 1;
    let cachedBin = null;
    let cachedRoot = '';
    let cachedOutPath = '';
    ${source.slice(start, end)}
    globalThis.runtime = { runShell, probeBinary };
  `, context)
  return context.runtime
}

test('canonical shell retry supplies the active session after a missing-parameter refusal', async () => {
  const calls = []
  const run = runtime(async (method, params) => {
    assert.equal(method, 'shell.exec')
    calls.push({ ...params })
    if (!params.session_id) throw new Error('invalid_params')
    return { code: 0, stdout: '{}' }
  })
  assert.equal((await run.runShell('tailscale version --json')).code, 0)
  assert.deepEqual(calls, [
    { command: 'tailscale version --json' },
    { command: 'tailscale version --json', session_id: 'local-chat' }
  ])
})

test('legacy shell success does not add unsupported session parameters', async () => {
  let calls = 0
  const run = runtime(async (method, params) => {
    calls += 1
    assert.equal(params.session_id, undefined)
    return { code: 0 }
  })
  assert.equal((await run.runShell('tailscale version --json')).code, 0)
  assert.equal(calls, 1)
})

test('no active session reports the required chat instead of a missing installation', async () => {
  const run = runtime(async () => { throw new Error('invalid_params') }, null)
  await assert.rejects(run.runShell('tailscale version --json'), /Open .*Hermes chat/)
  const probe = await run.probeBinary('darwin')
  assert.equal(probe.kind, 'failed')
  assert.match(probe.error.message, /Open .*Hermes chat/)
})

test('RPC refusals are not evidence that a binary is missing', async () => {
  const run = runtime(async () => { throw new Error('permission_denied') })
  assert.equal((await run.probeBinary('darwin')).kind, 'failed')
})

test('actual command-not-found results still report a missing binary', async () => {
  const run = runtime(async () => ({ code: 127, stderr: 'command not found' }))
  assert.equal((await run.probeBinary('darwin')).kind, 'missing')
})
