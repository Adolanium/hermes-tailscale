// Command construction. Everything the plugin hands to shell.exec or the PTY
// is built from these helpers, so this is where a quoting bug would live.

import assert from 'node:assert/strict'
import test from 'node:test'
import { loadHelpers, posixUnquote } from './helpers.mjs'

const h = loadHelpers()

// Values that break naive quoting. Each one must survive a round trip.
const nasty = [
  'plain',
  'two words',
  '  leading and trailing  ',
  "it's",
  "''",
  'say "hi"',
  '$HOME and ${USER}',
  '`whoami`',
  '$(reboot)',
  'back\\slash',
  'a;b && c || d | e',
  '*.jpg ? [abc]',
  'bang!',
  '~user',
  '-rf',
  '--flag=value',
  'tab\there',
  'new\nline',
  'ünïcödé',
  'кириллица',
  '日本語のファイル',
  'emoji 🚀 name',
  'mixed "quotes" and \'apostrophes\'',
  ''
]

const winPaths = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  'C:\\Users\\Ünïcödé User\\Downloads\\photo 1.jpg',
  'C:\\Users\\日本\\Desktop\\file.txt',
  'D:\\a&b\\c(d)\\e%f.mov',
  '\\\\server\\share\\tailscale.exe',
  'C:/Tools/tailscale.exe',
  '.\\tailscale.exe',
  'C:\\short.txt'
]

// --- POSIX ---

test('quoteShell (posix) survives a sh word split for every nasty value', () => {
  for (const value of nasty) {
    const quoted = h.quoteShell(value, 'linux')
    assert.equal(posixUnquote(quoted), value, `round trip failed for ${JSON.stringify(value)}`)
  }
})

test('quoteShell (posix) uses only single quotes and the closed-quote escape', () => {
  assert.equal(h.quoteShell('plain', 'linux'), "'plain'")
  assert.equal(h.quoteShell("it's", 'linux'), "'it'\\''s'")
  assert.equal(h.quoteShell('$HOME', 'darwin'), "'$HOME'")
  assert.equal(h.quoteShell('`id`', 'darwin'), "'`id`'")
  assert.equal(h.quoteShell('', 'linux'), "''")
})

test('quoteShell (posix) does not care whether kind is linux or darwin', () => {
  for (const value of nasty) {
    assert.equal(h.quoteShell(value, 'linux'), h.quoteShell(value, 'darwin'))
  }
})

test('quoteShell (posix) coerces non-strings', () => {
  assert.equal(h.quoteShell(9119, 'linux'), "'9119'")
  assert.equal(h.quoteShell(null, 'linux'), "'null'")
})

// --- Windows ---

test('quoteShell (windows) wraps in double quotes and leaves backslashes alone', () => {
  for (const p of winPaths) {
    const quoted = h.quoteShell(p, 'windows')
    assert.equal(quoted, `"${p}"`, `unexpected quoting for ${p}`)
    assert.equal(quoted.slice(1, -1), p, 'inner text must be byte-identical')
  }
})

test('quoteShell (windows) escapes an embedded double quote', () => {
  assert.equal(h.quoteShell('say "hi"', 'windows'), '"say \\"hi\\""')
})

test('quoteShell (windows) keeps spaces, unicode, and cmd metacharacters inside the quotes', () => {
  for (const value of ['two words', 'ünïcödé', '日本語', 'a&b|c', '(paren)', '%PATH%', '^caret']) {
    assert.equal(h.quoteShell(value, 'windows'), `"${value}"`)
  }
})

// --- binCommand / statusRedirectCommand ---

test('binCommand quotes the binary path on every platform and appends args raw', () => {
  assert.equal(
    h.binCommand({ path: 'C:\\Program Files\\Tailscale\\tailscale.exe' }, 'status --json', 'windows'),
    '"C:\\Program Files\\Tailscale\\tailscale.exe" status --json'
  )
  assert.equal(
    h.binCommand({ path: '/opt/homebrew/bin/tailscale' }, 'version --json', 'darwin'),
    "'/opt/homebrew/bin/tailscale' version --json"
  )
  assert.equal(h.binCommand({ path: 'tailscale' }, 'status', 'linux'), "'tailscale' status")
})

test('binCommand puts envPrefix before the quoted binary', () => {
  const cmd = h.binCommand(
    { path: '/Applications/Tailscale.app/Contents/MacOS/Tailscale', envPrefix: 'TAILSCALE_BE_CLI=1' },
    'status --json',
    'darwin'
  )
  assert.equal(cmd, "TAILSCALE_BE_CLI=1 '/Applications/Tailscale.app/Contents/MacOS/Tailscale' status --json")
})

test('statusRedirectCommand quotes the output path with spaces and unicode', () => {
  const win = h.statusRedirectCommand(
    { path: 'tailscale' },
    'C:\\Users\\Ünïcödé User\\.hermes\\desktop-plugins\\hermes-tailscale\\status-cache.json',
    'windows'
  )
  assert.equal(
    win,
    '"tailscale" status --json > "C:\\Users\\Ünïcödé User\\.hermes\\desktop-plugins\\hermes-tailscale\\status-cache.json"'
  )

  const outPath = "/home/it's me/.hermes/desktop-plugins/hermes-tailscale/status-cache.json"
  const linux = h.statusRedirectCommand({ path: '/usr/bin/tailscale' }, outPath, 'linux')
  const target = linux.split(' > ')[1].split(' && ')[0]
  assert.equal(posixUnquote(target), outPath)
})

test('statusRedirectCommand (posix) creates the cache 0600 and tightens an old copy', () => {
  const outPath = '/home/me/.hermes/desktop-plugins/hermes-tailscale/status-cache.json'
  const cmd = h.statusRedirectCommand({ path: 'tailscale' }, outPath, 'linux')
  assert.equal(cmd, `umask 077 && 'tailscale' status --json > '${outPath}' && chmod 600 '${outPath}'`)
  const win = h.statusRedirectCommand({ path: 'tailscale' }, 'C:\\x\\status-cache.json', 'windows')
  assert.doesNotMatch(win, /umask|chmod/, 'no POSIX bits on Windows')
})

test('removeCacheCommand deletes quietly on each platform', () => {
  assert.equal(
    h.removeCacheCommand('C:\\Users\\me me\\.hermes\\desktop-plugins\\hermes-tailscale\\status-cache.json', 'windows'),
    'cmd /c del /q "C:\\Users\\me me\\.hermes\\desktop-plugins\\hermes-tailscale\\status-cache.json"'
  )
  const outPath = "/home/it's me/.hermes/desktop-plugins/hermes-tailscale/status-cache.json"
  const rm = h.removeCacheCommand(outPath, 'linux')
  assert.ok(rm.startsWith('rm -f '))
  assert.equal(posixUnquote(rm.slice('rm -f '.length)), outPath)
})

test('joinPath uses the platform separator and trims trailing separators from the root', () => {
  assert.equal(
    h.joinPath('C:\\Users\\me\\.hermes\\desktop-plugins\\', ['hermes-tailscale', 'status-cache.json'], 'windows'),
    'C:\\Users\\me\\.hermes\\desktop-plugins\\hermes-tailscale\\status-cache.json'
  )
  assert.equal(
    h.joinPath('/home/日本/.hermes/desktop-plugins/', ['hermes-tailscale', 'status-cache.json'], 'linux'),
    '/home/日本/.hermes/desktop-plugins/hermes-tailscale/status-cache.json'
  )
  assert.equal(h.joinPath('', ['a', 'b'], 'linux'), '/a/b')
})

// --- shellLine (PTY) ---

test('shellLine (windows) uses the call operator for any path with a separator', () => {
  for (const p of winPaths.filter(x => /[\\/]/.test(x))) {
    assert.equal(h.shellLine({ path: p }, 'ssh pi@mypi', 'windows'), `& "${p}" ssh pi@mypi`)
  }
})

test('shellLine (windows) falls back to the bare command name', () => {
  assert.equal(h.shellLine({ path: 'tailscale' }, 'ssh mypi', 'windows'), 'tailscale ssh mypi')
  assert.equal(h.shellLine({ path: 'tailscale.exe' }, 'ssh mypi', 'windows'), 'tailscale ssh mypi')
  assert.equal(h.shellLine(null, 'ssh mypi', 'windows'), 'ssh mypi')
})

test('shellLine (posix) quotes full paths, keeps bare names, and honors envPrefix', () => {
  assert.equal(h.shellLine({ path: 'tailscale' }, 'ssh mypi', 'linux'), 'tailscale ssh mypi')
  assert.equal(h.shellLine({ path: '/snap/bin/tailscale' }, 'ssh mypi', 'linux'), "'/snap/bin/tailscale' ssh mypi")
  assert.equal(
    h.shellLine(
      { path: '/Applications/Tailscale.app/Contents/MacOS/Tailscale', envPrefix: 'TAILSCALE_BE_CLI=1' },
      'ssh mypi',
      'darwin'
    ),
    "TAILSCALE_BE_CLI=1 '/Applications/Tailscale.app/Contents/MacOS/Tailscale' ssh mypi"
  )
})

// --- Taildrop (fileCpCommand / quoteCmdArg / isSafeFilePath) ---

test('quoteCmdArg strips double quotes and wraps the rest', () => {
  for (const p of winPaths) assert.equal(h.quoteCmdArg(p), `"${p}"`)
  assert.equal(h.quoteCmdArg('a"b"c'), '"abc"')
  assert.equal(h.quoteCmdArg(''), '""')
})

test('isSafeFilePath rejects the characters cmd cannot carry, allows everything else', () => {
  for (const p of winPaths) assert.equal(h.isSafeFilePath(p), true, p)
  assert.equal(h.isSafeFilePath("/home/pi/it's here.jpg"), true)
  assert.equal(h.isSafeFilePath('/tmp/ünï 日本 🚀.jpg'), true)
  assert.equal(h.isSafeFilePath('C:\\a"b.jpg'), false)
  assert.equal(h.isSafeFilePath('a\nb'), false)
  assert.equal(h.isSafeFilePath('a\rb'), false)
  assert.equal(h.isSafeFilePath('a\0b'), false)
  assert.equal(h.isSafeFilePath(''), false)
})

test('fileCpCommand (windows) has the exact cmd --% shape with each arg quoted', () => {
  const exe = 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'
  const file = 'C:\\Users\\Ünïcödé User\\Videos\\Screen Recording 1.mov'
  const cmd = h.fileCpCommand({ path: exe }, 'windows', file, 'mypi:')
  const lines = cmd.split('\r')
  assert.equal(lines[0], 'echo HERMES_SEND_START')
  assert.equal(lines[1], `cmd --% /c call "${exe}" file cp "${file}" "mypi:"`)
  assert.equal(lines[2], 'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }')
  assert.equal(lines[3], 'exit 0')
  assert.equal(lines[4], '')
})

test('fileCpCommand (windows) uses bare tailscale when the binary has no path', () => {
  const cmd = h.fileCpCommand({ path: 'tailscale' }, 'windows', 'C:\\x.jpg', 'mypi:')
  assert.match(cmd, /cmd --% \/c call "tailscale" file cp "C:\\x\.jpg" "mypi:"/)
  const noBin = h.fileCpCommand(null, 'windows', 'C:\\x.jpg', 'mypi:')
  assert.match(noBin, /call "tailscale" file cp/)
})

test('fileCpCommand (windows) keeps cmd metacharacters inside quotes', () => {
  const cmd = h.fileCpCommand({ path: 'tailscale' }, 'windows', 'D:\\a&b\\c(d)\\e%f.mov', 'mypi:')
  assert.match(cmd, /file cp "D:\\a&b\\c\(d\)\\e%f\.mov" "mypi:"/)
})

test('fileCpCommand (posix) single-quotes the file path so a sh split gives it back', () => {
  for (const file of ["/home/pi/it's here.jpg", '/tmp/$HOME `x` ;rm.jpg', '/tmp/ünï 日本 🚀.jpg']) {
    const cmd = h.fileCpCommand({ path: '/usr/bin/tailscale' }, 'linux', file, 'mypi:')
    const match = cmd.match(/file cp ('(?:[^']|'\\'')*') ('(?:[^']|'\\'')*')/)
    assert.ok(match, `could not find quoted args in ${cmd}`)
    assert.equal(posixUnquote(match[1]), file)
    assert.equal(posixUnquote(match[2]), 'mypi:')
  }
})

test('fileCpCommand (posix) reports the CLI exit status and ends the PTY', () => {
  const cmd = h.fileCpCommand({ path: 'tailscale' }, 'linux', '/tmp/a.jpg', 'mypi:')
  assert.equal(cmd, "echo HERMES_SEND_START; tailscale file cp '/tmp/a.jpg' 'mypi:'; echo HERMES_SEND_DONE:$?; exit $?\r")
  const mac = h.fileCpCommand(
    { path: '/Applications/Tailscale.app/Contents/MacOS/Tailscale', envPrefix: 'TAILSCALE_BE_CLI=1' },
    'darwin',
    '/tmp/a.jpg',
    'mypi:'
  )
  assert.match(mac, /^echo HERMES_SEND_START; TAILSCALE_BE_CLI=1 '\/Applications\/Tailscale\.app\/Contents\/MacOS\/Tailscale' file cp /)
})

// --- CLI targets ---

test('isSafeHost rejects every shell metacharacter and whitespace', () => {
  for (const bad of ['a b', 'a;b', 'a&b', 'a|b', 'a$b', 'a`b', "a'b", 'a"b', 'a\\b', 'a\nb', 'a>b', 'a<b', '-flag', '.hidden', 'ünïcödé']) {
    assert.equal(h.isSafeHost(bad), false, JSON.stringify(bad))
  }
  for (const good of ['mypi', 'mypi.tail52478.ts.net', '100.109.133.35', 'fd7a:115c:a1e0::1', 'my-pi_2']) {
    assert.equal(h.isSafeHost(good), true, good)
  }
  assert.equal(h.isSafeHost('a'.repeat(254)), false)
  assert.equal(h.isSafeHost('a'.repeat(253)), true)
})

test('isSafeUser rejects metacharacters, leading digits, and long names', () => {
  for (const bad of ['1abc', 'a b', 'a;b', 'a@b', 'a$b', 'a\\b', '', 'ünï', 'a'.repeat(33)]) {
    assert.equal(h.isSafeUser(bad), false, JSON.stringify(bad))
  }
  for (const good of ['pi', 'root', '_svc', 'a.b-c_d', 'ubuntu2', 'a'.repeat(32)]) {
    assert.equal(h.isSafeUser(good), true, good)
  }
  assert.equal(h.isSafeUser('  pi  '), true, 'trimmed before check')
})
