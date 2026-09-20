// Integration coverage for the status-cache route: the plugin's own command
// text is executed through a real POSIX shell, against a fake `tailscale` CLI
// and a real file as the cache.
//
// Covered here:
//   - folder mismatch: the cache folder does not exist yet and is created
//   - a status larger than 4 KB lands in the cache byte for byte
//   - repeated refreshes: every cycle leaves a complete file
//   - concurrent writers + a reader: no partial or empty file is ever observed
//   - recovery: a corrupt file is removed and rebuilt
//   - a cache that cannot be read: ENOENT / EACCES / bridge limits map to
//     reasons instead of exceptions
//
// Skipped on Windows: the command shapes pinned in status-cache.test.mjs are
// the executable contract there. The desktop reader limits (over 512 KiB
// previews are reported truncated) are the Electron bridge contract.

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHelpers, source } from './helpers.mjs'

const h = loadHelpers()
const POSIX = process.platform !== 'win32'
const posixTest = POSIX ? test : test.skip

function payload(peers = 40) {
  const Peer = {}
  for (let i = 0; i < peers; i += 1) {
    Peer[`key${i}`] = {
      ID: `n${i}`,
      HostName: `node-${i}.example`,
      DNSName: `node-${i}.tail52478.ts.net.`,
      OS: 'linux',
      UserID: 1,
      TailscaleIPs: [`100.64.${i}.10`],
      Online: true,
      Relay: 'fra',
      RxBytes: 1024 * i,
      TxBytes: 512 * i
    }
  }
  return JSON.stringify({
    Version: '1.102.4',
    TUN: true,
    BackendState: 'Running',
    TailscaleIPs: ['100.65.173.83'],
    MagicDNSSuffix: 'tail52478.ts.net',
    Health: [],
    Self: {
      ID: 'nSELF',
      HostName: 'Overseer',
      DNSName: 'main.tail52478.ts.net.',
      OS: 'linux',
      UserID: 1,
      TailscaleIPs: ['100.65.173.83'],
      Online: true
    },
    Peer,
    User: { 1: { LoginName: 'alice@example.com' } }
  })
}

function scratch(t) {
  const work = mkdtempSync(join(tmpdir(), 'hermes-tailscale-cache-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  return work
}

// A fake `tailscale` that emits the fixture. `delay` widens the write window
// so concurrent writers actually overlap.
function fakeCli(work, { delay = '' } = {}) {
  const binDir = join(work, 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'tailscale')
  writeFileSync(bin, `#!/bin/sh\n${delay ? `sleep ${delay}\n` : ''}cat "$TS_STATUS_SRC"\n`)
  chmodSync(bin, 0o755)
  const src = join(work, 'status.json')
  writeFileSync(src, payload())
  return { bin, src, env: { ...process.env, TS_STATUS_SRC: src } }
}

function run(cmd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`command exited ${code}: ${stderr || cmd}`))
    )
  })
}

const soleCacheFile = dir =>
  readdirSync(dir).filter(name => name.startsWith('status-cache.json'))

posixTest('the missing cache folder is created and the full status lands byte for byte', async t => {
  const work = scratch(t)
  const { bin, env } = fakeCli(work)
  const outPath = join(work, 'desktop-plugins', 'hermes-tailscale', 'status-cache.json')
  const text = payload()
  assert.ok(Buffer.byteLength(text) > 4096, `fixture is ${Buffer.byteLength(text)} bytes`)
  assert.ok(!existsSync(join(work, 'desktop-plugins')), 'folder mismatch precondition')

  await run(h.atomicStatusRedirectCommand({ path: bin }, outPath, 'linux', 'T1'), env)

  assert.ok(existsSync(outPath), 'cache file written')
  assert.equal(readFileSync(outPath, 'utf8'), text, 'contents preserved byte for byte')
  assert.equal(statSync(outPath).mode & 0o777, 0o600, 'cache is user-only')
  assert.deepEqual(soleCacheFile(join(work, 'desktop-plugins', 'hermes-tailscale')), [
    'status-cache.json'
  ], 'no temp files left behind')
})

posixTest('repeated refreshes always leave a complete cache', async t => {
  const work = scratch(t)
  const { bin, env } = fakeCli(work)
  const outPath = join(work, 'root', 'hermes-tailscale', 'status-cache.json')

  for (let cycle = 0; cycle < 10; cycle += 1) {
    await run(h.atomicStatusRedirectCommand({ path: bin }, outPath, 'linux', `R${cycle}`), env)
    const verdict = h.cacheReadVerdict({ text: readFileSync(outPath, 'utf8') })
    assert.equal(verdict.reason, 'ok', `cycle ${cycle}`)
    assert.equal(verdict.text, payload(), `cycle ${cycle}`)
  }
  assert.deepEqual(soleCacheFile(join(work, 'root', 'hermes-tailscale')), ['status-cache.json'])
})

posixTest(
  'concurrent writers never expose a partial or empty cache to a reader',
  { timeout: 120000 },
  async t => {
    const work = scratch(t)
    const { bin, env } = fakeCli(work, { delay: '0.01' })
    const dir = join(work, 'root', 'hermes-tailscale')
    mkdirSync(dir, { recursive: true })
    const outPath = join(dir, 'status-cache.json')
    const stopFile = join(work, 'stop')
    const countsFile = join(work, 'counts.json')

    const READER = `
const fs = require('node:fs')
const [file, stop, out] = process.argv.slice(1)
let reads = 0, partial = 0, empty = 0
const deadline = Date.now() + 60000
while (Date.now() < deadline && !fs.existsSync(stop)) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { continue }
  reads += 1
  const s = text.trim()
  if (!s) { empty += 1; continue }
  if (!(s.startsWith('{') && s.endsWith('}'))) { partial += 1; continue }
  try { JSON.parse(s) } catch { partial += 1 }
}
fs.writeFileSync(out, JSON.stringify({ reads, partial, empty }))
`
    const reader = spawn(process.execPath, ['-e', READER, outPath, stopFile, countsFile], {
      stdio: ['ignore', 'ignore', 'inherit']
    })
    t.after(() => {
      try {
        writeFileSync(stopFile, '')
      } catch {
        /* the scratch dir is already gone */
      }
      reader.kill()
    })

    const writers = []
    for (let w = 0; w < 4; w += 1) {
      writers.push(
        (async () => {
          for (let i = 0; i < 15; i += 1) {
            await run(
              h.atomicStatusRedirectCommand({ path: bin }, outPath, 'linux', `w${w}-${i}`),
              env
            )
          }
        })()
      )
    }
    await Promise.all(writers)
    writeFileSync(stopFile, '')
    const code = await new Promise(resolve => reader.on('close', resolve))
    assert.equal(code, 0, 'reader exited cleanly')

    const counts = JSON.parse(readFileSync(countsFile, 'utf8'))
    t.diagnostic(`concurrent writers: ${JSON.stringify(counts)}`)
    assert.equal(counts.partial, 0, `partial reads: ${JSON.stringify(counts)}`)
    assert.equal(counts.empty, 0, `empty reads: ${JSON.stringify(counts)}`)
    assert.ok(counts.reads > 50, `reader observed the file (${JSON.stringify(counts)})`)
    assert.equal(readFileSync(outPath, 'utf8'), payload(), 'final cache is complete')
    assert.deepEqual(soleCacheFile(dir), ['status-cache.json'], 'no temp files left behind')
  }
)

posixTest('a corrupt cache is removed and rebuilt (the documented recovery)', async t => {
  const work = scratch(t)
  const { bin, env } = fakeCli(work)
  const dir = join(work, 'root', 'hermes-tailscale')
  const outPath = join(dir, 'status-cache.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(outPath, '{"BackendState":') // half-written, as a crash would leave it
  writeFileSync(`${outPath}.tmp-orphan`, '{"BackendState":') // an aborted write

  const broken = h.cacheReadVerdict({ text: readFileSync(outPath, 'utf8') })
  assert.equal(broken.reason, 'corrupt')

  // readStatusViaCache() removes the bad file, then rebuilds once.
  await run(h.removeCacheCommand(outPath, 'linux'), env)
  assert.ok(!existsSync(outPath), 'bad cache removed')
  await run(h.atomicStatusRedirectCommand({ path: bin }, outPath, 'linux', 'R1'), env)

  const rebuilt = h.cacheReadVerdict({ text: readFileSync(outPath, 'utf8') })
  assert.equal(rebuilt.reason, 'ok')
  assert.equal(rebuilt.text, payload())

  // dispose clears the stale temp sibling too
  await run(h.removeCacheArtifactsCommand(outPath, 'linux'), env)
  assert.deepEqual(soleCacheFile(dir), [], 'cache and temp siblings gone')
})

posixTest('a cache that cannot be read maps to reasons, not exceptions', async t => {
  const work = scratch(t)
  const dir = join(work, 'root', 'hermes-tailscale')
  const outPath = join(dir, 'status-cache.json')
  mkdirSync(dir, { recursive: true })

  // missing file (the desktop bridge rejects with "does not exist")
  let error = null
  try {
    readFileSync(outPath, 'utf8')
  } catch (err) {
    error = err
  }
  assert.ok(error, 'reading a missing cache throws')
  assert.equal(h.cacheReadErrorReason(error), 'missing')

  // unreadable file (EACCES); root ignores file modes, so skip there
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    writeFileSync(outPath, payload())
    chmodSync(outPath, 0o000)
    error = null
    try {
      readFileSync(outPath, 'utf8')
    } catch (err) {
      error = err
    }
    assert.ok(error, 'reading an unreadable cache throws')
    assert.equal(h.cacheReadErrorReason(error), 'unreadable')
    chmodSync(outPath, 0o600)
  }

  // over the desktop reader's 512 KiB preview limit: truncated, not corrupt
  const bigPath = join(dir, 'big.json')
  writeFileSync(bigPath, `{"Pad":"${'x'.repeat(600 * 1024)}"}`)
  const size = statSync(bigPath).size
  assert.ok(size > 512 * 1024)
  const preview = h.cacheReadVerdict({
    text: readFileSync(bigPath, 'utf8').slice(0, 64 * 1024),
    truncated: size > 512 * 1024,
    byteSize: size
  })
  assert.equal(preview.reason, 'too-large')
  assert.equal(preview.text, '')
})

posixTest('the runtime writes through the atomic redirect, not the truncating one', () => {
  // statusRedirectCommand stays exported for older callers, but a refresh
  // must never truncate-and-stream into the cache file the reader is using.
  assert.ok(/runShell\(\s*atomicStatusRedirectCommand\(/.test(source))
  assert.ok(!/runShell\(\s*statusRedirectCommand\(/.test(source))
})
