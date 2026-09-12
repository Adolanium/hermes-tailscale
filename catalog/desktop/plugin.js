/**
 * Hermes Tailscale. Roster of the machines on this device's tailnet.
 *
 * One uncompiled plugin.js. Reads the installed Tailscale CLI through
 * shell.exec (same door Resetwatch uses). LocalAPI is a named pipe / unix
 * socket, so the renderer cannot call it. Cloud API tokens are not used.
 *
 * AUTHORING RULES (this file is loaded UNCOMPILED):
 *  - Single file. Relative specifiers do not resolve from a blob URL.
 *  - Do not write the word import followed by a quoted string in a comment.
 *  - No JSX. Use jsx() / jsxs() from react/jsx-runtime.
 *  - Only three specifiers resolve: the plugin SDK, react, and jsx-runtime.
 *  - Colors go through var(--ui-*). Never a hex.
 */

import * as sdk from '@hermes/plugin-sdk'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'hermes-tailscale'
const PLUGIN_NAME = 'Tailscale'
const VERSION = '0.0.5'
const ROUTE = '/tailscale'
const PAGE_POLL_MS = 8 * 1000
const BAR_POLL_MS = 60 * 1000
const DOWNLOAD_URL = 'https://tailscale.com/download'
const QUAD100_URL = 'http://100.100.100.100'
const CACHE_FILE = 'status-cache.json'
const HERMES_PORT = 9119
const TAILDROP_AVAILABLE = 1
const XTERM_VERSION = '5.5.0'
const XTERM_FILE = 'xterm.js'
// SHA-384 of lib/xterm.js inside the @xterm/xterm@5.5.0 npm tarball. jsDelivr
// and unpkg serve that file byte for byte, so one pin covers both mirrors and
// a local copy. Never point this at a /+esm or .min.js URL: those are built
// per CDN and their bytes are not stable. Bump XTERM_VERSION and this hash
// together.
const XTERM_SHA384 = 'sha384-M169f14mRZOXm3hD/v2Ti0ThIT/RnAQagXA9nlE15yHAtrW19gdePJh/HaTzUOe/'
const XTERM_URLS = [
  `https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}/lib/${XTERM_FILE}`,
  `https://unpkg.com/@xterm/xterm@${XTERM_VERSION}/lib/${XTERM_FILE}`
]

const host = sdk.host
const {
  atom,
  useValue,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  PALETTE_AREA,
  STATUSBAR_AREAS,
  Tip,
  haptic
} = sdk

const text = {
  primary: 'var(--ui-text-primary)',
  secondary: 'var(--ui-text-secondary)',
  tertiary: 'var(--ui-text-tertiary)',
  quaternary: 'var(--ui-text-quaternary)',
  red: 'var(--ui-red)',
  yellow: 'var(--ui-yellow)',
  green: 'var(--ui-green)',
  accent: 'var(--ui-accent)'
}

let storage = null
let os = null
let pollTimer = null
let inFlight = false
let pageMounted = 0
let cachedBin = null
let cachedRoot = ''
let cachedOutPath = null
let sshStop = null
let noticeTimer = null
let xtermCssInjected = false
let TerminalCtor = null
let xtermLoad = null
let sshReplay = { id: '', chunks: [], onChunk: null }
let sendStop = null
let sendClearTimer = null

const $snap = atom({ kind: 'idle' })
const $showShared = atom(false)
const $showOwner = atom(false)
const $dialog = atom(null)
const $ping = atom({})
const $ssh = atom(null)
const $sshAsk = atom(null)
const $publishAsk = atom(null)
const $notice = atom('')
const $send = atom(null)

const TAILDROP = {
  0: '',
  1: 'Can receive files',
  2: 'No netmap yet',
  3: 'Tailscale is not running',
  4: 'Missing file-sharing capability',
  5: 'Offline',
  6: 'No peer info',
  7: 'OS does not support Taildrop',
  8: 'No PeerAPI',
  9: 'Owned by another user'
}

// --- helpers (tested by tests/*.test.mjs, which slice this block out) ---

function errorMessage(error, fallback) {
  if (typeof error === 'string' && error && error !== '[object Object]') return error
  if (error && typeof error.message === 'string' && error.message && error.message !== '[object Object]') {
    return error.message
  }
  return fallback
}

function platformKind(nav) {
  const source = nav || (typeof navigator !== 'undefined' ? navigator : {})
  const platform = String(source.platform || source.userAgentData && source.userAgentData.platform || '')
  const ua = String(source.userAgent || '')
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows'
  if (/Mac/i.test(platform) || /Mac OS/i.test(ua) || /iPhone|iPad|iPod/i.test(ua)) return 'darwin'
  return 'linux'
}

function quoteShell(value, kind) {
  const s = String(value)
  if (kind === 'windows') return `"${s.replace(/"/g, '\\"')}"`
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function joinPath(root, parts, kind) {
  const sep = kind === 'windows' ? '\\' : '/'
  const clean = String(root || '').replace(/[\\/]+$/, '')
  return [clean, ...parts].join(sep)
}

// Where to look for xterm, in order: a copy next to plugin.js, then each
// pinned CDN URL. Every candidate is checked against the same hash.
function xtermSources(root, kind, pluginId, fileName, urls) {
  const out = []
  if (root) out.push({ kind: 'file', path: joinPath(root, [pluginId, fileName], kind) })
  for (const url of urls || []) out.push({ kind: 'url', url })
  return out
}

function integrityMatches(expected, digestBase64) {
  const want = String(expected || '').replace(/^sha384-/, '')
  const got = String(digestBase64 || '')
  return want.length === 64 && want === got
}

// Shadows the CommonJS and AMD globals so xterm's UMD header falls through
// to `root.Terminal = ...` with root = globalThis, then exports that.
function wrapXtermModule(text) {
  return `let exports, module, define;\n${text}\nexport default globalThis.Terminal\n`
}

function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < view.length; i += 3) {
    const a = view[i]
    const b = i + 1 < view.length ? view[i + 1] : 0
    const c = i + 2 < view.length ? view[i + 2] : 0
    const n = (a << 16) | (b << 8) | c
    out += table[(n >> 18) & 63] + table[(n >> 12) & 63]
    out += i + 1 < view.length ? table[(n >> 6) & 63] : '='
    out += i + 2 < view.length ? table[n & 63] : '='
  }
  return out
}

function binaryCandidates(kind) {
  if (kind === 'windows') {
    return [
      { path: 'tailscale' },
      { path: 'tailscale.exe' },
      { path: 'C:\\Program Files\\Tailscale\\tailscale.exe' },
      { path: 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe' }
    ]
  }
  if (kind === 'darwin') {
    return [
      { path: 'tailscale' },
      { path: '/usr/local/bin/tailscale' },
      { path: '/opt/homebrew/bin/tailscale' },
      { path: '/Applications/Tailscale.app/Contents/MacOS/Tailscale', envPrefix: 'TAILSCALE_BE_CLI=1' }
    ]
  }
  return [
    { path: 'tailscale' },
    { path: '/usr/bin/tailscale' },
    { path: '/usr/local/bin/tailscale' },
    { path: '/snap/bin/tailscale' }
  ]
}

function binCommand(bin, args, kind) {
  const exe = bin.envPrefix
    ? `${bin.envPrefix} ${quoteShell(bin.path, kind)}`
    : quoteShell(bin.path, kind)
  return `${exe} ${args}`
}

// Writes `tailscale status --json` to the cache file. On POSIX the file is
// created 0600 (umask) and an older, wider copy is tightened (chmod). On
// Windows the profile directory is already user-only, so plain redirect.
function statusRedirectCommand(bin, outPath, kind) {
  const target = quoteShell(outPath, kind)
  const write = `${binCommand(bin, 'status --json', kind)} > ${target}`
  if (kind === 'windows') return write
  return `umask 077 && ${write} && chmod 600 ${target}`
}

// Works from both cmd.exe and PowerShell on Windows, and any POSIX sh.
function removeCacheCommand(outPath, kind) {
  if (kind === 'windows') return `cmd /c del /q ${quoteShell(outPath, kind)}`
  return `rm -f ${quoteShell(outPath, kind)}`
}

function classifyCliError(result) {
  const err = `${(result && result.stderr) || ''} ${(result && result.stdout) || ''}`
  const code = result && result.code
  if (code === 127 || code === 9009) return 'missing'
  if (/not recognized|No such file or directory|cannot find the path|command not found/i.test(err)) {
    return 'missing'
  }
  if (
    /failed to connect to local tailscaled|cannot find the file specified|no such file or directory.*(?:sock|tailscaled)/i.test(
      err
    )
  ) {
    return 'daemon'
  }
  if (/access denied|permission denied/i.test(err)) return 'denied'
  return 'failed'
}

function isZeroTime(value) {
  if (!value) return true
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return true
  return t < Date.parse('1971-01-01T00:00:00Z')
}

function dnsLabel(dnsName, suffix) {
  let name = String(dnsName || '').replace(/\.$/, '')
  const extra = String(suffix || '').replace(/^\.+|\.+$/g, '')
  if (extra && name.toLowerCase().endsWith('.' + extra.toLowerCase())) {
    name = name.slice(0, -(extra.length + 1))
  }
  return name
}

function ownerLabel(user) {
  const login = user && (user.LoginName || user.DisplayName)
  if (!login) return ''
  const at = String(login).indexOf('@')
  return at > 0 ? String(login).slice(0, at + 1) : String(login)
}

function osLabel(value) {
  const x = String(value || '')
  if (!x) return '—'
  const lower = x.toLowerCase()
  if (lower === 'macos' || lower === 'darwin') return 'macOS'
  if (lower === 'windows') return 'Windows'
  if (lower === 'linux') return 'Linux'
  if (lower === 'ios') return 'iOS'
  if (lower === 'android') return 'Android'
  if (lower === 'tvos') return 'tvOS'
  return x
}

function pathLabel(peer) {
  if (!peer) return '—'
  if (peer.CurAddr) return 'direct'
  if (peer.Relay) return `relay ${peer.Relay}`
  if (peer.Active) return 'active'
  if (peer.Online) return 'idle'
  return '—'
}

function formatLastSeen(value, nowMs) {
  if (isZeroTime(value)) return ''
  const then = Date.parse(value)
  const now = nowMs || Date.now()
  const delta = Math.max(0, now - then)
  const minutes = Math.round(delta / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatKeyExpiry(value) {
  if (!value) return ''
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return String(value)
  return new Date(t).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}

function rowStatus(row) {
  if (!row) return 'offline'
  if (row.online) {
    if (row.isSelf) return row.path && row.path !== 'this device' ? row.path : 'online'
    if (row.path && row.path !== 'idle' && row.path !== 'active') return row.path
    return 'online'
  }
  return row.lastSeen || 'offline'
}

function rowGrid(showOwner) {
  return showOwner
    ? '14px minmax(140px, 1.8fr) 76px minmax(88px, 0.9fr) 132px minmax(92px, 0.9fr)'
    : '14px minmax(160px, 2fr) 76px 132px minmax(100px, 1fr)'
}

function formatBytes(n) {
  const x = Number(n)
  if (!Number.isFinite(x) || x <= 0) return '0 B'
  if (x < 1024) return `${Math.round(x)} B`
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1).replace(/\.0$/, '')} KB`
  if (x < 1024 * 1024 * 1024) return `${(x / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
  return `${(x / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, '')} GB`
}

function ipv4Of(ips) {
  if (!Array.isArray(ips)) return ''
  const found = ips.find(ip => /^\d+\.\d+\.\d+\.\d+$/.test(String(ip)))
  return found ? String(found) : ''
}

function ipv6Of(ips) {
  if (!Array.isArray(ips)) return ''
  const found = ips.find(ip => String(ip).includes(':'))
  return found ? String(found) : ''
}

function tagList(tags) {
  if (!tags) return []
  if (Array.isArray(tags)) return tags.map(String)
  if (Array.isArray(tags.Items)) return tags.Items.map(String)
  return []
}

function taildropLabel(code) {
  const n = Number(code)
  if (!Number.isFinite(n) || n === 0) return ''
  return TAILDROP[n] || `Taildrop ${n}`
}

function sshLine(row) {
  const hostName = row && (row.label || row.hostName)
  if (!hostName) return ''
  return `tailscale ssh ${hostName}`
}

function onlineCount(rows) {
  return (rows || []).filter(row => row.online).length
}

function parseStatus(raw, nowMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const backend = String(raw.BackendState || '')
  if (!backend) return null
  const suffix = (raw.CurrentTailnet && raw.CurrentTailnet.MagicDNSSuffix) || raw.MagicDNSSuffix || ''
  const users = raw.User && typeof raw.User === 'object' ? raw.User : {}
  const selfPeer = raw.Self && typeof raw.Self === 'object' ? raw.Self : null
  const peerMap = raw.Peer && typeof raw.Peer === 'object' ? raw.Peer : {}

  function toRow(peer, isSelf) {
    if (!peer || typeof peer !== 'object') return null
    const ips = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.map(String) : []
    const user = users[peer.UserID] || users[String(peer.UserID)] || null
    const label = dnsLabel(peer.DNSName, suffix) || peer.HostName || ipv4Of(ips) || 'unknown'
    const dns = String(peer.DNSName || '').replace(/\.$/, '')
    return {
      id: String(peer.ID || peer.PublicKey || label),
      isSelf: !!isSelf,
      sharee: !!peer.ShareeNode,
      label,
      hostName: peer.HostName || '',
      dns,
      os: osLabel(peer.OS),
      osRaw: peer.OS || '',
      owner: ownerLabel(user),
      ownerFull: (user && (user.LoginName || user.DisplayName)) || '',
      ipv4: ipv4Of(ips),
      ipv6: ipv6Of(ips),
      ips,
      online: !!peer.Online,
      active: !!peer.Active,
      path: isSelf ? (peer.Relay ? `home ${peer.Relay}` : 'this device') : pathLabel(peer),
      lastSeen: formatLastSeen(peer.LastSeen, nowMs),
      lastSeenRaw: peer.LastSeen || '',
      rx: formatBytes(peer.RxBytes),
      tx: formatBytes(peer.TxBytes),
      tags: tagList(peer.Tags),
      expired: !!peer.Expired,
      keyExpiry: isZeroTime(peer.KeyExpiry) ? '' : formatKeyExpiry(peer.KeyExpiry),
      taildrop: taildropLabel(peer.TaildropTarget),
      taildropCode: Number(peer.TaildropTarget) || 0,
      ssh: Array.isArray(peer.sshHostKeys) && peer.sshHostKeys.length > 0,
      exitNode: !!peer.ExitNode,
      exitNodeOption: !!peer.ExitNodeOption
    }
  }

  const rows = []
  const selfRow = toRow(selfPeer, true)
  if (selfRow) rows.push(selfRow)
  for (const key of Object.keys(peerMap)) {
    const row = toRow(peerMap[key], false)
    if (row) rows.push(row)
  }
  rows.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
    if (a.online !== b.online) return a.online ? -1 : 1
    if (a.active !== b.active) return a.active ? -1 : 1
    return a.label.localeCompare(b.label)
  })

  const exit = raw.ExitNodeStatus
  return {
    backend,
    version: raw.Version || '',
    tun: !!raw.TUN,
    health: Array.isArray(raw.Health) ? raw.Health.map(String) : [],
    suffix: String(suffix || ''),
    tailnet: (raw.CurrentTailnet && raw.CurrentTailnet.Name) || '',
    magicDns: !!(raw.CurrentTailnet && raw.CurrentTailnet.MagicDNSEnabled),
    authUrl: raw.AuthURL || '',
    selfIps: Array.isArray(raw.TailscaleIPs) ? raw.TailscaleIPs.map(String) : selfRow ? selfRow.ips : [],
    exitNode: exit && exit.ID ? { id: String(exit.ID), online: !!exit.Online } : null,
    rows
  }
}

function visibleRows(status, showShared) {
  const rows = (status && status.rows) || []
  if (showShared) return rows
  return rows.filter(row => row.isSelf || !row.sharee)
}

function emptyKind(status) {
  if (!status) return 'failed'
  if (status.backend === 'NeedsLogin' || status.backend === 'NeedsMachineAuth') return 'login'
  if (status.backend === 'Stopped' || status.backend === 'NoState') return 'stopped'
  if (status.backend === 'Starting') return 'starting'
  return ''
}

function barLabel(snap) {
  if (!snap || snap.kind === 'idle' || snap.kind === 'loading') return 'ts'
  if (snap.kind === 'missing') return 'ts off'
  if (snap.kind === 'daemon') return 'ts down'
  if (snap.kind === 'denied') return 'ts denied'
  if (snap.kind === 'gateway') return 'ts'
  if (snap.kind === 'error') return 'ts'
  if (snap.kind === 'ready') {
    const kind = emptyKind(snap.status)
    if (kind === 'login') return 'ts login'
    if (kind === 'stopped') return 'ts stopped'
    if (kind === 'starting') return 'ts …'
    const n = onlineCount(visibleRows(snap.status, false))
    return `ts ${n}`
  }
  return 'ts'
}

function barOk(snap) {
  return snap && snap.kind === 'ready' && snap.status && snap.status.backend === 'Running'
}

function isSafeHost(value) {
  const s = String(value || '')
  if (!s || s.length > 253) return false
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(s)
}

function isSafeUser(value) {
  const s = String(value || '').trim()
  if (!s || s.length > 32) return false
  return /^[A-Za-z_][A-Za-z0-9._-]*$/.test(s)
}

// A TCP port typed by the user. 0 means "not a port".
function parsePort(value) {
  const s = String(value == null ? '' : value).trim()
  if (!/^\d{1,5}$/.test(s)) return 0
  const n = Number(s)
  return n >= 1 && n <= 65535 ? n : 0
}

function serveArgs(port) {
  return `serve --bg --yes ${parsePort(port)}`
}

// curl is on Windows 10+, macOS, and nearly every Linux. It only has to tell
// us whether something answers on the loopback port; the body is discarded.
// On Windows the .exe suffix skips PowerShell's curl alias (Invoke-WebRequest).
function portProbeCommand(port, kind) {
  if (kind === 'windows') return `curl.exe -s -o NUL -m 3 http://127.0.0.1:${parsePort(port)}/`
  return `curl -s -o /dev/null -m 3 http://127.0.0.1:${parsePort(port)}/`
}

// 'open' when something answered (any HTTP status), 'closed' when the
// connection was refused, 'unknown' when curl is missing or gave up.
function classifyPortProbe(result) {
  if (!result) return 'unknown'
  const code = Number(result.code)
  if (code === 0 || code === 22) return 'open'
  if (code === 7) return 'closed'
  return 'unknown'
}

function sshSpec(user, dest) {
  const u = String(user || '').trim()
  const d = String(dest || '').trim()
  if (!isSafeUser(u) || !isSafeHost(d)) return ''
  return `${u}@${d}`
}

function parsePingOutput(text) {
  const lines = String(text || '').split(/\r?\n/)
  const pongs = []
  for (const line of lines) {
    const match = line.match(/^pong from (\S+) \(([^)]+)\) via (.+) in (\d+)\s*ms/i)
    if (!match) continue
    const via = match[3]
    let path = 'direct'
    if (/^DERP\(/i.test(via)) path = 'derp'
    else if (/^peer-relay\(/i.test(via)) path = 'peer-relay'
    pongs.push({ host: match[1], ip: match[2], via, ms: Number(match[4]), path })
  }
  const last = pongs.length ? pongs[pongs.length - 1] : null
  return {
    ok: pongs.length > 0,
    last,
    pongs,
    directFailed: /direct connection not established/i.test(String(text || ''))
  }
}

function pingSummary(parsed) {
  if (!parsed || !parsed.last) return parsed && parsed.directFailed ? 'no path' : 'no reply'
  const last = parsed.last
  const path = last.path === 'derp' ? last.via : last.path === 'peer-relay' ? 'peer-relay' : 'direct'
  return `${last.ms}ms ${path}`
}

function parseServeStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { empty: true, url: '', proxy: '', hostPort: '' }
  }
  const web = raw.Web
  if (!web || typeof web !== 'object') return { empty: true, url: '', proxy: '', hostPort: '' }
  const hostPort = Object.keys(web)[0] || ''
  if (!hostPort) return { empty: true, url: '', proxy: '', hostPort: '' }
  const handlers = web[hostPort] && web[hostPort].Handlers
  let proxy = ''
  if (handlers && typeof handlers === 'object') {
    const keys = Object.keys(handlers)
    const root = handlers['/'] || (keys.length ? handlers[keys[0]] : null)
    proxy = (root && (root.Proxy || root.Path || '')) || ''
  }
  const url = /:\/\//.test(hostPort) ? hostPort : `https://${hostPort}`
  return { empty: false, url, proxy: String(proxy), hostPort }
}

function parseSwitchList(raw) {
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter(row => row && (row.id || row.account))
    .map(row => ({
      id: String(row.id || ''),
      nickname: String(row.nickname || row.account || ''),
      tailnet: String(row.tailnet || ''),
      account: String(row.account || ''),
      selected: !!row.selected
    }))
}

function canReceiveFiles(row) {
  return !!(row && !row.isSelf && row.taildropCode === TAILDROP_AVAILABLE)
}

function exitNodeChoices(rows) {
  return (rows || []).filter(row => !row.isSelf && (row.exitNodeOption || row.exitNode))
}

function shellLine(bin, args, kind) {
  const rest = String(args || '').trim()
  if (!bin || !bin.path) return rest
  const pathName = String(bin.path)
  if (kind === 'windows') {
    if (!/[\\/]/.test(pathName)) return `tailscale ${rest}`
    return `& ${quoteShell(pathName, 'windows')} ${rest}`
  }
  if (bin.envPrefix) return `${bin.envPrefix} ${quoteShell(pathName, kind)} ${rest}`
  if (!pathName.includes('/')) return `tailscale ${rest}`
  return `${quoteShell(pathName, kind)} ${rest}`
}

function ptyChunk(payload) {
  if (payload == null) return ''
  if (typeof payload === 'string') return payload
  if (typeof payload === 'object' && typeof payload.data === 'string') return payload.data
  return String(payload)
}

function stripPty(text) {
  return String(text || '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[(?:[0-9]*B|[0-9]*E)/g, '\n')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[PX^_].*?\u001b\\/g, '')
    .replace(/[\u0000-\u0007\u000b\u000c\u000e-\u001a\u001c-\u001f]/g, '')
}

function applyPtyText(existing, incoming) {
  let chunk = String(incoming || '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[PX^_].*?\u001b\\/g, '')
  let out = String(existing || '')
  if (out.endsWith('\r')) {
    out = out.slice(0, -1)
    chunk = `\r${chunk}`
  }
  const clearLine = () => {
    const lastNl = out.lastIndexOf('\n')
    out = lastNl >= 0 ? out.slice(0, lastNl + 1) : ''
  }
  let i = 0
  while (i < chunk.length) {
    const ch = chunk[i]
    if (ch === '\u001b') {
      if (chunk[i + 1] === '[') {
        const match = chunk.slice(i).match(/^\u001b\[([0-9;?]*)([@-~])/)
        if (match) {
          const cmd = match[2]
          const n = parseInt(match[1], 10)
          i += match[0].length
          if (cmd === 'G' && (!n || n <= 1)) clearLine()
          else if (cmd === 'K' && (n === 1 || n === 2)) clearLine()
          else if (cmd === 'A' || cmd === 'F') {
            const count = Number.isFinite(n) && n > 0 ? n : 1
            for (let k = 0; k < count; k += 1) {
              if (out.endsWith('\n')) out = out.slice(0, -1)
              clearLine()
            }
          } else if (cmd === 'B' || cmd === 'E') {
            const count = Number.isFinite(n) && n > 0 ? n : 1
            out += '\n'.repeat(count)
          }
          continue
        }
      }
      i += 1
      continue
    }
    if (ch === '\r') {
      if (i === chunk.length - 1) {
        out += '\r'
        break
      }
      if (chunk[i + 1] === '\n') {
        out += '\n'
        i += 2
        continue
      }
      clearLine()
      i += 1
      continue
    }
    if (ch === '\n') {
      out += '\n'
      i += 1
      continue
    }
    if (ch === '\b') {
      if (out.length && out[out.length - 1] !== '\n') out = out.slice(0, -1)
      i += 1
      continue
    }
    if (ch < ' ' && ch !== '\t') {
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out.slice(-24000)
}

function pathBase(filePath) {
  const s = String(filePath || '').replace(/\\/g, '/')
  const trimmed = s.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return (i >= 0 ? trimmed.slice(i + 1) : trimmed) || String(filePath || '')
}

function isSafeFilePath(filePath) {
  const s = String(filePath || '')
  return !!s && !/[\r\n\0"]/.test(s)
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '')}"`
}

function fileCpCommand(bin, kind, filePath, dest) {
  if (kind === 'windows') {
    const exe = bin && bin.path && /[\\/]/.test(String(bin.path)) ? String(bin.path) : 'tailscale'
    return `echo HERMES_SEND_START\rcmd --% /c call ${quoteCmdArg(exe)} file cp ${quoteCmdArg(filePath)} ${quoteCmdArg(dest)}\rif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\rexit 0\r`
  }
  const args = `file cp ${quoteShell(filePath, kind)} ${quoteShell(dest, kind)}`
  const line = shellLine(bin, args, kind)
  return `echo HERMES_SEND_START; ${line}; echo HERMES_SEND_DONE:$?; exit $?\r`
}

function parseFileCpProgress(existingLog, incoming) {
  const log = applyPtyText(existingLog, incoming)
  const lines = log.replace(/\r/g, '\n').split('\n')
  let percent = null
  let rate = ''
  let eta = ''
  let size = ''
  let warning = ''
  const extra = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || '').replace(/\s+/g, ' ').trim()
    if (!line) continue
    if (/^# warning:/i.test(line)) {
      warning = line.replace(/^#\s*warning:\s*/i, '')
      continue
    }
    const pct = line.match(/(\d+(?:\.\d+)?)%/)
    const rateMatch = line.match(/(\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti)?B\/s)/i)
    const etaMatch = line.match(/ETA\s+(\d{2}:\d{2}:\d{2}|-)/i)
    const sizeMatch = line.match(/(\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti)?B)(?!\/)/i)
    if (pct) {
      percent = Math.max(0, Math.min(100, Number(pct[1])))
      if (rateMatch) rate = rateMatch[1]
      if (etaMatch && etaMatch[1] !== '-') eta = etaMatch[1]
      if (sizeMatch) size = sizeMatch[1]
      continue
    }
    if (/^PS /i.test(line) || /HERMES_SEND_/.test(line)) continue
    if (/^cmd --%/i.test(line) || /^echo HERMES_/i.test(line)) continue
    extra.push(line)
  }
  const detail = extra.length ? extra[extra.length - 1].slice(0, 180) : ''
  return {
    log: log.slice(-12000),
    percent,
    rate,
    eta,
    size,
    warning,
    extra,
    detail,
    started: /HERMES_SEND_START/.test(log)
  }
}

function sendStatusText(job) {
  if (!job) return ''
  if (job.state === 'ok') return `Sent ${job.name} to ${job.label}`
  if (job.state === 'err') return job.text || `Could not send ${job.name}`
  const bits = [`Sending ${job.name}`]
  if (job.percent != null && Number.isFinite(job.percent)) {
    const n = job.percent
    bits.push(`${Number.isInteger(n) ? n : n.toFixed(1).replace(/\.0$/, '')}%`)
  }
  if (job.size) bits.push(job.size)
  if (job.rate) bits.push(job.rate)
  if (job.eta) bits.push(`ETA ${job.eta}`)
  else if (job.detail && job.percent == null) bits.push(job.detail)
  return bits.join(' · ')
}

// --- runtime ---

function tap() {
  if (typeof haptic === 'function') haptic('tap')
}

function stored(key, fallback) {
  return storage ? storage.get(key, fallback) : fallback
}

function remember(key, value) {
  if (storage) storage.set(key, value)
}

function go(route) {
  if (typeof host.navigate === 'function') host.navigate(route)
}

function desktop() {
  return typeof window !== 'undefined' ? window.hermesDesktop : null
}

async function runShell(command) {
  return host.request('shell.exec', { command })
}

async function resolvePluginsRoot() {
  if (cachedRoot) return cachedRoot
  const bridge = desktop()
  if (bridge && typeof bridge.desktopPluginsRoot === 'function') {
    try {
      const root = await bridge.desktopPluginsRoot()
      if (root) {
        cachedRoot = String(root)
        return cachedRoot
      }
    } catch {
      /* older shell */
    }
  }
  return ''
}

async function resolveOutPath(kind) {
  if (cachedOutPath) return cachedOutPath
  const root = await resolvePluginsRoot()
  if (!root) return ''
  cachedOutPath = joinPath(root, [PLUGIN_ID, CACHE_FILE], kind)
  return cachedOutPath
}

// Best effort. The gateway may already be gone when the plugin unloads.
function removeCacheFile() {
  const path = cachedOutPath
  if (!path) return
  try {
    runShell(removeCacheCommand(path, platformKind())).catch(() => {})
  } catch {
    /* gateway closed first */
  }
}

async function readCacheFile(path) {
  const bridge = desktop()
  if (!bridge || typeof bridge.readFileText !== 'function' || !path) return ''
  const result = await bridge.readFileText(path)
  if (!result || result.truncated) return ''
  return String(result.text || '')
}

function looksCompleteJson(text) {
  const s = String(text || '').trim()
  return s.startsWith('{') && s.endsWith('}')
}

async function probeBinary(kind) {
  if (cachedBin) return { bin: cachedBin, error: null, kind: 'ok' }
  const failures = []
  for (const bin of binaryCandidates(kind)) {
    try {
      const result = await runShell(binCommand(bin, 'version --json', kind))
      if (!result || result.code) {
        const why = classifyCliError(result)
        failures.push(why)
        if (why === 'daemon' || why === 'denied') return { bin: null, error: result, kind: why }
        continue
      }
      cachedBin = bin
      return { bin, error: null, kind: 'ok' }
    } catch (error) {
      const message = errorMessage(error, '')
      if (/gateway unavailable/i.test(message)) return { bin: null, error: { message }, kind: 'gateway' }
      failures.push('failed')
    }
  }
  const kindOut = failures.includes('daemon') ? 'daemon' : failures.includes('denied') ? 'denied' : 'missing'
  return { bin: null, error: null, kind: kindOut }
}

async function loadSnapshot() {
  const gateway = host.state && host.state.gateway ? host.state.gateway.get() : ''
  if (gateway && gateway !== 'open') {
    return { kind: 'gateway', message: 'Hermes is not connected, so the Tailscale CLI cannot run.' }
  }
  const kind = platformKind()
  const probed = await probeBinary(kind)
  if (probed.kind === 'gateway') {
    return { kind: 'gateway', message: 'Hermes is not connected, so the Tailscale CLI cannot run.' }
  }
  if (probed.kind === 'missing') {
    return { kind: 'missing', message: 'Tailscale is not installed on this machine.' }
  }
  if (probed.kind === 'daemon') {
    return { kind: 'daemon', message: 'Tailscale is installed, but the daemon is not running.' }
  }
  if (probed.kind === 'denied') {
    return { kind: 'denied', message: 'This user cannot talk to the local Tailscale daemon.' }
  }
  if (!probed.bin) {
    return { kind: 'error', message: 'Could not run the Tailscale CLI.' }
  }

  const outPath = await resolveOutPath(kind)
  let rawText = ''
  try {
    if (outPath) {
      const redirected = await runShell(statusRedirectCommand(probed.bin, outPath, kind))
      if (redirected && redirected.code) {
        const why = classifyCliError(redirected)
        if (why === 'daemon') {
          return { kind: 'daemon', message: 'Tailscale is installed, but the daemon is not running.' }
        }
        // A missing cache directory looks like "cannot find the path" on
        // Windows. The version probe already proved the binary exists, so
        // fall through to the inline status read.
      } else {
        rawText = await readCacheFile(outPath)
      }
    }
    if (!looksCompleteJson(rawText)) {
      const inline = await runShell(binCommand(probed.bin, 'status --json', kind))
      if (inline && inline.code) {
        const why = classifyCliError(inline)
        if (why === 'missing') {
          cachedBin = null
          return { kind: 'missing', message: 'Tailscale is not installed on this machine.' }
        }
        if (why === 'daemon') {
          return { kind: 'daemon', message: 'Tailscale is installed, but the daemon is not running.' }
        }
        const err = String((inline && inline.stderr) || '').trim()
        return { kind: 'error', message: err || 'tailscale status failed' }
      }
      rawText = String((inline && inline.stdout) || '')
    }
  } catch (error) {
    const message = errorMessage(error, 'Could not run tailscale status')
    if (/gateway unavailable/i.test(message)) {
      return { kind: 'gateway', message: 'Hermes is not connected, so the Tailscale CLI cannot run.' }
    }
    return { kind: 'error', message }
  }

  const trimmed = rawText.trim()
  if (!looksCompleteJson(trimmed)) {
    return {
      kind: 'error',
      message: 'Tailscale status was truncated. Hermes only returns the last 4k of a shell command, and the cache file could not be read.'
    }
  }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { kind: 'error', message: 'Tailscale status was not valid JSON.' }
  }
  const status = parseStatus(parsed, Date.now())
  if (!status) return { kind: 'error', message: 'Tailscale status JSON was missing BackendState.' }

  let serve = { empty: true, url: '', proxy: '', hostPort: '' }
  let accounts = []
  try {
    const serveRun = await runShell(binCommand(probed.bin, 'serve status --json', kind))
    if (serveRun && !serveRun.code) {
      const textOut = String((serveRun.stdout || '')).trim() || '{}'
      serve = parseServeStatus(JSON.parse(textOut))
    }
  } catch {
    /* serve status is optional */
  }
  try {
    const switchRun = await runShell(binCommand(probed.bin, 'switch --list --json', kind))
    if (switchRun && !switchRun.code) {
      const textOut = String((switchRun.stdout || '')).trim() || '[]'
      accounts = parseSwitchList(JSON.parse(textOut))
    }
  } catch {
    /* switch list is optional */
  }

  return { kind: 'ready', status, serve, accounts, at: Date.now() }
}

async function refresh() {
  if (inFlight) return
  inFlight = true
  if ($snap.get().kind === 'idle') $snap.set({ kind: 'loading' })
  try {
    const next = await loadSnapshot()
    $snap.set(next)
  } catch (error) {
    $snap.set({ kind: 'error', message: errorMessage(error, 'Could not read Tailscale') })
  } finally {
    inFlight = false
  }
}

function pollDelay() {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  if (pageMounted > 0 && !hidden) return PAGE_POLL_MS
  return BAR_POLL_MS
}

function armPoll() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(() => {
    refresh().finally(() => armPoll())
  }, pollDelay())
}

function onPageMount() {
  pageMounted += 1
  refresh()
  armPoll()
  return () => {
    pageMounted = Math.max(0, pageMounted - 1)
    armPoll()
  }
}

function openUrl(url) {
  tap()
  if (os && typeof os.openExternal === 'function') {
    os.openExternal(url)
    return
  }
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener')
}

async function copyText(value) {
  const textValue = String(value || '')
  if (!textValue) return false
  tap()
  if (os && typeof os.writeClipboard === 'function') {
    const ok = await os.writeClipboard(textValue)
    if (ok) return true
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(textValue)
    return true
  }
  return false
}

function say(message) {
  $notice.set(String(message || ''))
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => $notice.set(''), 4000)
}

async function runCli(args) {
  const kind = platformKind()
  const probed = await probeBinary(kind)
  if (!probed.bin) return { ok: false, error: probed.kind || 'missing', stdout: '', stderr: '', code: 1, kind }
  const result = await runShell(binCommand(probed.bin, args, kind))
  const code = result && typeof result.code === 'number' ? result.code : 1
  return {
    ok: code === 0,
    error: '',
    stdout: String((result && result.stdout) || ''),
    stderr: String((result && result.stderr) || ''),
    code,
    kind
  }
}

function hostArg(row) {
  const value = (row && (row.label || row.ipv4 || row.hostName)) || ''
  return isSafeHost(value) ? value : ''
}

function sshCommand(row, bin, kind, user) {
  const dest =
    row && row.ssh
      ? hostArg(row)
      : (row && row.ipv4 && isSafeHost(row.ipv4) && row.ipv4) ||
        (row && row.dns && isSafeHost(row.dns) && row.dns) ||
        hostArg(row)
  const spec = sshSpec(user, dest)
  if (!spec) return ''
  if (row && row.ssh) return `${shellLine(bin, `ssh ${quoteShell(spec, kind)}`, kind)}\r`
  return `ssh ${quoteShell(spec, kind)}\r`
}

function ask(title, body, confirmLabel, run) {
  $dialog.set({ title, body, confirmLabel: confirmLabel || 'Confirm', run })
}

function closeDialog() {
  $dialog.set(null)
}

async function pingRow(row) {
  const target = hostArg(row)
  if (!target) {
    say('That hostname is not safe to pass to the CLI.')
    return
  }
  $ping.set({ ...$ping.get(), [row.id]: { state: 'busy', text: 'pinging…' } })
  try {
    const kind = platformKind()
    const probed = await probeBinary(kind)
    if (!probed.bin) {
      $ping.set({ ...$ping.get(), [row.id]: { state: 'err', text: 'no CLI' } })
      return
    }
    const args = `ping --c 1 --until-direct=false --timeout=5s ${quoteShell(target, kind)}`
    const result = await runShell(binCommand(probed.bin, args, kind))
    const parsed = parsePingOutput(String((result && result.stdout) || ''))
    if (parsed.ok) {
      $ping.set({ ...$ping.get(), [row.id]: { state: 'ok', text: pingSummary(parsed) } })
    } else {
      const err = String((result && result.stderr) || (result && result.stdout) || 'no reply').trim()
      $ping.set({
        ...$ping.get(),
        [row.id]: { state: 'err', text: err.split(/\r?\n/)[0].slice(0, 80) }
      })
    }
  } catch (error) {
    $ping.set({
      ...$ping.get(),
      [row.id]: { state: 'err', text: errorMessage(error, 'ping failed') }
    })
  }
}

function servePort() {
  return parsePort(stored('servePort', HERMES_PORT)) || HERMES_PORT
}

// Is anything listening on 127.0.0.1:port? Tries a renderer fetch first
// (fast, no shell). A refused connection and a CSP block both throw, so on
// failure ask curl through shell.exec, which can tell the two apart.
async function probeLocalPort(port) {
  const n = parsePort(port)
  if (!n) return 'closed'
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      await fetch(`http://127.0.0.1:${n}/`, { mode: 'no-cors', cache: 'no-store', signal: controller.signal })
      return 'open'
    } finally {
      clearTimeout(timer)
    }
  } catch {
    /* refused, blocked, or timed out */
  }
  try {
    const result = await runShell(portProbeCommand(n, platformKind()))
    return classifyPortProbe(result)
  } catch {
    return 'unknown'
  }
}

function openPublishAsk(replaces) {
  $publishAsk.set({ replaces: replaces || '' })
}

function closePublishAsk() {
  $publishAsk.set(null)
}

async function publishHermes(port) {
  const n = parsePort(port)
  if (!n) {
    say('That is not a valid port.')
    return
  }
  const result = await runCli(serveArgs(n))
  if (!result.ok) {
    say(result.stderr.trim() || result.stdout.trim() || 'tailscale serve failed')
    return
  }
  remember('servePort', n)
  say(`Serving local port ${n} on the tailnet`)
  refresh()
}

async function resetServe() {
  const result = await runCli('serve reset')
  if (!result.ok) {
    say(result.stderr.trim() || 'serve reset failed')
    return
  }
  say('Serve config cleared')
  refresh()
}

async function setExitNode(name) {
  const kind = platformKind()
  const probed = await probeBinary(kind)
  if (!probed.bin) {
    say('Tailscale CLI is not available.')
    return
  }
  if (name && !isSafeHost(name)) {
    say('That exit node name is not safe to pass to the CLI.')
    return
  }
  const flag = name ? `--exit-node=${name}` : '--exit-node='
  const result = await runShell(binCommand(probed.bin, `set ${flag}`, kind))
  if (result && result.code) {
    say(String((result.stderr || result.stdout || 'could not set exit node')).trim())
    return
  }
  say(name ? `Exit node: ${name}` : 'Exit node cleared')
  refresh()
}

async function switchAccount(id) {
  if (!isSafeHost(id) && !/^[A-Za-z0-9._@+-]+$/.test(String(id || ''))) {
    say('That account id is not safe to pass to the CLI.')
    return
  }
  const kind = platformKind()
  const probed = await probeBinary(kind)
  if (!probed.bin) return
  const result = await runShell(binCommand(probed.bin, `switch ${quoteShell(id, kind)}`, kind))
  if (result && result.code) {
    say(String((result.stderr || result.stdout || 'switch failed')).trim())
    return
  }
  cachedBin = probed.bin
  say(`Switched to ${id}`)
  refresh()
}

function stopSendPty() {
  if (typeof sendStop === 'function') {
    try {
      sendStop()
    } catch {
      /* already gone */
    }
  }
  sendStop = null
}

function patchSend(patch) {
  const cur = $send.get()
  if (!cur) return
  $send.set({ ...cur, ...patch })
}

function cancelSend() {
  const cur = $send.get()
  if (!cur || cur.state !== 'busy') return
  finishSend({ state: 'err', text: 'Cancelled' })
}

function finishSend(patch) {
  stopSendPty()
  const cur = $send.get()
  if (!cur) return
  $send.set({ ...cur, ...patch })
  if (sendClearTimer) clearTimeout(sendClearTimer)
  sendClearTimer = setTimeout(() => {
    const job = $send.get()
    if (job && job.state !== 'busy') $send.set(null)
  }, 8000)
}

function sendErrorText(parsed, fallback) {
  const lines = (parsed && parsed.extra) || []
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line) continue
    if (/^sending /i.test(line) || /^sent /i.test(line)) continue
    if (/file cp /i.test(line) || /tailscale/i.test(line) && /exit/i.test(line)) continue
    return line.slice(0, 180)
  }
  return fallback
}

async function sendFileShell(bin, kind, filePath, dest) {
  const result = await runShell(binCommand(bin, `file cp ${quoteShell(filePath, kind)} ${quoteShell(dest, kind)}`, kind))
  if (result && result.code) {
    finishSend({
      state: 'err',
      text: String((result.stderr || result.stdout || 'Taildrop failed')).trim().slice(0, 180)
    })
    return
  }
  finishSend({ state: 'ok', percent: 100, text: '' })
}

async function sendFilePty(bin, kind, filePath, dest) {
  const bridge = desktop()
  const session = await bridge.terminal.start({ cols: 100, rows: 24 })
  const id = session && session.id
  if (!id) {
    await sendFileShell(bin, kind, filePath, dest)
    return
  }
  const open = $send.get()
  if (open) $send.set({ ...open, ptyId: id })
  let finished = false
  const unsubData = bridge.terminal.onData(id, chunk => {
    const cur = $send.get()
    if (!cur || cur.ptyId !== id || finished) return
    const parsed = parseFileCpProgress(cur.log || '', ptyChunk(chunk))
    const next = { log: parsed.log }
    if (parsed.percent != null) next.percent = parsed.percent
    if (parsed.rate) next.rate = parsed.rate
    if (parsed.eta) next.eta = parsed.eta
    if (parsed.size) next.size = parsed.size
    if (parsed.warning) next.warning = parsed.warning
    if (parsed.detail) next.detail = parsed.detail
    patchSend(next)
  })
  const unsubExit = bridge.terminal.onExit
    ? bridge.terminal.onExit(id, info => {
        if (finished) return
        finished = true
        const cur = $send.get()
        const parsed = parseFileCpProgress((cur && cur.log) || '', '')
        const code = info && info.code
        if (code) {
          finishSend({
            state: 'err',
            text: sendErrorText(parsed, `Taildrop failed${code ? ` (${code})` : ''}`)
          })
        } else {
          finishSend({ state: 'ok', percent: 100, text: '' })
        }
        bridge.terminal.dispose(id).catch(() => undefined)
      })
    : () => {}
  sendStop = () => {
    finished = true
    unsubData && unsubData()
    unsubExit && unsubExit()
    if (bridge.terminal && typeof bridge.terminal.dispose === 'function') {
      bridge.terminal.dispose(id).catch(() => undefined)
    }
  }
  if (typeof bridge.terminal.attach === 'function') {
    const attached = await bridge.terminal.attach(id)
    if (!attached) {
      stopSendPty()
      await sendFileShell(bin, kind, filePath, dest)
      return
    }
  }
  const command = fileCpCommand(bin, kind, filePath, dest)
  await new Promise(resolve => setTimeout(resolve, 500))
  const cur = $send.get()
  if (!cur || cur.state !== 'busy' || finished) return
  await bridge.terminal.write(id, command)
  setTimeout(() => {
    const job = $send.get()
    if (!job || job.ptyId !== id || job.state !== 'busy' || finished) return
    if (job.percent == null) {
      patchSend({
        warning: job.warning || 'Still working. Tailscale only prints a percent when it has a real console.'
      })
    }
  }, 6000)
}

async function sendFile(row) {
  if (!canReceiveFiles(row)) {
    say('That machine cannot receive files right now.')
    return
  }
  const target = hostArg(row)
  if (!target) {
    say('That hostname is not safe to pass to the CLI.')
    return
  }
  if (!os || typeof os.pickOpenPath !== 'function') {
    say('This Desktop build cannot pick a file.')
    return
  }
  const busy = $send.get()
  if (busy && busy.state === 'busy') {
    say(`Already sending ${busy.name}.`)
    return
  }
  const path = await os.pickOpenPath({ title: `Send to ${row.label}` })
  if (!path) return
  if (!isSafeFilePath(path)) {
    say('That file path is not safe to pass to the CLI.')
    return
  }
  const kind = platformKind()
  const probed = await probeBinary(kind)
  if (!probed.bin) return
  const dest = `${target}:`
  const name = pathBase(path)
  if (sendClearTimer) clearTimeout(sendClearTimer)
  stopSendPty()
  $send.set({
    rowId: row.id,
    state: 'busy',
    name,
    label: row.label,
    percent: null,
    rate: '',
    eta: '',
    size: '',
    warning: '',
    detail: '',
    log: '',
    text: `Sending ${name}`
  })
  try {
    const bridge = desktop()
    if (bridge && bridge.terminal && typeof bridge.terminal.start === 'function') {
      await sendFilePty(probed.bin, kind, path, dest)
      return
    }
    await sendFileShell(probed.bin, kind, path, dest)
  } catch (error) {
    finishSend({ state: 'err', text: errorMessage(error, 'Taildrop failed') })
  }
}

function cssVar(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  } catch {
    return fallback
  }
}

function xtermTheme() {
  const theme = {
    background: cssVar('--ui-bg-editor', '') || cssVar('--ui-surface-background', ''),
    foreground: cssVar('--ui-text-primary', ''),
    cursor: cssVar('--ui-accent', ''),
    cursorAccent: cssVar('--ui-bg-editor', '') || cssVar('--ui-surface-background', ''),
    selectionBackground: cssVar('--ui-selection', ''),
    black: cssVar('--ui-text-quaternary', ''),
    red: cssVar('--ui-red', ''),
    green: cssVar('--ui-green', ''),
    yellow: cssVar('--ui-yellow', ''),
    blue: cssVar('--ui-accent', ''),
    magenta: cssVar('--ui-accent', ''),
    cyan: cssVar('--ui-accent', ''),
    white: cssVar('--ui-text-primary', '')
  }
  Object.keys(theme).forEach(key => {
    if (!theme[key]) delete theme[key]
  })
  return theme
}

function injectXtermCss() {
  if (xtermCssInjected || typeof document === 'undefined') return
  xtermCssInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-hermes-tailscale', 'xterm')
  style.textContent = [
    '.xterm{position:relative;height:100%;width:100%;padding:8px;box-sizing:border-box;user-select:none;-ms-user-select:none;-webkit-user-select:none}',
    '.xterm.focus,.xterm:focus{outline:none}',
    '.xterm .xterm-helpers{position:absolute;top:0;z-index:5}',
    '.xterm .xterm-helper-textarea{position:absolute;opacity:0;left:-9999em;top:0;width:0;height:0;z-index:-5;white-space:nowrap;overflow:hidden;resize:none}',
    '.xterm .composition-view{display:none}',
    '.xterm .xterm-viewport{overflow-y:auto;cursor:default;position:absolute;right:0;left:0;top:0;bottom:0}',
    '.xterm .xterm-screen{position:relative}',
    '.xterm .xterm-screen canvas{position:absolute;left:0;top:0}',
    '.xterm .xterm-scroll-area{visibility:hidden}',
    '.xterm-char-measure-element{display:inline-block;visibility:hidden;position:absolute;top:0;left:-9999em;line-height:normal}',
    '.xterm.enable-mouse-events{cursor:default}'
  ].join('')
  document.head.appendChild(style)
}

function ctorFromModule(mod) {
  if (!mod) return null
  if (typeof mod.Terminal === 'function') return mod.Terminal
  if (typeof mod.default === 'function') return mod.default
  if (mod.default && typeof mod.default.Terminal === 'function') return mod.default.Terminal
  return null
}

async function sha384Base64(bytes) {
  const digest = await crypto.subtle.digest('SHA-384', bytes)
  return bytesToBase64(new Uint8Array(digest))
}

// Reads one xterm candidate (local file or CDN) as bytes. Nothing here is
// executed. The caller hashes the bytes first.
async function fetchXtermBytes(source) {
  if (source.kind === 'file') {
    const bridge = desktop()
    if (!bridge || typeof bridge.readFileText !== 'function') throw new Error('no file bridge')
    const result = await bridge.readFileText(source.path)
    if (!result || result.truncated || !result.text) throw new Error('missing or truncated')
    return new TextEncoder().encode(String(result.text))
  }
  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

// Runs already-verified xterm source from a blob URL. The plugin itself is a
// blob module, so blob: is an allowed script origin. The verified text is
// wrapped so the UMD header takes its global branch no matter what the
// renderer exposes, then Terminal is read back off globalThis.
async function executeXterm(bytes) {
  const text = new TextDecoder().decode(bytes)
  const moduleUrl = URL.createObjectURL(new Blob([wrapXtermModule(text)], { type: 'text/javascript' }))
  try {
    const mod = await import(moduleUrl)
    const ctor = ctorFromModule(mod) || globalThis.Terminal
    if (typeof ctor === 'function') return ctor
  } catch {
    /* fall through to a classic script tag */
  } finally {
    URL.revokeObjectURL(moduleUrl)
  }
  const scriptUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }))
  try {
    return await new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = scriptUrl
      script.async = true
      script.onload = () => {
        script.remove()
        if (typeof globalThis.Terminal === 'function') resolve(globalThis.Terminal)
        else reject(new Error('xterm did not expose Terminal'))
      }
      script.onerror = () => {
        script.remove()
        reject(new Error('blob script failed to run'))
      }
      document.head.appendChild(script)
    })
  } finally {
    URL.revokeObjectURL(scriptUrl)
  }
}

async function loadTerminal() {
  if (typeof TerminalCtor === 'function') return TerminalCtor
  if (typeof globalThis.Terminal === 'function') {
    TerminalCtor = globalThis.Terminal
    injectXtermCss()
    return TerminalCtor
  }
  if (xtermLoad) return xtermLoad
  xtermLoad = (async () => {
    injectXtermCss()
    const kind = platformKind()
    const root = await resolvePluginsRoot()
    const errors = []
    for (const source of xtermSources(root, kind, PLUGIN_ID, XTERM_FILE, XTERM_URLS)) {
      const label = source.kind === 'file' ? source.path : source.url
      try {
        const bytes = await fetchXtermBytes(source)
        const digest = await sha384Base64(bytes)
        if (!integrityMatches(XTERM_SHA384, digest)) {
          errors.push(`${label}: hash mismatch, refused to run it`)
          continue
        }
        TerminalCtor = await executeXterm(bytes)
        return TerminalCtor
      } catch (err) {
        errors.push(`${label}: ${err && err.message ? err.message : String(err)}`)
      }
    }
    throw new Error(
      `Could not load a verified terminal emulator. Put xterm ${XTERM_VERSION} lib/${XTERM_FILE} next to plugin.js, or allow cdn.jsdelivr.net. ${errors.join(' | ')}`
    )
  })()
  try {
    return await xtermLoad
  } catch (err) {
    xtermLoad = null
    throw err
  }
}

function measureCell(term) {
  const dims = term._core && term._core._renderService && term._core._renderService.dimensions
  const css = dims && dims.css
  const cw = css && css.cell && css.cell.width
  const ch = css && css.cell && css.cell.height
  return {
    width: cw > 1 ? cw : 9,
    height: ch > 1 ? ch : 17
  }
}

function fitTerm(term, el) {
  if (!term || !el) return { cols: 0, rows: 0 }
  const width = el.clientWidth
  const height = el.clientHeight
  if (width < 20 || height < 20) return { cols: term.cols || 0, rows: term.rows || 0 }
  const cell = measureCell(term)
  const cols = Math.max(20, Math.floor((width - 16) / cell.width))
  const rows = Math.max(8, Math.floor((height - 16) / cell.height))
  if (cols !== term.cols || rows !== term.rows) {
    try {
      term.resize(cols, rows)
    } catch {
      /* ignore */
    }
  }
  return { cols: term.cols, rows: term.rows }
}

function hasSize(el) {
  return !!el && el.isConnected && el.clientWidth >= 20 && el.clientHeight >= 20
}

function waitForSize(el, isCancelled) {
  if (hasSize(el)) return Promise.resolve(true)
  return new Promise(resolve => {
    let ro = null
    let poll = 0
    const done = ok => {
      if (ro) ro.disconnect()
      if (poll) clearInterval(poll)
      resolve(ok)
    }
    const check = () => {
      if (isCancelled()) return done(false)
      if (hasSize(el)) done(true)
    }
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(check)
      ro.observe(el)
    }
    poll = setInterval(check, 250)
  })
}

function closeSsh() {
  if (typeof sshStop === 'function') {
    try {
      sshStop()
    } catch {
      /* already gone */
    }
  }
  sshStop = null
  const session = $ssh.get()
  const bridge = desktop()
  if (session && session.id && bridge && bridge.terminal && typeof bridge.terminal.dispose === 'function') {
    bridge.terminal.dispose(session.id).catch(() => undefined)
  }
  $ssh.set(null)
}

function askSshUser(row) {
  $sshAsk.set({ row })
}

function cancelSshAsk() {
  $sshAsk.set(null)
}

async function openSsh(row, user) {
  $sshAsk.set(null)
  if (!isSafeUser(user)) {
    say('Type a username. It is not saved.')
    return
  }
  const target = hostArg(row)
  if (!target) {
    say('That hostname is not safe to pass to the CLI.')
    return
  }
  const bridge = desktop()
  if (!bridge || !bridge.terminal || typeof bridge.terminal.start !== 'function') {
    const spec = sshSpec(user, row && row.ssh ? target : row.ipv4 || target)
    copyText(row && row.ssh ? `tailscale ssh ${spec}` : `ssh ${spec}`)
    say('No in-app PTY on this Desktop build. Copied the ssh line instead.')
    return
  }
  closeSsh()
  try {
    const session = await bridge.terminal.start({ cols: 120, rows: 32 })
    const id = session && session.id
    if (!id) {
      say('Could not start a terminal.')
      return
    }
    sshReplay = { id, chunks: [], onChunk: null }
    const unsubData = bridge.terminal.onData(id, chunk => {
      if (sshReplay.id !== id) return
      const text = ptyChunk(chunk)
      if (!text) return
      sshReplay.chunks.push(text)
      if (sshReplay.chunks.length > 400) sshReplay.chunks = sshReplay.chunks.slice(-300)
      if (typeof sshReplay.onChunk === 'function') sshReplay.onChunk(text)
    })
    const unsubExit = bridge.terminal.onExit
      ? bridge.terminal.onExit(id, info => {
          const cur = $ssh.get()
          if (!cur || cur.id !== id) return
          $ssh.set({ ...cur, exited: true, code: info && info.code })
        })
      : () => {}
    sshStop = () => {
      unsubData && unsubData()
      unsubExit && unsubExit()
      if (sshReplay.id === id) sshReplay = { id: '', chunks: [], onChunk: null }
    }
    const kind = platformKind()
    const probed = await probeBinary(kind)
    const command = sshCommand(row, probed.bin, kind, user)
    if (!command) {
      say('Could not build an ssh command.')
      closeSsh()
      return
    }
    $ssh.set({
      id,
      title: `${user}@${row.label}`,
      note: row && row.ssh ? '' : 'Plain ssh to the Tailscale IP. Enable Tailscale SSH on the other machine if you want key-checked tailscale ssh.',
      log: '',
      exited: false
    })
    await new Promise(resolve => setTimeout(resolve, 350))
    if ($ssh.get() && $ssh.get().id === id) {
      await bridge.terminal.write(id, command)
    }
  } catch (error) {
    say(errorMessage(error, 'Could not open SSH'))
  }
}

function SmallButton({ onClick, children, title, disabled, active }) {
  return jsx('button', {
    type: 'button',
    title,
    disabled: !!disabled,
    onClick,
    style: {
      fontSize: '0.6875rem',
      padding: '2px 8px',
      border: `1px solid ${active ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
      borderRadius: 4,
      color: active ? text.primary : text.secondary,
      background: active ? 'var(--ui-control-active-background)' : 'transparent',
      opacity: disabled ? 0.5 : 1,
      cursor: disabled ? 'default' : 'pointer'
    },
    children
  })
}

function CopyBtn({ value, label }) {
  const [done, setDone] = useState(false)
  if (!value) return null
  return jsx(SmallButton, {
    title: `Copy ${label}`,
    onClick: () => {
      copyText(value).then(ok => {
        if (!ok) return
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      })
    },
    children: done ? 'Copied' : label
  })
}

function SettingsToggle({ on, label, hint, onClick }) {
  return jsxs('button', {
    type: 'button',
    onClick,
    title: hint,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      width: '100%',
      padding: '8px 10px',
      border: 0,
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer'
    },
    children: [
      jsx('span', { style: { fontSize: '0.8125rem', color: text.primary }, children: label }),
      jsx('span', {
        style: { fontSize: '0.75rem', color: on ? text.accent : text.tertiary, flexShrink: 0 },
        children: on ? 'On' : 'Off'
      })
    ]
  })
}

function NoticeLine() {
  const notice = useValue($notice)
  if (!notice) return null
  return jsx('div', {
    style: {
      padding: '6px 16px',
      fontSize: '0.75rem',
      color: text.secondary,
      borderBottom: '1px solid var(--ui-stroke-secondary)'
    },
    children: notice
  })
}

function SendBar() {
  const job = useValue($send)
  if (!job) return null
  const busy = job.state === 'busy'
  const failed = job.state === 'err'
  const pct = busy && job.percent != null && Number.isFinite(job.percent) ? job.percent : job.state === 'ok' ? 100 : null
  return jsxs('div', {
    style: {
      padding: '8px 16px',
      borderBottom: '1px solid var(--ui-stroke-secondary)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8 },
        children: [
          jsx('div', {
            style: {
              fontSize: '0.75rem',
              color: failed ? text.red : busy ? text.primary : text.secondary,
              minWidth: 0,
              flex: 1
            },
            children: sendStatusText(job)
          }),
          busy
            ? jsx(SmallButton, { onClick: cancelSend, children: 'Cancel' })
            : null
        ]
      }),
      job.warning
        ? jsx('div', { style: { fontSize: '0.6875rem', color: text.yellow }, children: job.warning })
        : null,
      pct != null
        ? jsx('div', {
            style: {
              height: 3,
              borderRadius: 99,
              background: 'var(--ui-stroke-secondary)',
              overflow: 'hidden'
            },
            children: jsx('div', {
              style: {
                height: '100%',
                width: '100%',
                transform: `scaleX(${Math.max(0, Math.min(100, pct)) / 100})`,
                transformOrigin: 'left center',
                background: failed ? 'var(--ui-red)' : 'var(--ui-accent)',
                transition: 'transform 160ms linear'
              }
            })
          })
        : busy
          ? jsx('div', {
              style: {
                height: 3,
                borderRadius: 99,
                background: 'var(--ui-stroke-secondary)',
                overflow: 'hidden'
              }
            })
          : null
    ]
  })
}

function SshAskBar() {
  const ask = useValue($sshAsk)
  const [user, setUser] = useState('')
  useEffect(() => {
    setUser('')
  }, [ask && ask.row && ask.row.id])
  if (!ask || !ask.row) return null
  const ok = isSafeUser(user)
  const go = () => {
    if (!ok) return
    tap()
    openSsh(ask.row, user.trim())
  }
  return jsxs('div', {
    style: {
      padding: '10px 16px',
      borderBottom: '1px solid var(--ui-stroke-secondary)',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      background: 'var(--ui-bg-secondary, transparent)'
    },
    children: [
      jsx('div', {
        style: { fontSize: '0.8125rem', fontWeight: 600, color: text.primary },
        children: `SSH to ${ask.row.label}`
      }),
      jsx('div', {
        style: { fontSize: '0.75rem', color: text.secondary },
        children: 'Username for this connection. Not saved.'
      }),
      jsxs('div', {
        style: { display: 'flex', gap: 6, alignItems: 'center' },
        children: [
          jsx('input', {
            value: user,
            autoFocus: true,
            onChange: event => setUser(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                go()
              }
            },
            style: {
              height: 28,
              minWidth: 160,
              padding: '0 8px',
              borderRadius: 6,
              border: '1px solid var(--ui-stroke-secondary)',
              background: 'transparent',
              color: text.primary,
              font: 'inherit',
              fontSize: '0.8125rem',
              outline: 'none'
            }
          }),
          jsx(SmallButton, { active: true, disabled: !ok, onClick: go, children: 'Connect' }),
          jsx(SmallButton, { onClick: cancelSshAsk, children: 'Cancel' })
        ]
      })
    ]
  })
}

function PublishBar() {
  const ask = useValue($publishAsk)
  const [port, setPort] = useState('')
  const [check, setCheck] = useState({ state: 'idle', port: 0 })
  useEffect(() => {
    setPort(ask ? String(servePort()) : '')
    setCheck({ state: 'idle', port: 0 })
  }, [!!ask])
  if (!ask) return null
  const n = parsePort(port)
  const busy = check.state === 'busy'
  const publish = () => {
    closePublishAsk()
    publishHermes(n)
  }
  const go = async () => {
    if (!n || busy) return
    tap()
    setCheck({ state: 'busy', port: n })
    const found = await probeLocalPort(n)
    if (found === 'open') {
      publish()
      return
    }
    setCheck({ state: found, port: n })
  }
  const inputStyle = {
    height: 28,
    width: 88,
    padding: '0 8px',
    borderRadius: 6,
    border: `1px solid ${n ? 'var(--ui-stroke-secondary)' : text.red}`,
    background: 'transparent',
    color: text.primary,
    font: 'inherit',
    fontSize: '0.8125rem',
    outline: 'none'
  }
  const replaces = ask.replaces ? ` This replaces the current target (${ask.replaces}).` : ''
  let verdict = null
  if (check.state === 'closed' && check.port === n) {
    verdict = `Nothing is listening on 127.0.0.1:${n}. Serve was not changed. Check the Hermes dashboard port and try again.`
  } else if (check.state === 'unknown' && check.port === n) {
    verdict = `Could not check 127.0.0.1:${n} (curl missing or the port did not answer in 3 seconds). Publish anyway only if you are sure Hermes is on that port.`
  }
  return jsxs('div', {
    style: {
      padding: '10px 16px',
      borderBottom: '1px solid var(--ui-stroke-secondary)',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      background: 'var(--ui-bg-secondary, transparent)'
    },
    children: [
      jsx('div', {
        style: { fontSize: '0.8125rem', fontWeight: 600, color: text.primary },
        children: 'Publish Hermes on the tailnet?'
      }),
      jsx('div', {
        style: { fontSize: '0.75rem', color: text.secondary, lineHeight: 1.45, maxWidth: 640 },
        children: `This runs tailscale serve --bg on the local port below. Other devices on the tailnet can open https://<this-node>.<tailnet>.ts.net and reach whatever listens there. It is not Funnel. It is not on the public internet.${replaces}`
      }),
      jsxs('div', {
        style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
        children: [
          jsx('span', { style: { fontSize: '0.75rem', color: text.secondary }, children: 'Local port' }),
          jsx('input', {
            value: port,
            inputMode: 'numeric',
            autoFocus: true,
            disabled: busy,
            onChange: event => setPort(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                go()
              }
            },
            style: inputStyle
          }),
          jsx(SmallButton, {
            active: true,
            disabled: !n || busy,
            onClick: go,
            children: busy ? `Checking ${check.port}…` : 'Publish'
          }),
          check.state === 'unknown' && check.port === n
            ? jsx(SmallButton, { onClick: publish, children: 'Publish anyway' })
            : null,
          jsx(SmallButton, { onClick: closePublishAsk, children: 'Cancel' })
        ]
      }),
      verdict
        ? jsx('div', {
            style: { fontSize: '0.75rem', color: check.state === 'closed' ? text.red : text.yellow, lineHeight: 1.45, maxWidth: 640 },
            children: verdict
          })
        : null
    ]
  })
}

function ConfirmBar() {
  const dialog = useValue($dialog)
  if (!dialog) return null
  return jsxs('div', {
    style: {
      padding: '10px 16px',
      borderBottom: '1px solid var(--ui-stroke-secondary)',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      background: 'var(--ui-bg-secondary, transparent)'
    },
    children: [
      jsx('div', { style: { fontSize: '0.8125rem', fontWeight: 600, color: text.primary }, children: dialog.title }),
      jsx('div', { style: { fontSize: '0.75rem', color: text.secondary, lineHeight: 1.45, maxWidth: 640 }, children: dialog.body }),
      jsxs('div', {
        style: { display: 'flex', gap: 6 },
        children: [
          jsx(SmallButton, {
            active: true,
            onClick: () => {
              const run = dialog.run
              closeDialog()
              tap()
              if (typeof run === 'function') run()
            },
            children: dialog.confirmLabel
          }),
          jsx(SmallButton, { onClick: () => closeDialog(), children: 'Cancel' })
        ]
      })
    ]
  })
}

function SshOverlay() {
  const session = useValue($ssh)
  const hostRef = useRef(null)
  const logRef = useRef(null)
  const [draft, setDraft] = useState('')
  const [termErr, setTermErr] = useState('')
  const [log, setLog] = useState('')
  const sessionId = session && session.id

  useEffect(() => {
    setTermErr('')
    setLog(session && session.log ? session.log : '')
    setDraft('')
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return undefined
    const el = hostRef.current
    const bridge = desktop()
    if (!bridge || !bridge.terminal) return undefined
    let cancelled = false
    let term = null
    let onDataDisp = null
    let ro = null
    const id = sessionId

    function replayInto(write) {
      if (sshReplay.id !== id) return
      for (let i = 0; i < sshReplay.chunks.length; i += 1) write(sshReplay.chunks[i])
      sshReplay.onChunk = write
    }

    async function attachNow() {
      if (typeof bridge.terminal.attach !== 'function') return true
      const attached = await bridge.terminal.attach(id)
      if (!attached && !cancelled) {
        say('Terminal session disappeared before output attached.')
        closeSsh()
      }
      return attached
    }

    async function boot() {
      let Terminal
      try {
        Terminal = await loadTerminal()
      } catch (err) {
        if (cancelled) return
        setTermErr(err && err.message ? err.message : String(err))
        let acc = ''
        replayInto(chunk => {
          if (cancelled) return
          acc = applyPtyText(acc, chunk)
          setLog(acc)
        })
        await attachNow()
        return
      }
      if (cancelled) return
      if (!el || !hasSize(el)) {
        const sized = el ? await waitForSize(el, () => cancelled) : false
        if (!sized || cancelled) {
          if (!cancelled) setTermErr('Terminal host was not ready.')
          return
        }
      }
      const kind = platformKind()
      const windows = kind === 'windows'
      term = new Terminal({
        cursorBlink: true,
        convertEol: false,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 5000,
        theme: xtermTheme(),
        windowsMode: windows,
        windowsPty: windows ? { backend: 'conpty' } : undefined
      })
      try {
        term.open(el)
      } catch (err) {
        if (!cancelled) setTermErr(errorMessage(err, 'Could not open terminal'))
        return
      }
      const size = fitTerm(term, el)
      if (typeof bridge.terminal.resize === 'function') {
        await bridge.terminal.resize(id, size)
      }
      if (typeof term.onData === 'function') {
        onDataDisp = term.onData(data => {
          if (!cancelled) bridge.terminal.write(id, data)
        })
      }
      replayInto(chunk => {
        if (cancelled || !term) return
        term.write(chunk)
      })
      const attached = await attachNow()
      if (!attached || cancelled) return
      term.focus()
      if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => {
          if (cancelled || !term) return
          const next = fitTerm(term, el)
          if (bridge.terminal.resize) bridge.terminal.resize(id, next)
        })
        ro.observe(el)
      }
    }

    boot().catch(err => {
      if (!cancelled) setTermErr(errorMessage(err, 'Could not start terminal'))
    })

    return () => {
      cancelled = true
      if (sshReplay.id === id && sshReplay.onChunk) sshReplay.onChunk = null
      if (ro) ro.disconnect()
      if (onDataDisp && typeof onDataDisp.dispose === 'function') onDataDisp.dispose()
      if (term) {
        try {
          term.dispose()
        } catch {
          /* ignore */
        }
      }
    }
  }, [sessionId])

  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [log])

  if (!session) return null
  const fallback = !!termErr
  const send = () => {
    const bridge = desktop()
    if (!bridge || !bridge.terminal) return
    bridge.terminal.write(session.id, `${draft}\r`)
    setDraft('')
  }
  return jsxs('div', {
    style: {
      position: 'absolute',
      inset: 12,
      zIndex: 8,
      display: 'flex',
      flexDirection: 'column',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: 10,
      background: 'var(--ui-bg-editor, var(--ui-surface-background, Canvas))',
      overflow: 'hidden'
    },
    children: [
      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderBottom: '1px solid var(--ui-stroke-secondary)'
        },
        children: [
          jsxs('div', {
            style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
            children: [
              jsx('span', {
                style: { fontSize: '0.8125rem', fontWeight: 600, color: text.primary },
                children: `ssh ${session.title}`
              }),
              session.note
                ? jsx('span', {
                    style: { fontSize: '0.6875rem', color: text.tertiary },
                    children: session.note
                  })
                : null
            ]
          }),
          session.exited
            ? jsx('span', { style: { fontSize: '0.75rem', color: text.tertiary }, children: `exit ${session.code == null ? '' : session.code}` })
            : null,
          jsx('span', { style: { marginLeft: 'auto' } }),
          jsx(SmallButton, { onClick: closeSsh, children: 'Close' })
        ]
      }),
      fallback
        ? jsx('pre', {
            ref: logRef,
            style: {
              flex: 1,
              minHeight: 0,
              margin: 0,
              padding: 10,
              overflow: 'auto',
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: '0.75rem',
              color: text.primary,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            },
            children: log || termErr || ' '
          })
        : jsx('div', {
            ref: hostRef,
            onClick: event => {
              const area = event.currentTarget.querySelector('textarea')
              if (area && typeof area.focus === 'function') area.focus()
            },
            style: { flex: 1, minHeight: 0, width: '100%' }
          }),
      fallback
        ? jsx('input', {
            value: draft,
            disabled: !!session.exited,
            onChange: event => setDraft(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                send()
              }
            },
            style: {
              height: 32,
              border: 0,
              borderTop: '1px solid var(--ui-stroke-secondary)',
              background: 'transparent',
              color: text.primary,
              padding: '0 10px',
              font: 'inherit',
              fontSize: '0.8125rem',
              outline: 'none'
            }
          })
        : null
    ]
  })
}

function Dot({ on }) {
  return jsx('span', {
    'aria-hidden': true,
    style: {
      width: 8,
      height: 8,
      borderRadius: 99,
      flexShrink: 0,
      background: on ? text.green : 'var(--ui-stroke-secondary)'
    }
  })
}

function EmptyState({ snap }) {
  const kind = snap.kind
  const statusKind = snap.kind === 'ready' ? emptyKind(snap.status) : kind
  const authUrl = snap.status && snap.status.authUrl
  let title = 'Could not read Tailscale'
  let body = snap.message || ''
  let actions = []
  if (kind === 'loading' || statusKind === 'starting') {
    title = 'Talking to Tailscale'
    body = 'Waiting for the local client.'
  } else if (kind === 'missing') {
    title = 'Tailscale is not installed'
    body = 'Install the client on this machine, then refresh. The plugin talks to the local CLI, not the admin API.'
    actions = [
      { label: 'Download Tailscale', run: () => openUrl(DOWNLOAD_URL) }
    ]
  } else if (kind === 'daemon') {
    title = 'Tailscale is not running'
    body = 'The CLI is here, but it cannot reach tailscaled. Start the Tailscale app or service, then refresh.'
    actions = [{ label: 'Open local UI', run: () => openUrl(QUAD100_URL) }]
  } else if (kind === 'gateway') {
    title = 'Hermes is not connected'
    body = 'shell.exec runs on the Hermes gateway. Connect Desktop to a local or remote serve, then refresh.'
  } else if (kind === 'denied') {
    title = 'No permission'
    body = 'This Windows session is not the one that owns Tailscale, or the daemon refused the CLI.'
  } else if (statusKind === 'login') {
    title = 'Not logged in'
    body = 'This device is not on a tailnet yet. Log in from the Tailscale app, the local web UI, or the CLI.'
    actions = [
      authUrl ? { label: 'Log in', run: () => openUrl(authUrl) } : { label: 'Open local UI', run: () => openUrl(QUAD100_URL) },
      { label: 'Copy tailscale up', run: () => copyText('tailscale up') }
    ]
  } else if (statusKind === 'stopped') {
    title = 'Tailscale is stopped'
    body = 'The client is installed and logged in, but it is down. Start it from the app or run tailscale up.'
    actions = [
      { label: 'Open local UI', run: () => openUrl(QUAD100_URL) },
      { label: 'Copy tailscale up', run: () => copyText('tailscale up') }
    ]
  }
  return jsxs('div', {
    style: {
      maxWidth: 520,
      padding: '28px 8px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    },
    children: [
      jsx('div', { style: { fontSize: '0.9375rem', fontWeight: 600, color: text.primary }, children: title }),
      body
        ? jsx('p', {
            style: { margin: 0, fontSize: '0.8125rem', color: text.secondary, lineHeight: 1.45 },
            children: body
          })
        : null,
      actions.length
        ? jsxs('div', {
            style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 },
            children: actions.map(action =>
              jsx(SmallButton, { onClick: action.run, active: true, children: action.label }, action.label)
            )
          })
        : null
    ]
  })
}

function MetaLine({ label, children }) {
  if (!children) return null
  return jsxs('div', {
    style: { display: 'flex', gap: 12, fontSize: '0.8125rem', lineHeight: 1.45 },
    children: [
      jsx('span', { style: { color: text.tertiary, width: 96, flexShrink: 0 }, children: label }),
      jsx('span', { style: { color: text.secondary, minWidth: 0, overflowWrap: 'anywhere' }, children })
    ]
  })
}

function MachineRow({ row, open, onToggle, showOwner }) {
  const ping = useValue($ping)
  const pingState = ping[row.id]
  const send = useValue($send)
  const sending = !!(send && send.state === 'busy')
  const sendingHere = sending && send.rowId === row.id
  const status = rowStatus(row)
  return jsxs('div', {
    style: {
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: 10,
      background: 'var(--ui-bg-secondary, transparent)'
    },
    children: [
      jsxs('button', {
        type: 'button',
        onClick: onToggle,
        'aria-expanded': open,
        style: {
          display: 'grid',
          gridTemplateColumns: rowGrid(showOwner),
          gap: 12,
          alignItems: 'center',
          width: '100%',
          padding: '12px 14px',
          border: 0,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer'
        },
        children: [
          jsx(Dot, { on: row.online }),
          jsxs('span', {
            style: { minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 },
            children: [
              jsx('span', {
                style: {
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: text.primary,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                },
                children: row.label
              }),
              row.isSelf
                ? jsx('span', { style: { fontSize: '0.6875rem', color: text.accent, flexShrink: 0 }, children: 'this device' })
                : null,
              row.exitNode
                ? jsx('span', { style: { fontSize: '0.6875rem', color: text.yellow, flexShrink: 0 }, children: 'exit' })
                : null
            ]
          }),
          jsx('span', { style: { fontSize: '0.8125rem', color: text.tertiary }, children: row.os }),
          showOwner
            ? jsx('span', {
                style: {
                  fontSize: '0.8125rem',
                  color: text.secondary,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                },
                children: row.owner || '—'
              })
            : null,
          jsx('span', {
            style: {
              fontSize: '0.8125rem',
              color: text.secondary,
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontVariantNumeric: 'tabular-nums'
            },
            children: row.ipv4 || '—'
          }),
          jsx('span', {
            style: {
              fontSize: '0.8125rem',
              color: row.online ? text.green : text.tertiary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: 'right'
            },
            children: status
          })
        ]
      }),
      open
        ? jsxs('div', {
            style: {
              padding: '10px 14px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              borderTop: '1px solid var(--ui-stroke-secondary)'
            },
            children: [
              jsx(MetaLine, { label: 'MagicDNS', children: row.dns || '—' }),
              row.hostName && row.hostName !== row.label
                ? jsx(MetaLine, { label: 'Hostname', children: row.hostName })
                : null,
              jsx(MetaLine, { label: 'IPv6', children: row.ipv6 || '' }),
              showOwner ? jsx(MetaLine, { label: 'Owner', children: row.ownerFull || row.owner || '—' }) : null,
              row.tags.length
                ? jsx(MetaLine, { label: 'Tags', children: row.tags.join(', ') })
                : null,
              jsx(MetaLine, { label: 'Traffic', children: `rx ${row.rx} · tx ${row.tx}` }),
              row.keyExpiry ? jsx(MetaLine, { label: 'Key expiry', children: row.keyExpiry }) : null,
              row.expired ? jsx(MetaLine, { label: 'Key', children: 'expired' }) : null,
              row.taildrop ? jsx(MetaLine, { label: 'Taildrop', children: row.taildrop }) : null,
              row.ssh ? jsx(MetaLine, { label: 'SSH', children: 'Tailscale SSH host keys present' }) : null,
              row.exitNodeOption && !row.exitNode
                ? jsx(MetaLine, { label: 'Exit node', children: 'offered' })
                : null,
              pingState
                ? jsx(MetaLine, {
                    label: 'Ping',
                    children: pingState.text
                  })
                : null,
              sendingHere || (send && send.rowId === row.id)
                ? jsx(MetaLine, {
                    label: 'Send',
                    children: sendStatusText(send)
                  })
                : null,
              jsxs('div', {
                style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 },
                children: [
                  jsx(CopyBtn, { value: row.ipv4, label: 'Copy IP' }),
                  jsx(CopyBtn, { value: row.dns, label: 'Copy MagicDNS' }),
                  jsx(CopyBtn, { value: sshLine(row), label: 'Copy ssh' }),
                  row.isSelf
                    ? null
                    : jsx(SmallButton, {
                        disabled: pingState && pingState.state === 'busy',
                        onClick: () => pingRow(row),
                        children: pingState && pingState.state === 'busy' ? 'Pinging…' : 'Ping'
                      }),
                  row.isSelf
                    ? null
                    : jsx(SmallButton, {
                        onClick: () => askSshUser(row),
                        children: 'SSH'
                      }),
                  canReceiveFiles(row)
                    ? jsx(SmallButton, {
                        disabled: sending,
                        onClick: () => {
                          ask(
                            `Send a file to ${row.label}?`,
                            'Pick a file on this machine. Taildrop copies it over the tailnet. You will see progress while it sends.',
                            'Pick file',
                            () => sendFile(row)
                          )
                        },
                        children: sendingHere
                          ? send.percent != null
                            ? `Sending ${Math.round(send.percent)}%`
                            : 'Sending…'
                          : 'Send file'
                      })
                    : null,
                  row.exitNodeOption && !row.exitNode
                    ? jsx(SmallButton, {
                        onClick: () => {
                          const name = hostArg(row)
                          ask(
                            `Use ${row.label} as exit node?`,
                            'Internet traffic from this device will leave through that machine until you clear the exit node.',
                            'Use exit node',
                            () => setExitNode(name)
                          )
                        },
                        children: 'Use as exit'
                      })
                    : null
                ]
              })
            ]
          })
        : null
    ]
  })
}

function PluginPageContent() {
  const snap = useValue($snap)
  const showShared = useValue($showShared)
  const showOwner = useValue($showOwner)
  const [openId, setOpenId] = useState('')
  const [exitOpen, setExitOpen] = useState(false)
  const [acctOpen, setAcctOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const rows = useMemo(() => (snap.kind === 'ready' ? visibleRows(snap.status, showShared) : []), [snap, showShared])
  const status = snap.kind === 'ready' ? snap.status : null
  const serve = snap.kind === 'ready' ? snap.serve : null
  const accounts = snap.kind === 'ready' && Array.isArray(snap.accounts) ? snap.accounts : []
  const vacant = snap.kind !== 'ready' || emptyKind(status)
  const exits = exitNodeChoices(rows)
  const currentExit = rows.find(row => row.exitNode)

  useEffect(() => onPageMount(), [])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onVis = () => {
      if (document.visibilityState === 'visible') refresh()
      armPoll()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const online = onlineCount(rows)
  const total = rows.length
  const subtitle = status
    ? status.backend === 'Running'
      ? `${online} online · ${total} machine${total === 1 ? '' : 's'}${status.suffix ? ` · ${status.suffix}` : ''}`
      : status.backend
    : snap.kind === 'loading'
      ? 'Looking up the local client'
      : ''

  return jsxs('div', {
    style: {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      background: 'var(--ui-surface-background, var(--ui-bg, transparent))'
    },
    children: [
      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          padding: '10px 16px 8px',
          borderBottom: '1px solid var(--ui-stroke-secondary)'
        },
        children: [
          jsx('h1', {
            style: { fontSize: '1rem', fontWeight: 600, color: text.primary, margin: 0 },
            children: PLUGIN_NAME
          }),
          subtitle
            ? jsx('span', { style: { color: text.tertiary, fontSize: '0.75rem' }, children: subtitle })
            : null,
          jsxs('div', {
            style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' },
            children: [
              serve && !serve.empty
                ? jsx(SmallButton, {
                    active: true,
                    title: serve.url,
                    onClick: () => openUrl(serve.url),
                    children: 'Serving'
                  })
                : snap.kind === 'ready' && !vacant
                  ? jsx(SmallButton, {
                      onClick: () => {
                        tap()
                        openPublishAsk(serve && serve.proxy ? serve.proxy : '')
                      },
                      children: 'Publish'
                    })
                  : null,
              serve && !serve.empty
                ? jsx(SmallButton, {
                    onClick: () => {
                      ask(
                        'Stop serving?',
                        'This runs tailscale serve reset and drops the tailnet HTTPS endpoint on this node.',
                        'Stop serving',
                        () => resetServe()
                      )
                    },
                    children: 'Stop serve'
                  })
                : null,
              exits.length
                ? jsxs('span', {
                    style: { position: 'relative' },
                    children: [
                      jsx(SmallButton, {
                        active: !!currentExit || exitOpen,
                        onClick: () => {
                          tap()
                          setExitOpen(open => !open)
                          setAcctOpen(false)
                          setSettingsOpen(false)
                        },
                        children: currentExit ? `Exit: ${currentExit.label}` : 'Exit node'
                      }),
                      exitOpen
                        ? jsxs('div', {
                            style: {
                              position: 'absolute',
                              right: 0,
                              top: '100%',
                              zIndex: 6,
                              marginTop: 4,
                              minWidth: 180,
                              padding: 6,
                              border: '1px solid var(--ui-stroke-secondary)',
                              borderRadius: 8,
                              background: 'var(--ui-surface-background, Canvas)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 4
                            },
                            children: [
                              ...exits.map(row =>
                                jsx(
                                  SmallButton,
                                  {
                                    active: row.exitNode,
                                    onClick: () => {
                                      setExitOpen(false)
                                      const name = hostArg(row)
                                      ask(
                                        `Use ${row.label} as exit node?`,
                                        'Internet traffic from this device will leave through that machine until you clear the exit node.',
                                        'Use exit node',
                                        () => setExitNode(name)
                                      )
                                    },
                                    children: row.label
                                  },
                                  row.id
                                )
                              ),
                              currentExit
                                ? jsx(SmallButton, {
                                    onClick: () => {
                                      setExitOpen(false)
                                      ask('Clear the exit node?', 'This device will send internet traffic out its own connection again.', 'Clear', () =>
                                        setExitNode('')
                                      )
                                    },
                                    children: 'Clear'
                                  })
                                : null
                            ]
                          })
                        : null
                    ]
                  })
                : null,
              accounts.length > 1
                ? jsxs('span', {
                    style: { position: 'relative' },
                    children: [
                      jsx(SmallButton, {
                        active: acctOpen,
                        onClick: () => {
                          tap()
                          setAcctOpen(open => !open)
                          setExitOpen(false)
                          setSettingsOpen(false)
                        },
                        children: 'Account'
                      }),
                      acctOpen
                        ? jsxs('div', {
                            style: {
                              position: 'absolute',
                              right: 0,
                              top: '100%',
                              zIndex: 6,
                              marginTop: 4,
                              minWidth: 220,
                              padding: 6,
                              border: '1px solid var(--ui-stroke-secondary)',
                              borderRadius: 8,
                              background: 'var(--ui-surface-background, Canvas)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 4
                            },
                            children: accounts.map(account =>
                              jsx(
                                SmallButton,
                                {
                                  active: account.selected,
                                  onClick: () => {
                                    setAcctOpen(false)
                                    if (account.selected) return
                                    const ident = account.nickname || account.account || account.id
                                    ask(
                                      `Switch to ${ident}?`,
                                      'This changes the Tailscale account on this device.',
                                      'Switch',
                                      () => switchAccount(ident)
                                    )
                                  },
                                  children: `${account.nickname || account.account}${account.selected ? ' · current' : ''}`
                                },
                                account.id || account.account
                              )
                            )
                          })
                        : null
                    ]
                  })
                : null,
              jsxs('span', {
                style: { position: 'relative' },
                children: [
                  jsx(SmallButton, {
                    active: settingsOpen,
                    onClick: () => {
                      tap()
                      setSettingsOpen(open => !open)
                      setExitOpen(false)
                      setAcctOpen(false)
                    },
                    children: 'Settings'
                  }),
                  settingsOpen
                    ? jsxs('div', {
                        style: {
                          position: 'absolute',
                          right: 0,
                          top: '100%',
                          zIndex: 6,
                          marginTop: 4,
                          width: 260,
                          padding: 6,
                          border: '1px solid var(--ui-stroke-secondary)',
                          borderRadius: 8,
                          background: 'var(--ui-surface-background, Canvas)',
                          display: 'flex',
                          flexDirection: 'column'
                        },
                        children: [
                          jsx(SettingsToggle, {
                            on: showOwner,
                            label: 'Show owner',
                            hint: 'Owner column and the owner line on a machine card',
                            onClick: () => {
                              tap()
                              const next = !showOwner
                              $showOwner.set(next)
                              remember('showOwner', next)
                            }
                          }),
                          jsx(SettingsToggle, {
                            on: showShared,
                            label: 'Show shared',
                            hint: 'Machines shared into this tailnet',
                            onClick: () => {
                              tap()
                              const next = !showShared
                              $showShared.set(next)
                              remember('showShared', next)
                            }
                          }),
                          jsx(SmallButton, {
                            onClick: () => {
                              setSettingsOpen(false)
                              openUrl(QUAD100_URL)
                            },
                            children: 'Open local Tailscale UI'
                          })
                        ]
                      })
                    : null
                ]
              }),
              jsx(SmallButton, {
                onClick: () => {
                  tap()
                  refresh()
                },
                children: snap.kind === 'loading' ? 'Refreshing…' : 'Refresh'
              })
            ]
          })
        ]
      }),
      jsx(SshAskBar, {}),
      jsx(PublishBar, {}),
      jsx(ConfirmBar, {}),
      jsx(SendBar, {}),
      jsx(NoticeLine, {}),
      status && status.health && status.health.length
        ? jsx('div', {
            style: {
              padding: '8px 16px',
              fontSize: '0.75rem',
              color: text.yellow,
              borderBottom: '1px solid var(--ui-stroke-secondary)'
            },
            children: status.health.join(' · ')
          })
        : null,
      jsx('div', {
        style: {
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 8
        },
        children: vacant
          ? jsx(EmptyState, { snap })
          : jsxs('div', {
              style: { minWidth: showOwner ? 720 : 560, display: 'flex', flexDirection: 'column', gap: 8 },
              children: [
                jsxs('div', {
                  style: {
                    display: 'grid',
                    gridTemplateColumns: rowGrid(showOwner),
                    gap: 12,
                    padding: '0 14px 6px',
                    fontSize: '0.75rem',
                    color: text.quaternary
                  },
                  children: [
                    jsx('span', { children: '' }),
                    jsx('span', { children: 'Name' }),
                    jsx('span', { children: 'OS' }),
                    showOwner ? jsx('span', { children: 'Owner' }) : null,
                    jsx('span', { children: 'IPv4' }),
                    jsx('span', { style: { textAlign: 'right' }, children: 'Status' })
                  ]
                }),
                rows.map(row =>
                  jsx(
                    MachineRow,
                    {
                      row,
                      showOwner,
                      open: openId === row.id,
                      onToggle: () => {
                        tap()
                        setOpenId(openId === row.id ? '' : row.id)
                      }
                    },
                    row.id
                  )
                )
              ]
            })
      }),
      jsx(SshOverlay, {})
    ]
  })
}

function StatusChip() {
  const snap = useValue($snap)
  const label = barLabel(snap)
  const ok = barOk(snap)
  const button = jsxs('button', {
    type: 'button',
    onClick: () => {
      tap()
      go(ROUTE)
    },
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: '100%',
      padding: '0 8px',
      border: 0,
      background: 'transparent',
      color: ok ? text.secondary : text.tertiary,
      font: 'inherit',
      fontSize: '0.6875rem',
      cursor: 'pointer'
    },
    children: [
      jsx(Dot, { on: ok }),
      jsx('span', { children: label })
    ]
  })
  if (!Tip) return button
  return jsx(Tip, {
    label: ok ? 'Open Tailscale machines' : 'Open Tailscale',
    children: button
  })
}

function copyMyIp() {
  const snap = $snap.get()
  const self = snap && snap.status && snap.status.rows && snap.status.rows.find(row => row.isSelf)
  const ip = (self && self.ipv4) || (snap && snap.status && ipv4Of(snap.status.selfIps)) || ''
  if (!ip) {
    go(ROUTE)
    return
  }
  copyText(ip)
}


// BEGIN SIGNED DESKTOP UPDATER
// Kept inline: Desktop loads this file directly, without sibling module imports.
function createDesktopUpdater(config) {
  const model = sdk.atom({ busy: false, open: false, message: '', error: '', offer: null, backup: null });
  const lock = Symbol.for(config.repo + '.desktop-update');
  const limit = 500000;
  let storage = null, alive = false;
  const patch = value => { if (alive) model.set({ ...model.get(), ...value }); };
  const keyFor = dir => 'signed-updater:backup:' + dir;
  const bytes = text => new TextEncoder().encode(text);
  const decode = value => {
    if (typeof value !== 'string' || value.length > 16000) throw Error('Invalid signed release.');
    return Uint8Array.from(atob(value), c => c.charCodeAt(0));
  };
  async function hash(text) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(text))), b => b.toString(16).padStart(2, '0')).join('');
  }
  function parts(version) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('Invalid release version.');
    const result = version.split('.').map(Number);
    if (!result.every(Number.isSafeInteger)) throw Error('Invalid release version.');
    return result;
  }
  function newer(a, b) {
    const x = parts(a), y = parts(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  }
  const declaredVersion = text => text.match(/const VERSION\s*=\s*["']([0-9]+\.[0-9]+\.[0-9]+)["']/)?.[1];
  const declaredId = text => text.match(/const PLUGIN_ID\s*=\s*["']([^"']+)["']/)?.[1];
  async function verify(release) {
    if (release.draft || release.prerelease) throw Error('Only stable releases can be installed.');
    const block = String(release.body || '').match(/```hermes-desktop-update\s*\n([\s\S]*?)\n```/);
    if (!block) throw Error('This release has no signed update. Nothing was installed.');
    const envelope = JSON.parse(block[1]), payload = decode(envelope.payload);
    const key = await crypto.subtle.importKey('spki', decode(config.key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decode(envelope.signature), payload)) throw Error('The release signature is invalid. Nothing was installed.');
    const info = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload));
    parts(info.version);
    if (info.schema !== 2 || info.plugin !== config.id || info.repo !== config.repo || release.tag_name !== 'v' + info.version ||
        !/^[a-f0-9]{40}$/.test(info.commit) || !Array.isArray(info.files) || info.files.length !== config.files.length)
      throw Error('The signed release does not match this plugin.');
    for (const name of config.files) {
      const rows = info.files.filter(file => file.name === name);
      if (rows.length !== 1 || !/^[a-f0-9]{64}$/.test(rows[0].sha256) || !Number.isInteger(rows[0].bytes) || rows[0].bytes < 1 || rows[0].bytes > limit)
        throw Error('The signed release file list is invalid.');
    }
    return info;
  }
  async function download(url, max = limit) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error' });
      if (!response.ok) {
        const error = Error(response.status === 403 || response.status === 429 ? 'GitHub is limiting update checks. Try again later.' : `GitHub download failed (${response.status}). Try again later.`);
        error.status = response.status; throw error;
      }
      if (!response.body || Number(response.headers.get('content-length')) > max) throw Error('The download is empty or too large.');
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) { await reader.cancel(); throw Error('The download is too large.'); }
        chunks.push(value);
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    } catch (error) {
      if (error.name === 'AbortError') throw Error('The update check timed out. Try again.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function desktop() {
    const bridge = globalThis.window?.hermesDesktop;
    if (!bridge?.desktopPluginsRoot || !bridge?.readFileText || !bridge?.writeTextFile || !bridge?.renamePath)
      throw Error('Updating requires Hermes Desktop with local plugin file support.');
    return bridge;
  }
  async function read(bridge, file) {
    const result = await bridge.readFileText(file);
    if (result.truncated || typeof result.text !== 'string' || bytes(result.text).length > limit) throw Error('Could not read the complete file: ' + file);
    return result.text;
  }
  async function location(bridge) {
    const root = await bridge.desktopPluginsRoot();
    if (typeof root !== 'string' || !root.trim()) throw Error('The local Desktop plugin folder is unavailable.');
    const matches = [];
    for (const folder of config.folders) {
      const dir = root.replace(/[\\/]+$/, '') + '/' + folder;
      let source;
      try { source = await read(bridge, dir + '/plugin.js'); } catch { continue; }
      if (declaredId(source) === config.id) matches.push(dir);
    }
    if (matches.length !== 1) throw Error(matches.length ? 'Multiple copies of this plugin are installed. Keep one copy and reload Desktop.' : 'Could not locate this plugin. Install it in desktop-plugins/' + config.folders[0] + ' and reload Desktop.');
    return matches[0];
  }
  async function snapshot(bridge, dir) {
    const texts = {}, hashes = {};
    for (const name of config.files) { texts[name] = await read(bridge, dir + '/' + name); hashes[name] = await hash(texts[name]); }
    return { texts, hashes };
  }
  const sameHashes = (a, b) => config.files.every(name => a[name] === b[name]);
  function validBackup(record) {
    return record?.plugin === config.id && Array.isArray(record.files) && record.files.length === config.files.length && config.files.every(name => {
      const rows = record.files.filter(file => file.name === name);
      return rows.length === 1 && /^update-[a-f0-9-]{36}-backup-[a-z.]+$/.test(rows[0].backup) && rows[0].backup.endsWith('-backup-' + name) && /^[a-f0-9]{64}$/.test(rows[0].sha256);
    });
  }
  // Electron-local only. Stage every file; replace plugin.js last so helpers are ready at reload.
  async function replace(bridge, dir, before, next, store) {
    const token = crypto.randomUUID(), staged = {}, moved = [];
    const order = [...config.files.filter(name => name !== 'plugin.js'), 'plugin.js'];
    const backup = { plugin: config.id, version: declaredVersion(before.texts['plugin.js']) || null,
      files: order.map(name => ({ name, backup: 'update-' + token + '-backup-' + name, sha256: before.hashes[name] })) };
    for (const name of order) {
      staged[name] = 'update-' + token + '-staged-' + name;
      await bridge.writeTextFile(dir + '/' + staged[name], next[name]);
      if (await read(bridge, dir + '/' + staged[name]) !== next[name]) throw Error('The staged files did not verify. Nothing was replaced.');
    }
    if (!alive || await location(bridge) !== dir || !sameHashes((await snapshot(bridge, dir)).hashes, before.hashes))
      throw Error('The Desktop profile or plugin files changed. Check again before installing.');
    const previous = await store.get(keyFor(dir), null);
    try {
      await store.set(keyFor(dir), backup);
      for (const file of backup.files) {
        await bridge.renamePath(dir + '/' + file.name, file.backup);
        const step = { ...file, installed: false }; moved.push(step);
        await bridge.renamePath(dir + '/' + staged[file.name], file.name);
        step.installed = true;
      }
    } catch (error) {
      let failed = false;
      for (const file of moved.reverse()) {
        try {
          if (file.installed) await bridge.renamePath(dir + '/' + file.name, staged[file.name]);
          await bridge.renamePath(dir + '/' + file.backup, file.name);
        } catch { failed = true; }
      }
      if (failed) throw Error(`Replacement failed. Close Desktop and restore the update-${token}-backup-* files in ${dir} to their original names.`);
      await store.set(keyFor(dir), previous);
      throw Error('Replacement failed. The original files were restored. ' + error.message);
    }
    return backup;
  }
  function cancel() { if (!model.get().busy) patch({ offer: null, error: '', message: '' }); }
  async function run() {
    patch({ open: true, busy: false, offer: null, error: '', message: "This package uses Hermes updates. Run hermes plugins update hermes-tailscale, then rescan Desktop plugins." });
  }
  function register(ctx) {
    storage = ctx.storage; alive = true;
    ctx.onDispose?.(() => { alive = false; storage = null; });
    (async () => {
      try { const dir = await location(desktop()); const backup = await storage?.get(keyFor(dir), null); patch({ backup: validBackup(backup) ? backup : null }); }
      catch { /* Other plugin features remain available on older Desktop versions. */ }
    })();
  }
  function Panel() {
    const s = sdk.useValue(model);
    const button = (label, onClick, primary = false) => jsx('button', {
      type: 'button', disabled: s.busy, onClick,
      style: { padding: '6px 10px', minHeight: 32, borderRadius: 6, border: '1px solid var(--ui-stroke-secondary)',
        background: primary ? 'var(--ui-bg-secondary)' : 'transparent', color: 'var(--ui-text-primary)', cursor: s.busy ? 'wait' : 'pointer', font: 'inherit', opacity: s.busy ? 0.6 : 1 }, children: label
    });
    return jsxs('section', {
      'aria-label': config.name + ' updates',
      style: { flexShrink: 0, padding: '8px 16px', borderTop: '1px solid var(--ui-stroke-secondary)', color: 'var(--ui-text-secondary)', fontSize: 12 },
      children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }, children: [
          jsx('span', { style: { marginRight: 'auto' }, children: `${config.name} v${config.version}` }),
          button(s.busy ? 'Please wait…' : 'Check for updates', () => run()),
          s.backup && !s.offer && button('Restore previous version', () => run('restore'))
        ] }),
        (s.message || s.error) && jsx('p', { role: s.error ? 'alert' : 'status',
          style: { margin: '8px 0', overflowWrap: 'anywhere', color: s.error ? 'var(--ui-red)' : 'inherit' }, children: s.error || s.message }),
        s.offer && jsxs('div', { role: 'group', 'aria-label': s.offer.kind === 'restore' ? 'Confirm restore' : 'Confirm update',
          style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }, children: [
            button(s.offer.kind === 'restore' ? 'Restore now' : 'Update now', () => run(s.offer.kind === 'restore' ? 'restore-confirm' : 'install'), true),
            button(s.offer.kind === 'restore' ? 'Cancel' : 'Later', cancel)
          ] })
      ]
    });
  }
  return { register, Panel, run, cancel, model, verify, newer, replace, snapshot, location, validBackup };
}
// END SIGNED DESKTOP UPDATER

const UPDATE_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdDcg2pf4qQg4y89ZLfoIhfJqyKP+bJMA0Q0YVDK0VAbAgyVi5CaodDuUgibOqTx1zQg9xrXdzYbCvpgMjIFBCw==";
const desktopUpdater = createDesktopUpdater({
  id: PLUGIN_ID, name: "Tailscale", version: VERSION, key: UPDATE_KEY,
  repo: "Adolanium/hermes-tailscale", folders: ["hermes-tailscale"], files: ["plugin.js"]
});
function Page() {
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
    children: [
      jsx('div', { style: { flex: 1, minHeight: 0, overflow: 'hidden' }, children: jsx(PluginPageContent, {}) }),
      jsx(desktopUpdater.Panel, {})
    ]
  });
}

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  version: VERSION,
  description: 'Machines on this device\'s Tailscale tailnet. Talks to the local CLI.',
  defaultEnabled: true,
  register(ctx) {
    desktopUpdater.register(ctx);
    storage = ctx.storage || null
    os = ctx.os || null
    $showShared.set(!!stored('showShared', false))
    $showOwner.set(!!stored('showOwner', false))

    const contributions = [
      { id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(Page, {}) },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 55,
        data: { path: ROUTE, label: PLUGIN_NAME, codicon: 'globe' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.open`,
          label: 'Open Tailscale',
          keywords: ['tailscale', 'tailnet', 'vpn', 'machines', 'peers', 'wireguard'],
          run: () => go(ROUTE)
        }
      },
      {
        id: 'copy-ip',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.copyIp`,
          label: 'Copy my Tailscale IP',
          keywords: ['tailscale', 'ip', 'address', '100'],
          run: () => copyMyIp()
        }
      },
      {
        id: 'publish',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.publish`,
          label: 'Publish Hermes on Tailscale',
          keywords: ['tailscale', 'serve', 'publish', 'share', 'https'],
          run: () => {
            go(ROUTE)
            const snap = $snap.get()
            const serve = snap && snap.kind === 'ready' && snap.serve ? snap.serve : null
            openPublishAsk(serve && serve.proxy ? serve.proxy : '')
          }
        }
      }
    ]
    if (STATUSBAR_AREAS && STATUSBAR_AREAS.right) {
      contributions.push({
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 130,
        render: () => jsx(StatusChip, {})
      })
    }
    ctx.registerMany(contributions)
    refresh()
    armPoll()
    if (typeof ctx.onDispose === 'function') {
      ctx.onDispose(() => {
        if (pollTimer) clearTimeout(pollTimer)
        pollTimer = null
        removeCacheFile()
        storage = null
        os = null
        cachedBin = null
        cachedRoot = ''
        cachedOutPath = null
        closeSsh()
        $sshAsk.set(null)
        $publishAsk.set(null)
        stopSendPty()
        $send.set(null)
        if (noticeTimer) clearTimeout(noticeTimer)
        if (sendClearTimer) clearTimeout(sendClearTimer)
        $dialog.set(null)
      })
    }
  }
}

export const __test = {
  platformKind,
  quoteShell,
  joinPath,
  xtermSources,
  integrityMatches,
  wrapXtermModule,
  bytesToBase64,
  binaryCandidates,
  binCommand,
  statusRedirectCommand,
  removeCacheCommand,
  classifyCliError,
  dnsLabel,
  ownerLabel,
  osLabel,
  pathLabel,
  formatLastSeen,
  formatBytes,
  ipv4Of,
  taildropLabel,
  sshLine,
  onlineCount,
  parseStatus,
  visibleRows,
  emptyKind,
  barLabel,
  barOk,
  isSafeHost,
  isSafeUser,
  parsePort,
  serveArgs,
  portProbeCommand,
  classifyPortProbe,
  sshSpec,
  parsePingOutput,
  pingSummary,
  parseServeStatus,
  parseSwitchList,
  canReceiveFiles,
  exitNodeChoices,
  rowStatus,
  rowGrid,
  formatKeyExpiry,
  shellLine,
  ptyChunk,
  stripPty,
  applyPtyText,
  pathBase,
  isSafeFilePath,
  quoteCmdArg,
  fileCpCommand,
  parseFileCpProgress,
  sendStatusText
}
