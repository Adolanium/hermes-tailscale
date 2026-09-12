<div align="center">

  <a href="https://github.com/NousResearch/hermes-agent">
    <img src="https://github.com/user-attachments/assets/ac2f5702-c842-4b2e-9340-737481fa0ece" width="96" height="96" alt="Nous Research Hermes mark" />
  </a>

  # Hermes Tailscale

  **Your tailnet is already running. It just wasn't in the sidebar.**

  Hermes Tailscale puts the machines on this device's tailnet on a page in Hermes Desktop.
  See who is online, copy an address, SSH in, send a file, or publish this Hermes onto the mesh.
  It talks to the Tailscale CLI you already installed. No admin API token. No cloud round trip.

  <sub>POWERED BY <a href="https://github.com/NousResearch/hermes-agent">HERMES AGENT</a> &nbsp;·&nbsp; COMMUNITY PLUGIN &nbsp;·&nbsp; VERSION 0.0.5</sub>

  <br /><br />

  [See the roster](#the-tailnet-in-the-sidebar) &nbsp;·&nbsp; [Install it](#make-it-yours) &nbsp;·&nbsp; [How it talks to Tailscale](#privacy-you-can-explain-in-one-breath)

  <img width="1453" height="884" alt="demo" src="https://github.com/user-attachments/assets/28516903-8f3a-42a1-9a9d-823981272073" />

</div>

## Powered by Hermes

Hermes Tailscale is a community-built roster for [Hermes Desktop](https://github.com/NousResearch/hermes-agent). It uses the Hermes plugin SDK, `shell.exec`, and the in-app PTY when Desktop exposes `hermesDesktop.terminal`. Same profile-aware environment you already use.

The page is whatever Tailscale the **Hermes gateway** can exec. On a normal desktop that's this laptop. A remote `hermes serve` shows that machine's tailnet instead.

## The tailnet in the sidebar

Most Tailscale UIs live in a tray icon or a browser tab you forget to open. This one sits next to Sessions.

| | |
| --- | --- |
| **See**<br />Name, OS, IPv4, and one status line. Online count in the status bar. Empty states if Tailscale is missing, stopped, or waiting for login. | **Copy**<br />IP, MagicDNS, or an `ssh` line. Palette commands for the page and your own address. |
| **Reach**<br />Ping a peer. Open SSH in an xterm overlay. Type the username each time. It is not saved. | **Move**<br />Send a file with Taildrop and watch the bar fill. Pick an exit node. Switch accounts when more than one is logged in. Publish this Hermes with `tailscale serve`. You pick the local port; the plugin checks something is listening before it runs. |

Mutating actions ask first. Funnel stays off.

## Small decisions, already made

- Owner is hidden until you turn it on in Settings.
- Shared machines stay out of the list unless you ask for them.
- The page polls every 8 seconds while you are looking at it, and every 60 seconds otherwise.
- SSH uses the Desktop PTY and xterm. If this build has no terminal, the ssh line is copied instead.
- Taildrop send runs in a PTY so a large file is not killed by the 30 second `shell.exec` budget. Progress, speed, and ETA show while it copies.
- Windows OpenSSH often cannot resolve a MagicDNS short name, so plain ssh falls back to the Tailscale IPv4.

## Built for a real tailnet, not a mock list

Hermes Tailscale is one uncompiled `plugin.js` with its own **Tailscale** row in the sidebar. It works on stock Hermes Desktop. There is no fork, upstream patch, separate backend, build step, or package manager.

It does not call the Tailscale cloud API. It does not dial LocalAPI from the renderer (named pipe / unix socket). The CLI is the door, the same way Resetwatch shells out.

## Make it yours

### Install

Copy [`plugin.js`](plugin.js) to Hermes' desktop plugin directory:

```text
~/.hermes/desktop-plugins/hermes-tailscale/plugin.js
```

On Windows:

```text
%USERPROFILE%\.hermes\desktop-plugins\hermes-tailscale\plugin.js
```

If you use a named profile, the root is `$HERMES_HOME/profiles/<name>/desktop-plugins/`. The folder name must be `hermes-tailscale`.

Open Hermes and choose **Tailscale** in the sidebar. If it is missing, use **Cmd+K** (**Ctrl+K** on Windows) → **Reload desktop plugins**. Restart Hermes after replacing the file if an already-open page keeps the old plugin loaded.

You need the Tailscale client installed and logged in on the same machine that runs the Hermes gateway.

- Windows: `C:\Program Files\Tailscale\tailscale.exe`, or `tailscale` on PATH.
- macOS: `tailscale` on PATH, `/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale`, or the App Store binary at `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (the plugin sets `TAILSCALE_BE_CLI=1` so that launch does not open the GUI).
- Linux: `tailscale` on PATH, `/usr/bin/tailscale`, `/usr/local/bin/tailscale`, or `/snap/bin/tailscale`.

The same `plugin.js` file is both the source and the installable artifact.

### Optional: keep xterm offline

The SSH overlay needs xterm. By default the plugin downloads `@xterm/xterm@5.5.0/lib/xterm.js` from jsDelivr (or unpkg) and only runs it if the SHA-384 matches the pin in `plugin.js`. To skip the network, put that same file next to the plugin:

```text
~/.hermes/desktop-plugins/hermes-tailscale/xterm.js
```

Get it from the npm tarball or either CDN. The local copy is checked against the same hash, so a wrong or edited file is refused and the plugin moves on to the CDN.

### Test

The helpers that build shell commands, quote paths, and parse CLI output are covered by `node:test`. No dependencies, no install step:

```text
node --test
```

CI runs the same command on Ubuntu and Windows for every push and pull request.

## Privacy you can explain in one breath

```text
Your Hermes Desktop  →  Tailscale CLI on this machine  →  your tailnet
```

No Tailscale API key. No account token stored by the plugin. SSH usernames are asked per connection and not remembered.

**The status cache.** `tailscale status --json` is longer than the 4k `shell.exec` stdout cap, so the plugin writes it to `status-cache.json` next to `plugin.js` and reads it back. That file holds what `tailscale status` shows: device names, tailnet IPs, owners, tags, OS, and last-seen times. It is rewritten on every poll (8s on the page, 60s otherwise), created `0600` on macOS and Linux, relies on the user-only profile ACL on Windows, and is deleted when the plugin unloads or Hermes quits cleanly. If Hermes crashes it stays until the next run overwrites it. Delete it by hand any time; the plugin recreates it.

- **Local CLI.** Roster, ping, serve, exit node, account switch, and Taildrop all exec the installed client.
- **Confirm before write.** Serve, exit node, account switch, and file send ask first.
- **Funnel off.** Publish is `tailscale serve --bg --yes <port>`, tailnet only. The port defaults to 9119, is editable in the confirm bar, and is remembered per profile. Before running serve the plugin checks that something answers on `127.0.0.1:<port>` (a renderer fetch, then `curl`). If nothing does, serve is not run. If it cannot tell, it says so and asks again.
- **SSH overlay.** The in-app terminal is xterm 5.5.0. The plugin fetches it once, hashes the bytes, and refuses to run anything that does not match the SHA-384 pinned in `plugin.js`. It looks for `xterm.js` next to `plugin.js` first, then jsDelivr, then unpkg. After that, keystrokes go to the local PTY.

Removing the plugin file does not log you out of Tailscale or delete Hermes sessions.

## Compatibility

Hermes Tailscale uses the desktop plugin SDK and `host.request('shell.exec')`. SSH and Taildrop progress use `window.hermesDesktop.terminal` when this Desktop build has it.

| Platform | Tailscale CLI | PTY shell | Status |
| --- | --- | --- | --- |
| Windows 11 | Current stable (`C:\Program Files\Tailscale\tailscale.exe` or on PATH) | PowerShell | Tested with each release |
| macOS | Current stable (Homebrew, standalone, or the App Store binary) | zsh | Same CLI door, POSIX quoting. Not yet tested by the maintainer |
| Linux | Current stable (`/usr/bin`, `/usr/local/bin`, or snap) | bash or sh | Same CLI door, POSIX quoting. Not yet tested by the maintainer |

The CLI needs `tailscale serve --bg` (Tailscale 1.48 or newer). Hermes Desktop: any build that ships the desktop plugin SDK and `shell.exec`. SSH and Taildrop progress additionally need `hermesDesktop.terminal`; without it the ssh line is copied and file send runs under `shell.exec` with no progress bar.

Each tagged release lists the Hermes Desktop and Tailscale versions it was tested against. If you run it on a row marked "not yet tested" and it works, open an issue and say so.

## Limits

- The serve port check only proves a listener exists. It does not prove that listener is Hermes.
- A remote gateway shows *that* machine's tailnet, not the laptop in front of you.
- Ping, serve, and other `shell.exec` calls still have a 30 second cap. SSH and file send do not, because they use a PTY.
- One Taildrop send at a time.
- The SSH overlay is xterm, not a full Desktop terminal app. Fine for a shell, `apt`, and passwords. A poor place to live in tmux all day.
- xterm is fetched at runtime unless you drop a copy next to `plugin.js`. Offline first launch with no local copy falls back to a plain log.

<br />

<div align="center">
  <strong>Hermes Tailscale</strong><br />
  <sub>The machines you already trust, in the app you already have open.</sub>
</div>

<br />

## License

[MIT](LICENSE).

> **Community project**
>
> Hermes Tailscale is an independent community plugin. It is not affiliated with, endorsed by, sponsored by, or officially associated with [Nous Research](https://github.com/NousResearch), the [Hermes Agent project](https://github.com/NousResearch/hermes-agent), or [Tailscale](https://tailscale.com). Hermes, Hermes Agent, Nous Research, and Tailscale are names and marks belonging to their respective owners.


## Signed updates and recovery

At the bottom of Tailscale, choose **Check for updates**. The plugin checks [its own GitHub releases](https://github.com/Adolanium/hermes-tailscale/releases) and asks before installing. **Update now** downloads the offered version; **Later** leaves the installation unchanged. Checking alone downloads only release metadata.

Every update has an ECDSA P-256 signature verified against the public key embedded in the plugin. The signed metadata binds the repository, plugin identity, version, exact commit, file list, sizes, and SHA-256 hashes. Unsigned releases, changed downloads, and automatic downgrades are rejected. A signature verifies origin and integrity, not the absence of bugs.

The updater replaces only `plugin.js`. It requires no additional Python, Git, package manager, or updater service. All file operations use stock Desktop APIs on the **local Desktop profile**, even when the gateway is remote. Saved settings are preserved.

**Restore previous version** verifies the last complete backup and asks before restoring. Choose **Restore now** or **Cancel**. Updating or restoring reloads the plugin, so finish active work first. Terminal connections may close. Use **Reload desktop plugins** or restart Desktop if the screen does not refresh.

Backups remain beside the installed files as `update-<id>-backup-<filename>`. Failed replacements attempt to restore every original file. Desktop does not expose an atomic multi-file replacement: a crash between renames can require manual recovery. Close Desktop, move any replaced files aside, restore **all files from the same backup ID** to their original names, then reopen Desktop. For example, `update-<id>-backup-plugin.js` becomes `plugin.js`.

Existing installations need one manual installation of this updater-enabled version. Later versions can use the confirmation flow above. Hermes Agent source changes are not required.

### Publishing updates

The release description must contain a signed `hermes-desktop-update` block using schema 2. Publish a stable tag `v<VERSION>` against the exact pushed commit named in the signature. This plugin accepts only `Adolanium/hermes-tailscale`, plugin ID `hermes-tailscale`, and `plugin.js`. Signing is a maintainer operation; the private signing key must stay outside the repository and never ship to users.

<details>
<summary>Maintainer signing procedure</summary>

Update VERSION, test, commit, and push. Save this script outside the repository as sign-release.mjs and run node /path/to/sign-release.mjs FULL_COMMIT_SHA from the repository. It prints the path of the signed release notes. Publish with gh release create vVERSION --target FULL_COMMIT_SHA --notes-file NOTES_PATH. Keep the signed block unchanged when adding notes. Only maintainers need Node.js and Git.

The private key is read from HERMES_PLUGIN_SIGNING_KEY, or the maintainer's ~/.hermes-ssh-release/signing-key.pem. This is the existing family signing identity; signatures also bind each release to its own repository. Back up the key securely. Key rotation needs a release signed by the previous key or a manual reinstall.

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const commit = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Use a full pushed commit SHA.');
const source = execFileSync('git', ['show', `${commit}:plugin.js`]).toString('utf8');
const plugin = source.match(/const PLUGIN_ID\s*=\s*['"]([^'"]+)['"]/)?.[1];
const version = source.match(/const VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
const repo = source.match(/repo: "(Adolanium\/[^"]+)"/)?.[1];
const names = JSON.parse(source.match(/files: (\[[^\]]+\])/)[1]);
const pinned = source.match(/const UPDATE_KEY = "([^"]+)"/)?.[1];
if (!plugin || !/^\d+\.\d+\.\d+$/.test(version) || !repo ||
    names.some(name => !['plugin.js', 'probe.py'].includes(name))) throw Error('Invalid updater configuration.');
const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim().replace(/\.git$/, '');
if (origin !== `https://github.com/${repo}` && origin !== `git@github.com:${repo}`) throw Error('Repository does not match origin.');
const key = fs.readFileSync(process.env.HERMES_PLUGIN_SIGNING_KEY || path.join(os.homedir(), '.hermes-ssh-release', 'signing-key.pem'));
if (crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64') !== pinned) throw Error('Signing key does not match the plugin.');
const files = names.map(name => {
  const content = execFileSync('git', ['show', `${commit}:${name}`]);
  if (!content.length || content.length > 500000) throw Error('Release file exceeds updater limits.');
  return { name, sha256: crypto.createHash('sha256').update(content).digest('hex'), bytes: content.length };
});
const payload = Buffer.from(JSON.stringify({ schema: 2, plugin, repo, version, commit, files }));
const signature = crypto.sign('sha256', payload, { key, dsaEncoding: 'ieee-p1363' });
const envelope = { payload: payload.toString('base64'), signature: signature.toString('base64') };
const output = path.join(os.tmpdir(), repo.split('/')[1] + '-release-notes.md');
fs.writeFileSync(output, `${repo.split('/')[1]} v${version}\n\nSigned updates and backup recovery, with confirmation before each change.\n\n\`\`\`hermes-desktop-update\n${JSON.stringify(envelope)}\n\`\`\`\n`);
console.log(output);

```

</details>


## Catalog package

The `catalog/` directory packages this Desktop plugin for the Hermes plugin catalog,
using the [combined package layout](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk#one-package-both-sdks).
Catalog admission is pending. The repository does not imply approval or endorsement.

To install the package directly before catalog admission:

```sh
hermes plugins install Adolanium/hermes-tailscale/catalog
```

Restart Hermes Desktop or rescan plugins, then enable the Desktop component in
Capabilities > Plugins. This package adds no Agent tools, hooks, or middleware.
It requires Hermes Desktop with combined-package support. On a remote backend,
the Desktop component must also be installed on the machine running the app.

The existing root `plugin.js` remains the standalone distribution. Keep one
installation per Desktop plugin. Before switching from a manual install, back up
and move its folder out of the Desktop plugin directory; Hermes intentionally
does not overwrite manual installations. Keep plugin settings when migrating.

After catalog admission, use `hermes plugins update hermes-tailscale` and rescan
Desktop plugins to adopt a reviewed update. The packaged copy's update and restore
actions cannot replace its files from GitHub releases. Standalone signed updates
continue to use the existing root files.

For development, edit the root files, then run `python scripts/build_catalog.py`.
Commit the resulting `catalog/` files. CI runs `python scripts/build_catalog.py --check`
to keep the package current, including any companion files. Catalog packaging
releases use `catalog-v0.0.5-1` and are not marked as the latest standalone release.
