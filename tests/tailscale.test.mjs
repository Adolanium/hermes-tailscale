import assert from 'node:assert/strict'
import test from 'node:test'
import { loadHelpers, names, testExportNames } from './helpers.mjs'

const h = loadHelpers()

test('every helper under test is also in the __test export', () => {
  const exported = testExportNames()
  for (const name of names) assert.ok(exported.includes(name), `${name} missing from __test`)
  for (const name of exported) assert.ok(names.includes(name), `${name} in __test but not covered`)
})

function sampleStatus(extra = {}) {
  return {
    Version: '1.102.3',
    TUN: true,
    BackendState: 'Running',
    TailscaleIPs: ['100.65.173.83', 'fd7a:115c:a1e0::9539:ad53'],
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
      OS: 'windows',
      UserID: 1,
      TailscaleIPs: ['100.65.173.83', 'fd7a:115c:a1e0::9539:ad53'],
      Relay: 'fra',
      Online: true,
      Active: false,
      RxBytes: 0,
      TxBytes: 0,
      LastSeen: '0001-01-01T00:00:00Z',
      TaildropTarget: 0
    },
    Peer: {
      key1: {
        ID: 'nPI',
        HostName: 'mypi',
        DNSName: 'mypi.tail52478.ts.net.',
        OS: 'linux',
        UserID: 1,
        TailscaleIPs: ['100.109.133.35'],
        Online: true,
        Active: true,
        CurAddr: '203.0.113.9:41641',
        Relay: 'fra',
        RxBytes: 2048,
        TxBytes: 512,
        LastSeen: '0001-01-01T00:00:00Z',
        sshHostKeys: ['ssh-ed25519 AAAA'],
        TaildropTarget: 1
      },
      key2: {
        ID: 'nMAC',
        HostName: 'macbook',
        DNSName: 'romans-macbook-air.tail52478.ts.net.',
        OS: 'macOS',
        UserID: 1,
        TailscaleIPs: ['100.76.26.14'],
        Online: false,
        Active: false,
        Relay: '',
        CurAddr: '',
        LastSeen: '2026-08-27T12:00:00Z',
        TaildropTarget: 5
      },
      key3: {
        ID: 'nSHARE',
        HostName: 'pixel',
        DNSName: 'pixel-9a.tail52478.ts.net.',
        OS: 'android',
        UserID: 2,
        TailscaleIPs: ['100.96.50.58'],
        Online: false,
        ShareeNode: true,
        LastSeen: '2026-08-29T12:00:00Z',
        TaildropTarget: 9
      }
    },
    User: {
      1: { LoginName: 'alice@example.com', DisplayName: 'Alice' },
      2: { LoginName: 'bob@example.com', DisplayName: 'Bob' }
    },
    ...extra
  }
}

test('platformKind reads Windows, macOS, and Linux from navigator fields', () => {
  assert.equal(h.platformKind({ platform: 'Win32', userAgent: '' }), 'windows')
  assert.equal(h.platformKind({ platform: 'MacIntel', userAgent: '' }), 'darwin')
  assert.equal(h.platformKind({ platform: 'Linux x86_64', userAgent: '' }), 'linux')
  assert.equal(h.platformKind({ platform: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), 'windows')
  assert.equal(h.platformKind({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' }), 'darwin')
})

test('binaryCandidates include the App Store CLI on macOS and Program Files on Windows', () => {
  const win = h.binaryCandidates('windows').map(row => row.path)
  assert.ok(win.includes('C:\\Program Files\\Tailscale\\tailscale.exe'))
  const mac = h.binaryCandidates('darwin')
  assert.ok(
    mac.some(
      row =>
        row.path.endsWith('Tailscale.app/Contents/MacOS/Tailscale') &&
        row.envPrefix === 'TAILSCALE_BE_CLI=1'
    )
  )
  const linux = h.binaryCandidates('linux').map(row => row.path)
  assert.ok(linux.includes('/usr/bin/tailscale'))
  assert.ok(linux.includes('/snap/bin/tailscale'))
})

test('statusRedirectCommand quotes spaces on Windows and sets TAILSCALE_BE_CLI on macOS', () => {
  const win = h.statusRedirectCommand(
    { path: 'C:\\Program Files\\Tailscale\\tailscale.exe' },
    'C:\\Users\\me\\desktop-plugins\\hermes-tailscale\\status-cache.json',
    'windows'
  )
  assert.equal(
    win,
    '"C:\\Program Files\\Tailscale\\tailscale.exe" status --json > "C:\\Users\\me\\desktop-plugins\\hermes-tailscale\\status-cache.json"'
  )
  const mac = h.statusRedirectCommand(
    {
      path: '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      envPrefix: 'TAILSCALE_BE_CLI=1'
    },
    '/Users/me/.hermes/desktop-plugins/hermes-tailscale/status-cache.json',
    'darwin'
  )
  assert.ok(
    mac.startsWith(
      "umask 077 && TAILSCALE_BE_CLI=1 '/Applications/Tailscale.app/Contents/MacOS/Tailscale' status --json > "
    )
  )
})

test('classifyCliError maps missing binary, dead daemon, and access denied', () => {
  assert.equal(h.classifyCliError({ code: 127, stderr: '', stdout: '' }), 'missing')
  assert.equal(h.classifyCliError({ code: 9009, stderr: 'not recognized', stdout: '' }), 'missing')
  assert.equal(
    h.classifyCliError({
      code: 1,
      stderr: 'failed to connect to local tailscaled (which appears to be running as tailscaled.exe)',
      stdout: ''
    }),
    'daemon'
  )
  assert.equal(h.classifyCliError({ code: 1, stderr: 'access denied', stdout: '' }), 'denied')
})

test('dnsLabel strips the MagicDNS suffix and trailing dot', () => {
  assert.equal(h.dnsLabel('mypi.tail52478.ts.net.', 'tail52478.ts.net'), 'mypi')
  assert.equal(h.dnsLabel('main.tail52478.ts.net.', 'tail52478.ts.net'), 'main')
})

test('parseStatus pins self, hides sharee nodes, and keeps path/last-seen', () => {
  const now = Date.parse('2026-09-03T12:00:00Z')
  const status = h.parseStatus(sampleStatus(), now)
  assert.equal(status.backend, 'Running')
  assert.equal(status.suffix, 'tail52478.ts.net')
  assert.equal(status.rows[0].isSelf, true)
  assert.equal(status.rows[0].label, 'main')
  assert.equal(status.rows[0].ipv4, '100.65.173.83')

  const shown = h.visibleRows(status, false)
  assert.equal(
    shown.some(row => row.label === 'pixel-9a'),
    false
  )
  assert.equal(
    shown.some(row => row.label === 'mypi'),
    true
  )

  const shared = h.visibleRows(status, true)
  assert.equal(
    shared.some(row => row.sharee),
    true
  )

  const pi = status.rows.find(row => row.label === 'mypi')
  assert.equal(pi.path, 'direct')
  assert.equal(pi.os, 'Linux')
  assert.equal(pi.owner, 'alice@')
  assert.equal(pi.ssh, true)
  assert.equal(pi.taildrop, 'Can receive files')
  assert.equal(h.sshLine(pi), 'tailscale ssh mypi')

  const mac = status.rows.find(row => row.label === 'romans-macbook-air')
  assert.equal(mac.online, false)
  assert.equal(mac.lastSeen, '7d ago')
  assert.equal(mac.taildrop, 'Offline')
})

test('emptyKind and barLabel follow BackendState', () => {
  const running = h.parseStatus(sampleStatus())
  assert.equal(h.emptyKind(running), '')
  assert.equal(h.barLabel({ kind: 'ready', status: running }), 'ts 2')
  assert.equal(h.barOk({ kind: 'ready', status: running }), true)

  const login = h.parseStatus(sampleStatus({ BackendState: 'NeedsLogin' }))
  assert.equal(h.emptyKind(login), 'login')
  assert.equal(h.barLabel({ kind: 'ready', status: login }), 'ts login')

  const stopped = h.parseStatus(sampleStatus({ BackendState: 'Stopped' }))
  assert.equal(h.emptyKind(stopped), 'stopped')
  assert.equal(h.barLabel({ kind: 'missing' }), 'ts off')
  assert.equal(h.barLabel({ kind: 'daemon' }), 'ts down')
})

test('formatBytes and ipv4Of are boring and total', () => {
  assert.equal(h.formatBytes(0), '0 B')
  assert.equal(h.formatBytes(2048), '2 KB')
  assert.equal(h.ipv4Of(['fd7a:115c:a1e0::1', '100.1.2.3']), '100.1.2.3')
  assert.equal(h.ipv4Of([]), '')
})

test('parseStatus returns null without BackendState', () => {
  assert.equal(h.parseStatus({ Peer: {} }), null)
  assert.equal(h.parseStatus(null), null)
})

test('isSafeHost allows names and IPs, not shell metacharacters', () => {
  assert.equal(h.isSafeHost('mypi'), true)
  assert.equal(h.isSafeHost('100.109.133.35'), true)
  assert.equal(h.isSafeHost('fd7a:115c:a1e0::1'), true)
  assert.equal(h.isSafeHost('mypi; rm -rf /'), false)
  assert.equal(h.isSafeHost('mypi && reboot'), false)
  assert.equal(h.isSafeHost(''), false)
})

test('sshSpec requires a username every time and does not invent one', () => {
  assert.equal(h.sshSpec('pi', '100.109.133.35'), 'pi@100.109.133.35')
  assert.equal(h.sshSpec('', '100.109.133.35'), '')
  assert.equal(h.sshSpec('pi;reboot', 'mypi'), '')
  assert.equal(h.isSafeUser('pi'), true)
  assert.equal(h.isSafeUser('root'), true)
  assert.equal(h.isSafeUser(''), false)
})

test('parsePingOutput reads the last pong and the path', () => {
  const derp = h.parsePingOutput('pong from mypi (100.109.133.35) via DERP(fra) in 24ms\n')
  assert.equal(derp.ok, true)
  assert.equal(derp.last.path, 'derp')
  assert.equal(derp.last.ms, 24)
  assert.equal(h.pingSummary(derp), '24ms DERP(fra)')

  const direct = h.parsePingOutput(
    'pong from mypi (100.109.133.35) via DERP(fra) in 24ms\npong from mypi (100.109.133.35) via 203.0.113.9:41641 in 12ms\n'
  )
  assert.equal(direct.last.path, 'direct')
  assert.equal(h.pingSummary(direct), '12ms direct')

  const none = h.parsePingOutput('direct connection not established\n')
  assert.equal(none.ok, false)
  assert.equal(none.directFailed, true)
})

test('parseServeStatus reads the live HTTPS proxy URL', () => {
  const empty = h.parseServeStatus({})
  assert.equal(empty.empty, true)
  const live = h.parseServeStatus({
    TCP: { 443: { HTTPS: true } },
    Web: {
      'main.tail52478.ts.net:443': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:9119' } }
      }
    }
  })
  assert.equal(live.empty, false)
  assert.equal(live.url, 'https://main.tail52478.ts.net:443')
  assert.equal(live.proxy, 'http://127.0.0.1:9119')
})

test('parseSwitchList only offers a switcher when there is more than one account', () => {
  const one = h.parseSwitchList([
    { id: 'aa37', nickname: 'alice@example.com', account: 'alice@example.com', selected: true }
  ])
  assert.equal(one.length, 1)
  assert.equal(one[0].selected, true)
  const two = h.parseSwitchList([
    { id: 'aa37', nickname: 'alice@example.com', account: 'alice@example.com', selected: true },
    { id: 'bb12', nickname: 'work', account: 'work@example.com', selected: false }
  ])
  assert.equal(two.length, 2)
})

test('canReceiveFiles is only for other nodes with Taildrop available', () => {
  const status = h.parseStatus(sampleStatus())
  const self = status.rows.find(row => row.isSelf)
  const pi = status.rows.find(row => row.label === 'mypi')
  const mac = status.rows.find(row => row.label === 'romans-macbook-air')
  assert.equal(h.canReceiveFiles(self), false)
  assert.equal(h.canReceiveFiles(pi), true)
  assert.equal(h.canReceiveFiles(mac), false)
})

test('rowStatus does not repeat online/offline next to last-seen', () => {
  const status = h.parseStatus(sampleStatus(), Date.parse('2026-09-03T12:00:00Z'))
  const self = status.rows.find(row => row.isSelf)
  const pi = status.rows.find(row => row.label === 'mypi')
  const mac = status.rows.find(row => row.label === 'romans-macbook-air')
  assert.equal(h.rowStatus(self), 'home fra')
  assert.equal(h.rowStatus(pi), 'direct')
  assert.equal(h.rowStatus(mac), '7d ago')
})

test('rowGrid drops the owner column when hidden', () => {
  assert.ok(h.rowGrid(true).includes('76px minmax(88px'))
  assert.ok(h.rowGrid(false).includes('76px 132px'))
  assert.ok(h.rowGrid(true).length > h.rowGrid(false).length)
})

test('shellLine is PowerShell-safe on Windows paths with spaces', () => {
  assert.equal(h.shellLine({ path: 'tailscale' }, 'ssh mypi', 'windows'), 'tailscale ssh mypi')
  assert.equal(
    h.shellLine({ path: 'C:\\Program Files\\Tailscale\\tailscale.exe' }, 'ssh mypi', 'windows'),
    '& "C:\\Program Files\\Tailscale\\tailscale.exe" ssh mypi'
  )
})

test('ptyChunk accepts a raw string or a { data } payload', () => {
  assert.equal(h.ptyChunk('pong'), 'pong')
  assert.equal(h.ptyChunk({ data: 'pong' }), 'pong')
})

test('stripPty drops OSC and CSI so PowerShell sequences are not shown', () => {
  const raw = '\u001b]9;9;"C:\\Users\\Admin"\u0007ssh: Could not resolve hostname mypi\u001b[?25h'
  assert.equal(h.stripPty(raw), 'ssh: Could not resolve hostname mypi')
})

test('applyPtyText treats CR as overwrite, CRLF as a newline', () => {
  assert.equal(h.applyPtyText('', 'hello\rworld'), 'world')
  assert.equal(h.applyPtyText('', 'hello\r\nworld'), 'hello\nworld')
  assert.equal(
    h.applyPtyText('', '0% [Working]\r50% [Working]\r100% done\n'),
    '100% done\n'
  )
})

test('applyPtyText does not drop a line when CRLF is split across chunks', () => {
  const pending = h.applyPtyText('', 'hello\r')
  assert.equal(h.applyPtyText(pending, '\nworld'), 'hello\nworld')
})

test('applyPtyText treats CSI CHA and EL like a carriage return', () => {
  assert.equal(h.applyPtyText('', '0% [Working]\u001b[1G100% done\n'), '100% done\n')
  assert.equal(h.applyPtyText('', '0% [Working]\u001b[2K\u001b[G100% done\n'), '100% done\n')
  assert.equal(h.applyPtyText('', 'line\u001b[Bnext'), 'line\nnext')
})

test('pathBase is the filename from a Windows or POSIX path', () => {
  assert.equal(h.pathBase('C:\\Users\\Admin\\photo.jpg'), 'photo.jpg')
  assert.equal(h.pathBase('/home/pi/notes.txt'), 'notes.txt')
  assert.equal(h.isSafeFilePath('C:\\Users\\Admin\\photo.jpg'), true)
  assert.equal(h.isSafeFilePath('a\nb'), false)
  assert.equal(h.isSafeFilePath('C:\\a"b.jpg'), false)
})

test('fileCpCommand exits the PTY shell with the CLI status', () => {
  const win = h.fileCpCommand(
    { path: 'C:\\Program Files\\Tailscale\\tailscale.exe' },
    'windows',
    'C:\\Users\\Admin\\ScreenRecording 1.mov',
    'mypi:'
  )
  assert.match(win, /cmd --% \/c call/)
  assert.match(win, /file cp/)
  assert.match(win, /ScreenRecording 1\.mov/)
  assert.match(win, /exit \$LASTEXITCODE/)
  const sh = h.fileCpCommand({ path: 'tailscale' }, 'linux', '/tmp/a.jpg', 'mypi:')
  assert.match(sh, /exit \$\?/)
  assert.match(sh, /HERMES_SEND_START/)
})

test('parseFileCpProgress reads percent, rate, and ETA from a Taildrop progress line', () => {
  const raw =
    'photo.jpg                           12.34MiB     1.23MiB/s      45.67%    ETA 00:00:12'
  const parsed = h.parseFileCpProgress('', raw)
  assert.equal(parsed.percent, 45.67)
  assert.equal(parsed.rate, '1.23MiB/s')
  assert.equal(parsed.eta, '00:00:12')
  assert.equal(parsed.size, '12.34MiB')
  const overwritten = h.parseFileCpProgress(
    raw,
    '\r\u001b[Kphoto.jpg                           20.00MiB     2.00MiB/s     100.00%    ETA 00:00:00'
  )
  assert.equal(overwritten.percent, 100)
})

test('sendStatusText covers sending, done, and error', () => {
  assert.equal(
    h.sendStatusText({
      state: 'busy',
      name: 'photo.jpg',
      percent: 45,
      rate: '1.2MiB/s',
      eta: '00:00:12'
    }),
    'Sending photo.jpg · 45% · 1.2MiB/s · ETA 00:00:12'
  )
  assert.equal(
    h.sendStatusText({ state: 'ok', name: 'photo.jpg', label: 'mypi' }),
    'Sent photo.jpg to mypi'
  )
  assert.equal(
    h.sendStatusText({ state: 'err', name: 'photo.jpg', text: 'peer is offline' }),
    'peer is offline'
  )
  assert.match(
    h.sendStatusText({
      state: 'busy',
      name: 'clip.mov',
      detail: 'warning: mypi is not replying'
    }),
    /clip\.mov/
  )
})

test('exitNodeChoices skips self', () => {
  const status = h.parseStatus(
    sampleStatus({
      Peer: {
        key1: {
          ID: 'nEXIT',
          HostName: 'forge',
          DNSName: 'forge.tail52478.ts.net.',
          OS: 'linux',
          UserID: 1,
          TailscaleIPs: ['100.84.114.62'],
          Online: true,
          ExitNodeOption: true
        }
      }
    })
  )
  const choices = h.exitNodeChoices(status.rows)
  assert.equal(choices.length, 1)
  assert.equal(choices[0].label, 'forge')
})
