// The remote POSIX status read hands its commands to the gateway's
// shell.exec, which rejects any command that matches one of Hermes' dangerous
// or hardline command patterns before it runs (#9). These tests build every
// command that read sends and check it against those patterns.
//
// HARDLINE_PATTERNS and DANGEROUS_PATTERNS below are copied from
// tools/approval_detection.py in NousResearch/hermes-agent (main @ 0e427d7,
// with the module-level helpers expanded). They are Python regexes, compiled
// with re.IGNORECASE | re.DOTALL; toJsRegExp() turns the few Python-only bits
// (possessive quantifiers, scoped (?-i:...) groups, \U escapes) into JS.

import assert from 'node:assert/strict'
import test from 'node:test'
import { loadHelpers } from './helpers.mjs'

const h = loadHelpers()

const HARDLINE_PATTERNS = [
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*rm\\s+(-[^\\s]*\\s+)*(?:[\"\\'](?:/(?:(?:\\.\\.?)?/)*(?:\\.\\.?)?\\**|/ \\*)[\"\\']|(?:/(?:(?:\\.\\.?)?/)*(?:\\.\\.?)?\\**|/ \\*)(?:\\s|$|[)`;|&]))", "recursive delete of root filesystem"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*rm\\s+(-[^\\s]*\\s+)*(?:[\"\\'](?:/home|/home/\\*|/root|/root/\\*|/etc|/etc/\\*|/usr|/usr/\\*|/var|/var/\\*|/bin|/bin/\\*|/sbin|/sbin/\\*|/boot|/boot/\\*|/lib|/lib/\\*)[\"\\']|(?:/home|/home/\\*|/root|/root/\\*|/etc|/etc/\\*|/usr|/usr/\\*|/var|/var/\\*|/bin|/bin/\\*|/sbin|/sbin/\\*|/boot|/boot/\\*|/lib|/lib/\\*)(?:\\s|$|[)`;|&]))", "recursive delete of system directory"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*rm\\s+(-[^\\s]*\\s+)*(?:[\"\\'](?:(?:~|\\$\\{?HOME\\}?)(?:/?|/\\*)?)[\"\\']|(?:(?:~|\\$\\{?HOME\\}?)(?:/?|/\\*)?)(?:\\s|$|[)`;|&]))", "recursive delete of home directory"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*mkfs(\\.[a-z0-9]+)?\\b", "format filesystem (mkfs)"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*dd\\b[^\\n]*\\bof=/dev/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*", "dd to raw block device"],
  [">\\s*/dev/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\\b", "redirect to raw block device"],
  [":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:", "fork bomb"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*kill\\s+(-[^\\s]+\\s+)*-1\\b", "kill all processes"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*(shutdown|reboot|halt|poweroff)\\b", "system shutdown/reboot"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*init\\s+[06]\\b", "init 0/6 (shutdown/reboot)"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*systemctl\\s+(poweroff|reboot|halt|kexec)\\b", "systemctl poweroff/reboot"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*telinit\\s+[06]\\b", "telinit 0/6 (shutdown/reboot)"],
]

const DANGEROUS_PATTERNS = [
  ["\\brm\\s+(-[^\\s]*\\s+)*/", "delete in root path"],
  ["\\brm\\s+-[^\\s]*r", "recursive delete"],
  ["\\brm\\s+--recursive\\b", "recursive delete (long flag)"],
  ["\\brm\\s+(?!--(?:\\s|$))(?:(?!\\s--(?:\\s|$))[^\\n\"\\';|&])*\\s(?:-[a-z]*r[a-z]*\\b|--recursive\\b)", "recursive delete (flags after operands)"],
  ["\\bcmd(?:\\.exe)?\\s+/(?:c|k)\\s+.*\\b(?:del|erase|rd|rmdir)\\b", "Windows cmd destructive delete"],
  ["\\b(?:powershell|pwsh)(?:\\.exe)?\\b(?:\\s+-\\S+)*\\s+(?:-(?:command|c)\\s+)?[\"\\']?(?:remove-item|rmdir|erase|del|rd|ri|rm)\\b", "Windows PowerShell destructive delete"],
  ["\\b(?:powershell|pwsh)(?:\\.exe)?\\b.*\\s-(?:encodedcommand|enc|e)\\b", "PowerShell encoded command execution"],
  ["\\bremove-item\\b[^\\n;|&]*\\s-(?:recurse|force)\\b", "PowerShell destructive delete (Remove-Item)"],
  ["\\b(?:del|erase|rd|rmdir)\\s+(?:/[a-z]\\s+)*/[sq]\\b", "Windows destructive delete (recursive/quiet switch)"],
  ["\\b(?:iwr|invoke-webrequest|invoke-restmethod|irm|curl|wget)\\b[^\\n]*\\|\\s*(?:iex|invoke-expression)\\b", "pipe remote content to PowerShell (iwr | iex)"],
  ["\\b(?:iex|invoke-expression)\\s*\\(\\s*(?:iwr|invoke-webrequest|invoke-restmethod|irm)\\b", "execute remote content via Invoke-Expression"],
  ["\\btaskkill\\b[^\\n]*\\s/f\\b", "force kill processes (taskkill /F)"],
  ["\\bstop-process\\b[^\\n]*\\s-force\\b", "force kill processes (Stop-Process -Force)"],
  ["\\bformat-volume\\b", "format filesystem (Format-Volume)"],
  ["\\bclear-disk\\b", "wipe disk (Clear-Disk)"],
  ["\\bdiskpart\\b", "disk partitioning (diskpart)"],
  ["\\bformat(?:\\.com)?\\s+[a-z]:", "format drive (format.com)"],
  ["\\bcipher\\s+/w\\b", "wipe free space (cipher /w)"],
  ["\\bicacls\\b[^\\n]*\\s/grant\\b[^\\n]*\\b(?:everyone|todos|jeder|tout\\s+le\\s+monde|\\*s-1-1-0)\\b", "grant Everyone access (icacls)"],
  ["\\bicacls\\b[^\\n]*\\s/reset\\b", "reset ACLs recursively (icacls /reset)"],
  ["\\bvssadmin\\b[^\\n]*\\bdelete\\s+shadows\\b", "delete volume shadow copies (vssadmin)"],
  ["\\bwbadmin\\b[^\\n]*\\bdelete\\b", "delete backups (wbadmin)"],
  ["\\bbcdedit\\b[^\\n]*\\s/set\\b", "modify boot configuration (bcdedit /set)"],
  ["\\breg(?:\\.exe)?\\s+delete\\b", "registry delete (reg delete)"],
  ["\\bremove-itemproperty\\b[^\\n]*\\s-force\\b", "registry value delete (Remove-ItemProperty -Force)"],
  ["\\bstop-service\\b[^\\n]*\\s-force\\b", "force stop service (Stop-Service -Force)"],
  ["\\bsc(?:\\.exe)?\\s+(?:stop|delete)\\b", "stop/delete service (sc)"],
  ["\\busers[\\\\/][^\\\\/\\s]+[\\\\/]\\.ssh\\b", "access to SSH keys (Windows path)"],
  ["\\bappdata[\\\\/](?:local|roaming)[\\\\/]hermes[^\\n]*\\.env\\b", "access to Hermes secrets (Windows path)"],
  ["\\bchmod\\s+(-[^\\s]*\\s+)*(777|666|o\\+[rwx]*w|a\\+[rwx]*w)\\b", "world/other-writable permissions"],
  ["\\bchmod\\s+--recursive\\b.*(777|666|o\\+[rwx]*w|a\\+[rwx]*w)", "recursive world/other-writable (long flag)"],
  ["\\bchown\\s+(-[^\\s]*)?R\\s+root", "recursive chown to root"],
  ["\\bchown\\s+--recur[a-z]*\\b.*root", "recursive chown to root (long flag)"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*mkfs\\b", "format filesystem"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*dd\\s+.*if=", "disk copy"],
  [">\\s*/dev/sd", "write to block device"],
  ["\\bDROP\\s+(TABLE|DATABASE)\\b", "SQL DROP"],
  ["\\bDELETE\\s+FROM\\b(?![^\\n]*\\bWHERE\\b)", "SQL DELETE without WHERE"],
  ["\\bTRUNCATE\\s+(TABLE)?\\s*\\w", "SQL TRUNCATE"],
  [">\\s*(?:/etc/|/private/(?:etc|var|tmp|home)/)", "overwrite system config"],
  ["\\bsystemctl\\s+(-[^\\s]+\\s+)*(stop|restart|disable|mask)\\b", "stop/restart system service"],
  ["\\bkill\\s+-9\\s+-1\\b", "kill all processes"],
  ["\\bpkill\\s+-9\\b", "force kill processes"],
  ["\\bkillall\\s+(-[^\\s]*\\s+)*-(9|KILL|SIGKILL)\\b", "force kill processes (killall -KILL)"],
  ["\\bkillall\\s+(-[^\\s]*\\s+)*-s\\s+(KILL|SIGKILL|9)\\b", "force kill processes (killall -s KILL)"],
  ["\\bkillall\\s+(-[^\\s]*\\s+)*-r\\b", "kill processes by regex (killall -r)"],
  [":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:", "fork bomb"],
  ["\\b(curl|wget)\\b.*\\|\\s*(?:[/\\w]*/)?(?:bash|sh|zsh|ksh|dash)(?:\\s|$|-c)", "pipe remote content to shell"],
  ["\\b(?:bash|sh|zsh|ksh|dash)\\s+<\\s*<?\\s*\\(\\s*(curl|wget)\\b", "execute remote script via process substitution"],
  ["(?:\\beval\\b|\\bsource\\b|\\.)\\s*(?:\\$\\(\\s*|`\\s*)(?:curl|wget)\\b", "execute remote content via command substitution"],
  ["(?<![\\d.])(?:169\\.254\\.169\\.254|100\\.100\\.100\\.200)(?![\\d.])|(?<![\\w.-])metadata\\.google\\.internal(?![\\w.-])|fd00:ec2::254", "cloud metadata endpoint access (instance credentials)"],
  ["\\b(base64|base32|base16)\\s+(?:-[dD]|--decode)\\b.*\\|\\s*\\b(?:bash|sh|zsh|ksh|dash)\\b", "pipe decoded content to shell (possible command obfuscation)"],
  ["\\bxxd\\s+-r\\b.*\\|\\s*\\b(?:bash|sh|zsh|ksh|dash)\\b", "pipe xxd-decoded content to shell (possible command obfuscation)"],
  ["\\becho\\b[^|]*\\|\\s*\\btr\\b[^|]*\\|\\s*\\b(?:bash|sh|zsh|ksh|dash)\\b", "pipe tr-transformed output to shell (possible command obfuscation)"],
  ["\\bopenssl\\b.*\\b(?:base64|enc)\\b[^|]*\\s+-[dD]\\b[^|]*\\|\\s*\\b(?:bash|sh|zsh|ksh|dash)\\b", "pipe openssl-decoded content to shell (possible command obfuscation)"],
  ["(?<!\\S)(?:(?-i:-[a-zA-Z]*[dFT])|--data(?:-binary|-raw|-urlencode|-ascii)?|--form(?:-string)?|--upload-file|--json|--post-(?:data|file)|--body-(?:data|file))(?:[\\s=]+|(?=[@\"\\'$]))(?:\"[^\"]*(?:\\$\\{?\\w*(?:key|token|secret|passwd|password|credential)\\w*\\}?|(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)\\.env\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b|(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*\\.env(?:\\.[^/\\s\"\\'`]+)*)(?![\\w-])|(?:~|\\$home|\\$\\{home\\})/\\.(?:aws/credentials|git-credentials|config/gh/hosts\\.yml|docker/config\\.json|kube/config)\\b|/etc/(?:shadow|passwd)\\b|\\bid_(?:rsa|ed25519|ecdsa|dsa)\\b))|\\'[^\\']*(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)\\.env\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b|(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*\\.env(?:\\.[^/\\s\"\\'`]+)*)(?![\\w-])|(?:~|\\$home|\\$\\{home\\})/\\.(?:aws/credentials|git-credentials|config/gh/hosts\\.yml|docker/config\\.json|kube/config)\\b|/etc/(?:shadow|passwd)\\b|\\bid_(?:rsa|ed25519|ecdsa|dsa)\\b)|\\$\\([^)]*(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)\\.env\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b|(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*\\.env(?:\\.[^/\\s\"\\'`]+)*)(?![\\w-])|(?:~|\\$home|\\$\\{home\\})/\\.(?:aws/credentials|git-credentials|config/gh/hosts\\.yml|docker/config\\.json|kube/config)\\b|/etc/(?:shadow|passwd)\\b|\\bid_(?:rsa|ed25519|ecdsa|dsa)\\b)|\\S*?(?:\\$\\{?\\w*(?:key|token|secret|passwd|password|credential)\\w*\\}?|(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)\\.env\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b|(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*\\.env(?:\\.[^/\\s\"\\'`]+)*)(?![\\w-])|(?:~|\\$home|\\$\\{home\\})/\\.(?:aws/credentials|git-credentials|config/gh/hosts\\.yml|docker/config\\.json|kube/config)\\b|/etc/(?:shadow|passwd)\\b|\\bid_(?:rsa|ed25519|ecdsa|dsa)\\b)))", "upload a secret or credential file via curl/wget (possible exfiltration)"],
  ["(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)\\.env\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b|(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*\\.env(?:\\.[^/\\s\"\\'`]+)*)(?![\\w-])|(?:~|\\$home|\\$\\{home\\})/\\.(?:aws/credentials|git-credentials|config/gh/hosts\\.yml|docker/config\\.json|kube/config)\\b|/etc/(?:shadow|passwd)\\b|\\bid_(?:rsa|ed25519|ecdsa|dsa)\\b)[^|;&\\n]*\\|[^;&|\\n]*\\b(?:curl|wget)\\b[^;&|\\n]*(?<!\\S)(?:(?-i:-[a-zA-Z]*[dFT])|--data(?:-binary|-raw|-urlencode|-ascii)?|--form(?:-string)?|--upload-file|--json|--post-(?:data|file)|--body-(?:data|file))", "pipe a credential file into a curl/wget upload (possible exfiltration)"],
  ["[\\u200b\\u200c\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff\\u180e\\U000e0000-\\U000e007f]|(?<![\\U0001F000-\\U0001FAFF\\u2600-\\u27BF\\ufe0f])\\u200d|\\u200d(?![\\U0001F000-\\U0001FAFF\\u2600-\\u27BF])", "invisible or bidirectional Unicode control character (possible obfuscation)"],
  ["\\btee\\b.*[\"\\']?(?:(?:/etc/|/private/(?:etc|var|tmp|home)/)|/dev/sd|(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)\\.env\\b|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)config\\.yaml\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b)", "overwrite system file via tee"],
  [">>?\\s*[\"\\']?(?:(?:/etc/|/private/(?:etc|var|tmp|home)/)|/dev/sd|(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)\\.env\\b|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)config\\.yaml\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b)", "overwrite system file via redirection"],
  ["\\btee\\b.*[\"\\']?(?:(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*\\.env(?:\\.[^/\\s\"\\'`]+)*)|(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*config\\.yaml))[\"\\']?(?=[\\s;&|<>\"\\']|$)", "overwrite project env/config via tee"],
  [">>?\\s*[\"\\']?(?:(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*\\.env(?:\\.[^/\\s\"\\'`]+)*)|(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*config\\.yaml))[\"\\']?(?=[\\s;&|<>\"\\']|$)", "overwrite project env/config via redirection"],
  ["\\bxargs\\s+.*\\brm\\b", "xargs with rm"],
  ["\\bfind\\b.*-exec(?:dir)?\\s+(/\\S*/)?rm\\b", "find -exec/-execdir rm"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*find\\s[^;|&\\n]*(?<!\\S)-(?:\\{[^}\\s]*(?:delete|exec(?:dir)?)[^}\\s]*\\}|(?:del(?:ete?)?|exec(?:dir)?)[*?\\[])", "find dynamic shell word may expand to destructive flag"],
  ["\\bfind\\b.*-delete\\b", "find -delete"],
  ["\\b(?:rg|sort|ag|man)\\b[^;|&\\n]*(?<!\\S)--(?:pre|hostname-bin|compress-program|pager|html)(?:\\{|[*?\\[])", "dynamic shell word may expand to arbitrary program execution flag"],
  ["\\bhermes\\s+(?:-\\S++(?:\\s++(?!-\\S)\\S++)?\\s++)*gateway\\s+(stop|restart)\\b", "stop/restart hermes gateway (kills running agents)"],
  ["\\bhermes\\s+update\\b", "hermes update (restarts gateway, kills running agents)"],
  ["\\bdocker\\s+(?:-\\S++(?:\\s(?!-\\S)\\S++)?\\s++)*(?:-h|--host)[=\\s]+\\S+", "docker with remote daemon redirect (-H/--host)"],
  ["\\bdocker\\s+(?:-\\S++(?:\\s(?!-\\S)\\S++)?\\s++)*(?:-c|--context)[=\\s]+\\S+", "docker with daemon redirect (--context: alternate daemon)"],
  ["\\bdocker\\s+context\\s+use\\b", "docker context use (switches default daemon for future commands)"],
  ["\\bpodman\\s+(?:-\\S++(?:\\s(?!-\\S)\\S++)?\\s++)*(?:--url|--connection|--identity)[=\\s]+\\S+", "podman with remote daemon redirect (--url/--connection/--identity)"],
  ["\\bpodman\\s+(?:-\\S++(?:\\s(?!-\\S)\\S++)?\\s++)*(?:-r\\b|--remote\\b)", "podman remote mode (-r/--remote: remote daemon)"],
  ["\\b(?:docker_host|docker_context|container_host|container_connection)=\\S+", "docker/podman daemon redirect via environment (DOCKER_HOST/CONTAINER_HOST)"],
  ["\\bdocker(?:-compose|\\s+compose)\\s+(?:-\\S++(?:\\s(?!-\\S)\\S++)?\\s++)*(restart|stop|kill|down)\\b", "docker compose restart/stop/kill/down (container lifecycle)"],
  ["\\bdocker\\s+(?:-\\S++(?:\\s(?!-\\S)\\S++)?\\s++)*(restart|stop|kill)\\b", "docker restart/stop/kill (container lifecycle)"],
  ["gateway\\s+run\\b.*(&\\s*$|&\\s*;|\\bdisown\\b|\\bsetsid\\b)", "start gateway outside systemd (use 'systemctl --user restart hermes-gateway')"],
  ["\\bnohup\\b.*gateway\\s+run\\b", "start gateway outside systemd (use 'systemctl --user restart hermes-gateway')"],
  ["\\b(pkill|killall)\\b.*\\b(hermes|gateway|cli\\.py)\\b", "kill hermes/gateway process (self-termination)"],
  ["\\bkill\\b.*\\$\\(\\s*(pgrep|pidof)\\b", "kill process via pgrep/pidof expansion (self-termination)"],
  ["\\bkill\\b.*`\\s*(pgrep|pidof)\\b", "kill process via backtick pgrep/pidof expansion (self-termination)"],
  ["\\A(?=[\\s\\S]*\\blaunchctl\\s+(?:stop|kickstart|bootout|unload|kill|disable|remove)\\b)(?=[\\s\\S]*\\b(?:hermes|ai\\.hermes)\\b)", "stop/restart hermes launchd service (kills running agents)"],
  ["\\b(cp|mv|install)\\b.*\\s(?:/etc/|/private/(?:etc|var|tmp|home)/)", "copy/move file into system config path"],
  ["\\b(cp|mv|install)\\b.*\\s[\"\\']?(?:(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*\\.env(?:\\.[^/\\s\"\\'`]+)*)|(?:(?:/|\\.{1,2}/)?(?:[^\\s/\"\\'`]+/)*config\\.yaml))[\"\\']?(?:\\s*(?:&&|\\|\\||;).*)?$", "overwrite project env/config file"],
  ["\\b(cp|mv|install)\\b.*\\s[\"\\']?(?:(?:/etc/|/private/(?:etc|var|tmp|home)/)|/dev/sd|(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)\\.env\\b|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)config\\.yaml\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b)[^\\s\"\\']*[\"\\']?(?:\\s*(?:&&|\\|\\||;).*)?$", "copy/move file into sensitive credential/SSH/shell-rc path"],
  ["\\bsed\\s+-[^\\s]*i.*(?:(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b))[^\\s\"\\']*", "in-place edit of sensitive credential/SSH/shell-rc path"],
  ["\\bsed\\s+--in-place\\b.*(?:(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b))[^\\s\"\\']*", "in-place edit of sensitive credential/SSH/shell-rc path (long flag)"],
  ["\\b(?:perl|ruby)\\b.*(?:^|\\s)-[^\\s]*i\\b.*(?:(?:(?:~|\\$home|\\$\\{home\\})/\\.ssh(?:/|$)|(?:~|\\$home|\\$\\{home\\})/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\\b|(?:~|\\$home|\\$\\{home\\})/\\.(?:netrc|pgpass|npmrc|pypirc)\\b))[^\\s\"\\']*", "in-place edit of sensitive credential/SSH/shell-rc path (perl/ruby)"],
  ["\\bsed\\s+-[^\\s]*i.*\\s(?:/etc/|/private/(?:etc|var|tmp|home)/)", "in-place edit of system config"],
  ["\\bsed\\s+--in-place\\b.*\\s(?:/etc/|/private/(?:etc|var|tmp|home)/)", "in-place edit of system config (long flag)"],
  ["\\bsed\\s+-[^\\s]*i.*(?:(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)config\\.yaml\\b|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)\\.env\\b)", "in-place edit of Hermes config/env"],
  ["\\bsed\\s+--in-place\\b.*(?:(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)config\\.yaml\\b|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)\\.env\\b)", "in-place edit of Hermes config/env (long flag)"],
  ["\\b(?:perl|ruby)\\b.*(?:^|\\s)-[^\\s]*i\\b.*(?:(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)config\\.yaml\\b|(?:~\\/\\.hermes/|(?:\\$home|\\$\\{home\\})/\\.hermes/|(?:\\$hermes_home|\\$\\{hermes_home\\})/)\\.env\\b)", "in-place edit of Hermes config/env (perl/ruby)"],
  ["\\b(?:bash|sh|zsh|ksh|dash)\\s+<<", "shell execution via heredoc"],
  ["\\bgit\\s+reset\\s+--h(?:a(?:r(?:d)?)?)?\\b", "git reset --hard (destroys uncommitted changes)"],
  ["\\bgit\\s+push\\b.*--forc[a-z]*\\b", "git force push (rewrites remote history)"],
  ["\\bgit\\s+push\\b.*-f\\b", "git force push short flag (rewrites remote history)"],
  ["\\bgit\\s+clean\\s+-[^\\s]*f", "git clean with force (deletes untracked files)"],
  ["\\bgit\\s+branch\\s+(?-i:-D)\\b", "git branch force delete"],
  ["\\bgit\\s+branch\\b[^;|&\\n]*?(?:-d\\b|--delete\\b)[^;|&\\n]*?(?:-f\\b|--force\\b)", "git branch force delete (long flags)"],
  ["\\bgit\\s+branch\\b[^;|&\\n]*?(?:-f\\b|--force\\b)[^;|&\\n]*?(?:-d\\b|--delete\\b)", "git branch force delete (long flags, force-first)"],
  ["\\bchmod\\s+\\+x\\b.*[;&|]+\\s*\\./", "chmod +x followed by immediate execution"],
  ["\\bsudo\\b[^;|&\\n]*?\\s+(?:-s\\b|--st[a-z]*\\b|-a\\b|--a[a-z]*\\b)", "sudo with privilege flag (stdin/askpass/shell/list)"],
  ["\\bsudo\\b[^;|&\\n]*?\\s+-[a-z]*[sa][a-z]*\\b", "sudo with combined-flag privilege escalation"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*npm\\s+(?:-[^\\s]+(?:\\s+[^-\\s][^\\s]*)?\\s+)*(?:uninstall|unlink|remove|rm|r|un)\\b", "package manager uninstall"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*pnpm\\s+(?:-[^\\s]+(?:\\s+[^-\\s][^\\s]*)?\\s+)*(?:uninstall|remove|rm|un)\\b", "package manager uninstall"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*yarn\\s+(?:-[^\\s]+(?:\\s+[^-\\s][^\\s]*)?\\s+)*(?:global\\s+)?(?:uninstall|remove)\\b", "package manager uninstall"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*pip(?:3)?\\s+(?:-[^\\s]+(?:\\s+[^-\\s][^\\s]*)?\\s+)*uninstall\\b", "package manager uninstall"],
  ["(?:^|[\\n`]|\\$\\()\\s*(?:sudo\\s+(?:-[^\\s]+\\s+)*)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*brew\\s+(?:-[^\\s]+(?:\\s+[^-\\s][^\\s]*)?\\s+)*(?:uninstall|remove|rm)\\b", "package manager uninstall"],
]

function toJsRegExp(source) {
  const s = source
    .replace(/\\U([0-9a-fA-F]{8})/g, (_, hex) => `\\u{${hex.replace(/^0+/, '')}}`)
    .replace(/\(\?-i:/g, '(?:')
    .replace(/(?<!\\)([+*?}])\+/g, '$1')
  const flags = /\\u\{/.test(s) ? ['isu'] : ['is', 'isu']
  for (const f of flags) {
    try {
      return new RegExp(s, f)
    } catch {
      /* try the next flag set */
    }
  }
  return null
}

const RULES = [...HARDLINE_PATTERNS, ...DANGEROUS_PATTERNS].map(([source, description]) => ({
  description,
  re: toJsRegExp(source)
}))

function blockedBy(command) {
  // Hermes lowercases most of the command before matching; check both forms.
  const forms = [command, command.toLowerCase()]
  return RULES.filter(rule => forms.some(form => rule.re.test(form))).map(rule => rule.description)
}

function remoteReadCommands() {
  const bins = [
    { path: 'tailscale' },
    { path: '/usr/bin/tailscale' },
    { path: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' },
    { path: '/opt/my tools/tailscale' }
  ]
  const path = '/tmp/hermes-tailscale-status.Ab12Cd'
  const commands = [
    h.remoteStatusSweepCommand(),
    h.remoteStatusChunkCommand(path, 1, 2700),
    h.remoteStatusChunkCommand(path, 2701, 100),
    h.remoteStatusRemoveCommand(path),
    ...h.parseRemoteStatusSweep(`${path}\n/var/tmp/hermes-tailscale-status.zz9\n`).map(p => h.remoteStatusRemoveCommand(p))
  ]
  for (const bin of bins) {
    for (const kind of ['linux', 'darwin']) {
      commands.push(h.remoteStatusCaptureCommand(bin, kind), h.binCommand(bin, 'status --json', kind))
    }
  }
  return commands
}

test('every Hermes pattern compiles as a JS regex', () => {
  const broken = RULES.filter(rule => !rule.re).map(rule => rule.description)
  assert.deepEqual(broken, [])
  assert.ok(RULES.length > 100)
})

test('the remote status read sends nothing Hermes would block', () => {
  const commands = remoteReadCommands()
  assert.ok(commands.length > 10)
  for (const command of commands) {
    assert.ok(command, 'command was built')
    assert.deepEqual(blockedBy(command), [], command)
  }
})

test('the old find -exec rm sweep is caught', () => {
  const old = `find "\${TMPDIR:-/tmp}" -maxdepth 1 -name 'hermes-tailscale-status.*' -user "$(id -u)" -mmin +2 -exec rm -f {} + 2>/dev/null;`
  assert.ok(blockedBy(old).includes('find -exec/-execdir rm'))
  const oldCapture = `${old} ${h.remoteStatusCaptureCommand({ path: 'tailscale' }, 'linux')}`
  assert.ok(blockedBy(oldCapture).includes('find -exec/-execdir rm'))
  assert.ok(blockedBy(h.remoteStatusSweepCommand().replace('-print', '-delete')).includes('find -delete'))
})
