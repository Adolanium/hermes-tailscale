import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { source } from './helpers.mjs'

function runtime(request, sessionId = 'local-chat', focusedSessionId) {
  const state = { activeSessionId: { get: () => sessionId } }
  if (arguments.length > 2) state.focusedSessionId = { get: () => focusedSessionId }
  const context = vm.createContext({
    host: { request, state },
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

test('focused chat is the session id, with the primary only as a fallback', async () => {
  const calls = []
  const run = runtime(async (method, params) => {
    calls.push(params.session_id || '')
    if (!params.session_id) throw new Error('JsonRpcGatewayError: invalid_params')
    return { code: 0, stdout: '{}' }
  }, 'primary-chat', 'local-focused')
  assert.equal((await run.runShell('tailscale version --json')).code, 0)
  assert.deepEqual(calls, ['', 'local-focused'])

  const fallback = []
  const primary = runtime(async (method, params) => {
    fallback.push(params.session_id || '')
    if (!params.session_id) throw new Error('invalid_params')
    return { code: 0 }
  }, 'primary-chat', null)
  assert.equal((await primary.runShell('tailscale version --json')).code, 0)
  assert.deepEqual(fallback, ['', 'primary-chat'])
})

test('prose invalid params retries with the session', async () => {
  const calls = []
  const run = runtime(async (method, params) => {
    calls.push(params.session_id || '')
    if (!params.session_id) throw new Error('Invalid params')
    return { code: 0, stdout: '{}' }
  })
  assert.equal((await run.runShell('tailscale version --json')).code, 0)
  assert.deepEqual(calls, ['', 'local-chat'])
})

test('structured invalid_params reason retries when the message does not say so', async () => {
  const calls = []
  const run = runtime(async (method, params) => {
    calls.push(params.session_id || '')
    if (!params.session_id) {
      const error = new Error('the client and the Hermes backend are out of sync')
      error.data = { reason: 'invalid_params' }
      throw error
    }
    return { code: 0 }
  })
  assert.equal((await run.runShell('tailscale version --json')).code, 0)
  assert.deepEqual(calls, ['', 'local-chat'])
})

test('extra-inputs refusal is surfaced and not retried with a session', async () => {
  let calls = 0
  const run = runtime(async () => {
    calls += 1
    throw new Error('invalid params for shell.exec: session_id: Extra inputs are not permitted')
  })
  await assert.rejects(run.runShell('tailscale version --json'), /Extra inputs/)
  assert.equal(calls, 1)
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
