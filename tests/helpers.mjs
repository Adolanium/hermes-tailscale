// Loads the pure helper block out of plugin.js without the Hermes SDK.
//
// plugin.js is an uncompiled ES module that imports '@hermes/plugin-sdk',
// 'react', and 'react/jsx-runtime'. None of those resolve under Node. The
// helpers between `const TAILDROP = {` and `// --- runtime ---` do not touch
// the SDK, so we slice that block out and run it in a bare vm context.
//
// Every name listed in `names` must also appear in the `__test` export at the
// bottom of plugin.js. `helpers.test.mjs` checks that the two lists agree.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

export const source = readFileSync(new URL(process.env.HERMES_TEST_CATALOG ? '../catalog/desktop/plugin.js' : '../plugin.js', import.meta.url), 'utf8')

export const names = [
  'platformKind',
  'classifyShellHost',
  'quoteShell',
  'joinPath',
  'xtermSources',
  'integrityMatches',
  'wrapXtermModule',
  'bytesToBase64',
  'base64ToBytes',
  'binaryCandidates',
  'binCommand',
  'statusRedirectCommand',
  'removeCacheCommand',
  // Status-cache helpers (v0.0.6): atomic write, reasoned reads, precise errors.
  'atomicStatusRedirectCommand',
  'removeCacheArtifactsCommand',
  'cacheDirPath',
  'cacheTmpToken',
  'cacheTmpPath',
  'ensureCacheDirCommand',
  'cacheReplaceCommand',
  'looksCompleteJson',
  'cacheReadVerdict',
  'cacheReadErrorReason',
  'cacheReasonText',
  'cacheFailureMessage',
  'remoteStatusCaptureCommand',
  'parseRemoteStatusCapture',
  'remoteStatusChunkCommand',
  'remoteStatusRemoveCommand',
  'remotePartialStatusMessage',
  'firstLine',
  'classifyCliError',
  'dnsLabel',
  'ownerLabel',
  'osLabel',
  'pathLabel',
  'formatLastSeen',
  'formatBytes',
  'ipv4Of',
  'taildropLabel',
  'sshLine',
  'onlineCount',
  'parseStatus',
  'visibleRows',
  'emptyKind',
  'barLabel',
  'barOk',
  'isSafeHost',
  'isSafeUser',
  'parsePort',
  'serveArgs',
  'portProbeCommand',
  'classifyPortProbe',
  'sshSpec',
  'parsePingOutput',
  'pingSummary',
  'parseServeStatus',
  'safeWebUrl',
  'parseSwitchList',
  'canReceiveFiles',
  'exitNodeChoices',
  'rowStatus',
  'rowGrid',
  'formatKeyExpiry',
  'shellLine',
  'ptyChunk',
  'stripPty',
  'applyPtyText',
  'pathBase',
  'isSafeFilePath',
  'quoteCmdArg',
  'fileCpCommand',
  'parseFileCpProgress',
  'sendStatusText'
]

export function loadHelpers() {
  const start = source.indexOf('const TAILDROP = {')
  const end = source.indexOf('// --- runtime ---')
  assert.ok(start >= 0 && end > start, 'helper block markers missing')
  // URL is a host API, not a language builtin; the link checks need it.
  const context = vm.createContext({ URL })
  vm.runInContext(
    `const TAILDROP_AVAILABLE = 1;\n${source.slice(start, end)}\nglobalThis.__h = { ${names.join(', ')} };`,
    context
  )
  return context.__h
}

// Names exported through `export const __test = { ... }` in plugin.js.
export function testExportNames() {
  const match = source.match(/export const __test = \{([\s\S]*?)\n\}/)
  assert.ok(match, '__test export missing')
  return match[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

// Emulates how a POSIX sh splits one word made of single-quoted runs and
// the '\'' escape. Returns the string the program would receive in argv.
export function posixUnquote(word) {
  let out = ''
  let i = 0
  while (i < word.length) {
    const ch = word[i]
    if (ch === "'") {
      const close = word.indexOf("'", i + 1)
      assert.ok(close > 0, `unterminated single quote in ${word}`)
      out += word.slice(i + 1, close)
      i = close + 1
      continue
    }
    if (ch === '\\') {
      out += word[i + 1]
      i += 2
      continue
    }
    assert.fail(`bare character ${JSON.stringify(ch)} outside quotes in ${word}`)
  }
  return out
}
