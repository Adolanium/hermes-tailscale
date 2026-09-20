// Regression tests for the status-cache route (v0.0.6).
//
// `tailscale status --json` is larger than the 4 KB the gateway returns for a
// shell command, so the plugin caches the full output in a file and reads it
// back over the desktop bridge. These tests pin the pure contract of that
// route:
//
//   - the redirect is atomic: mkdir first, write a unique temp file, rename
//     it over the cache (a reader sees the old file or the new one, never a
//     half-written one),
//   - every cache read carries a reason
//     (ok | missing | unreadable | too-large | corrupt | empty | bridge),
//   - a card that could not use the cache names the path and the real reason
//     and never blames the 4 KB door slice for a cache write/read failure,
//   - a status larger than 4 KB is only recoverable through the cache.
//
// The live end-to-end round trips (folder mismatch, concurrent writers,
// recovery from a corrupt file) run the plugin's own command text through a
// real POSIX shell in cache-integration.test.mjs; that file is skipped on
// Windows, where the command shapes pinned here are the executable contract.

import assert from 'node:assert/strict'
import test from 'node:test'
import { loadHelpers } from './helpers.mjs'

const h = loadHelpers()

const OUT = '/home/me/.hermes/desktop-plugins/hermes-tailscale/status-cache.json'
const OUT_DIR = '/home/me/.hermes/desktop-plugins/hermes-tailscale'
const OUT_TMP = `${OUT}.tmp-T1`
const WIN_OUT = 'C:\\Users\\me\\desktop-plugins\\hermes-tailscale\\status-cache.json'
const WIN_DIR = 'C:\\Users\\me\\desktop-plugins\\hermes-tailscale'
const WIN_TMP = `${WIN_OUT}.tmp-T1`

test('the atomic redirect creates the cache directory, then writes a temp file and renames it', () => {
  const posix = h.atomicStatusRedirectCommand({ path: '/usr/bin/tailscale' }, OUT, 'linux', 'T1')
  assert.equal(
    posix,
    `mkdir -p '${OUT_DIR}' && umask 077 && '/usr/bin/tailscale' status --json > '${OUT_TMP}' && chmod 600 '${OUT_TMP}' && mv -f '${OUT_TMP}' '${OUT}'`
  )
  // Nothing ever redirects straight into the cache file.
  assert.ok(!posix.includes(`> '${OUT}'`))

  const mac = h.atomicStatusRedirectCommand(
    { path: '/Applications/Tailscale.app/Contents/MacOS/Tailscale', envPrefix: 'TAILSCALE_BE_CLI=1' },
    OUT,
    'darwin',
    'T2'
  )
  assert.ok(
    mac.includes(
      `umask 077 && TAILSCALE_BE_CLI=1 '/Applications/Tailscale.app/Contents/MacOS/Tailscale' status --json > '${OUT}.tmp-T2'`
    )
  )

  const win = h.atomicStatusRedirectCommand(
    { path: 'C:\\Program Files\\Tailscale\\tailscale.exe' },
    WIN_OUT,
    'windows',
    'T1'
  )
  assert.equal(
    win,
    `cmd /c mkdir "${WIN_DIR}" & "C:\\Program Files\\Tailscale\\tailscale.exe" status --json > "${WIN_TMP}" && cmd /c move /y "${WIN_TMP}" "${WIN_OUT}"`
  )
  assert.ok(!/umask|chmod/.test(win))
})

test('every write gets its own temp name so concurrent writers cannot collide', () => {
  const tokens = new Set()
  for (let i = 0; i < 500; i += 1) tokens.add(h.cacheTmpToken(1789860000000 + i, i / 500))
  assert.equal(tokens.size, 500)
  assert.match(h.cacheTmpToken(), /^\d+-[0-9a-f]+$/)
  // same inputs, same name; different randoms, different name
  assert.equal(h.cacheTmpToken(1000, 0.5), h.cacheTmpToken(1000, 0.5))
  assert.notEqual(h.cacheTmpToken(1000, 0.5), h.cacheTmpToken(1000, 0.25))
  assert.equal(h.cacheTmpPath(OUT, 'T1'), OUT_TMP)
})

test('cacheDirPath finds the folder on both platforms', () => {
  assert.equal(h.cacheDirPath(OUT), OUT_DIR)
  assert.equal(h.cacheDirPath(WIN_OUT), WIN_DIR)
  assert.equal(h.cacheDirPath('status-cache.json'), '')
  assert.equal(h.cacheDirPath(''), '')
})

test('ensure and replace helpers speak each platform', () => {
  assert.equal(h.ensureCacheDirCommand(OUT, 'linux'), `mkdir -p '${OUT_DIR}'`)
  assert.equal(h.ensureCacheDirCommand(WIN_OUT, 'windows'), `cmd /c mkdir "${WIN_DIR}"`)
  assert.equal(h.ensureCacheDirCommand('status-cache.json', 'linux'), '')
  assert.equal(h.cacheReplaceCommand(OUT_TMP, OUT, 'linux'), `mv -f '${OUT_TMP}' '${OUT}'`)
  assert.equal(
    h.cacheReplaceCommand(WIN_TMP, WIN_OUT, 'windows'),
    `cmd /c move /y "${WIN_TMP}" "${WIN_OUT}"`
  )
})

test('dispose clears the cache and stale temp siblings', () => {
  assert.equal(h.removeCacheArtifactsCommand(OUT, 'linux'), `rm -f '${OUT}' '${OUT}.tmp-'*`)
  assert.equal(
    h.removeCacheArtifactsCommand(WIN_OUT, 'windows'),
    `cmd /c del /q "${WIN_OUT}" & cmd /c del /q "${WIN_OUT}.tmp-*"`
  )
  assert.equal(h.removeCacheCommand(OUT, 'linux'), `rm -f '${OUT}'`)
})

test('a cache read carries a reason: ok, empty, corrupt, too-large, bridge', () => {
  const ok = h.cacheReadVerdict({ text: '\n {"BackendState":"Running"} \n' })
  assert.equal(ok.reason, 'ok')
  assert.equal(ok.text, '\n {"BackendState":"Running"} \n')
  assert.equal(ok.detail, '')

  // Objects come out of a separate vm context, so compare fields, not
  // prototypes (deepStrictEqual would trip on the realm boundary).
  const missing = h.cacheReadVerdict({})
  assert.equal(missing.text, '')
  assert.equal(missing.reason, 'empty')
  assert.equal(missing.detail, 'the cache file is empty')
  assert.equal(h.cacheReadVerdict({ text: '   ' }).reason, 'empty')

  // A half-written file (a crash, or a writer from before 0.0.6) is never
  // handed to JSON.parse as if it were complete.
  assert.equal(h.cacheReadVerdict({ text: '{"BackendState":' }).reason, 'corrupt')
  assert.equal(h.cacheReadVerdict({ text: 'not json at all' }).reason, 'corrupt')
  assert.equal(h.cacheReadVerdict({ text: '{"a":1}\n trailing' }).reason, 'corrupt')

  // The desktop reader reports previews over its 512 KiB limit as truncated.
  const big = h.cacheReadVerdict({ text: '', truncated: true, byteSize: 600 * 1024 })
  assert.equal(big.reason, 'too-large')
  assert.equal(big.text, '')
  assert.equal(big.detail, 'the cache file exceeds the desktop read limit')

  // No local file reader at all (an older shell) is its own reason.
  assert.equal(h.cacheReadVerdict(null).reason, 'bridge')
  assert.equal(h.cacheReadVerdict(undefined).reason, 'bridge')
})

test('bridge read rejections map to missing, too-large, or unreadable', () => {
  assert.equal(h.cacheReadErrorReason(new Error('Text preview failed: file does not exist.')), 'missing')
  assert.equal(h.cacheReadErrorReason(new Error('ENOENT: no such file or directory, open x')), 'missing')
  assert.equal(h.cacheReadErrorReason(new Error('ENOTDIR: not a directory, open x')), 'missing')
  assert.equal(h.cacheReadErrorReason(new Error('EFBIG: file too large')), 'too-large')
  assert.equal(h.cacheReadErrorReason(new Error('Text preview failed: file is too large for preview.')), 'too-large')
  assert.equal(h.cacheReadErrorReason(new Error('Text preview failed: file is not readable.')), 'unreadable')
  assert.equal(h.cacheReadErrorReason(new Error('EACCES: permission denied, open x')), 'unreadable')
  assert.equal(h.cacheReadErrorReason(new Error('boom')), 'unreadable')
})

test('cache failures name the path and the real reason, never blame truncation', () => {
  const detail = "mkdir: cannot create directory '/home/me/.hermes/desktop-plugins': Permission denied"
  const msg = h.cacheFailureMessage(OUT, 'write', detail, 'local')
  assert.ok(
    msg.startsWith(`Could not read the Tailscale status cache (${OUT}): the cache write failed (${detail}).`),
    msg
  )
  assert.ok(
    msg.includes(
      "Hermes only returns the last 4k of a shell command, so the full 'tailscale status --json' cannot be recovered inline."
    )
  )
  assert.ok(!msg.includes('was truncated'))

  const remote = h.cacheFailureMessage(OUT, 'write', detail, 'mac-mini')
  assert.ok(remote.includes('The status cache is written on the connected host (mac-mini) but read from this machine.'))
  assert.ok(!msg.includes('connected host'))
  assert.ok(!h.cacheFailureMessage(OUT, 'write', detail, null).includes('connected host'))

  assert.ok(h.cacheFailureMessage(OUT, 'missing', '', null).includes('the cache file does not exist'))
  assert.ok(h.cacheFailureMessage(OUT, 'empty', '', null).includes('the cache file is empty'))
  assert.ok(h.cacheFailureMessage(OUT, 'unreadable', '', null).includes('the cache file is not readable'))
  assert.ok(h.cacheFailureMessage(OUT, 'too-large', '', null).includes('the cache file is too large for the desktop reader'))
  assert.ok(h.cacheFailureMessage(OUT, 'corrupt', '', null).includes('the cache file is not a complete JSON object'))
  assert.ok(h.cacheFailureMessage(OUT, 'bridge', '', null).includes('this Hermes shell cannot read local files for the plugin'))
  assert.ok(h.cacheFailureMessage(OUT, 'weird', '', null).includes('the cache file could not be read'))
})

test('firstLine keeps one shell line and caps it', () => {
  assert.equal(h.firstLine('\n  ERROR: one\n second\n', 200), 'ERROR: one')
  assert.equal(h.firstLine('x'.repeat(300), 10), 'xxxxxxxxxx…')
  assert.equal(h.firstLine(''), '')
  assert.equal(h.firstLine(null), '')
})

test('looksCompleteJson accepts complete objects only', () => {
  assert.equal(h.looksCompleteJson('{"a":1}'), true)
  assert.equal(h.looksCompleteJson(' {} '), true)
  assert.equal(h.looksCompleteJson('[1]'), false)
  assert.equal(h.looksCompleteJson('null'), false)
  assert.equal(h.looksCompleteJson('{"a":'), false)
  assert.equal(h.looksCompleteJson(''), false)
})

function bigStatus(peers = 40) {
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
      Active: false,
      Relay: 'fra',
      CurAddr: `203.0.113.${i}:41641`,
      RxBytes: 1024 * i,
      TxBytes: 512 * i,
      LastSeen: '2026-09-01T12:00:00Z',
      TaildropTarget: i % 2,
      Tags: [`tag:node-${i}`]
    }
  }
  return {
    Version: '1.102.4',
    TUN: true,
    BackendState: 'Running',
    TailscaleIPs: ['100.65.173.83'],
    MagicDNSSuffix: 'tail52478.ts.net',
    CurrentTailnet: {
      Name: 'alice@example.com',
      MagicDNSSuffix: 'tail52478.ts.net',
      MagicDNSEnabled: true
    },
    Health: [],
    Self: {
      ID: 'nSELF',
      HostName: 'Overseer',
      DNSName: 'main.tail52478.ts.net.',
      OS: 'linux',
      UserID: 1,
      TailscaleIPs: ['100.65.173.83'],
      Relay: 'fra',
      Online: true,
      Active: false
    },
    Peer,
    User: { 1: { LoginName: 'alice@example.com', DisplayName: 'Alice' } }
  }
}

test('a status larger than the 4 KB door slice is only recoverable through the cache', () => {
  const text = JSON.stringify(bigStatus())
  assert.ok(Buffer.byteLength(text) > 4096, `fixture is ${Buffer.byteLength(text)} bytes`)

  // The cache route hands the whole file back and it parses into rows.
  const verdict = h.cacheReadVerdict({ text, truncated: false })
  assert.equal(verdict.reason, 'ok')
  const status = h.parseStatus(JSON.parse(verdict.text), Date.parse('2026-09-03T12:00:00Z'))
  assert.equal(status.backend, 'Running')
  assert.equal(status.rows.length, 41)
  assert.equal(status.rows.filter(row => row.isSelf).length, 1)

  // The last-4,000-chars slice the gateway returns inline cannot be recovered.
  const inline = text.slice(-4000)
  assert.equal(h.looksCompleteJson(inline), false)
  assert.throws(() => JSON.parse(inline))
})
