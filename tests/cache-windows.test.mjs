import assert from 'node:assert/strict'
import test from 'node:test'
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadHelpers } from './helpers.mjs'

const h = loadHelpers()
const windowsTest = process.platform === 'win32' ? test : test.skip

windowsTest('Windows creates a missing folder and replaces the cache using real cmd commands', t => {
  const work = mkdtempSync(join(tmpdir(), 'hermes-cache-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const script = join(work, 'fake-cli.cjs')
  const fixture = join(work, 'fixture.json')
  const out = join(work, 'profile & spaces', 'hermes-tailscale', 'status-cache.json')
  const bin = { path: script, envPrefix: h.quoteShell(process.execPath, 'windows') }
  writeFileSync(script, "process.stdout.write(require('node:fs').readFileSync(process.env.TS_STATUS_SRC))")
  const run = command => execSync(command, {
    shell: process.env.ComSpec || 'cmd.exe',
    env: { ...process.env, TS_STATUS_SRC: fixture },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000
  })

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const text = JSON.stringify({ BackendState: 'Running', cycle, Pad: 'x'.repeat(9000) })
    writeFileSync(fixture, text)
    run(h.atomicStatusRedirectCommand(bin, out, 'windows', `W${cycle}`))
    assert.equal(readFileSync(out, 'utf8'), text)
    assert.deepEqual(readdirSync(dirname(out)), ['status-cache.json'])
  }

  // A CLI failure must not replace the last complete cache with partial output.
  const previous = readFileSync(out, 'utf8')
  writeFileSync(script, "process.stdout.write('{broken'); process.exitCode = 7")
  assert.throws(() => run(h.atomicStatusRedirectCommand(bin, out, 'windows', 'failed')))
  assert.equal(readFileSync(out, 'utf8'), previous)
  run(h.removeCacheArtifactsCommand(out, 'windows'))
  assert.deepEqual(readdirSync(dirname(out)), [])
})
