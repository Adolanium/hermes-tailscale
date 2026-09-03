<div align="center">

  <a href="https://github.com/NousResearch/hermes-agent">
    <img src="https://github.com/user-attachments/assets/ac2f5702-c842-4b2e-9340-737481fa0ece" width="96" height="96" alt="Nous Research Hermes mark" />
  </a>

  # Hermes Tailscale

  **Your tailnet is already running. It just wasn't in the sidebar.**

  Hermes Tailscale puts the machines on this device's tailnet on a page in Hermes Desktop.
  See who is online, copy an address, SSH in, send a file, or publish this Hermes onto the mesh.
  It talks to the Tailscale CLI you already installed. No admin API token. No cloud round trip.

  <sub>POWERED BY <a href="https://github.com/NousResearch/hermes-agent">HERMES AGENT</a> &nbsp;·&nbsp; COMMUNITY PLUGIN &nbsp;·&nbsp; VERSION 0.0.2</sub>

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
| **Reach**<br />Ping a peer. Open SSH in an xterm overlay. Type the username each time. It is not saved. | **Move**<br />Send a file with Taildrop and watch the bar fill. Pick an exit node. Switch accounts when more than one is logged in. Publish this Hermes with `tailscale serve` on port 9119. |

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

No Tailscale API key. No account token stored by the plugin. SSH usernames are asked per connection and not remembered. A status JSON cache may sit next to the plugin file so `tailscale status --json` is not truncated by the 4k `shell.exec` stdout cap.

- **Local CLI.** Roster, ping, serve, exit node, account switch, and Taildrop all exec the installed client.
- **Confirm before write.** Serve, exit node, account switch, and file send ask first.
- **Funnel off.** Publish is `tailscale serve --bg --yes 9119`, tailnet only.
- **SSH overlay.** The in-app terminal loads xterm from a CDN the first time. After that, keystrokes go to the local PTY.

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

- Serve is hardcoded to local port 9119. Hermes' own dashboard port can differ.
- A remote gateway shows *that* machine's tailnet, not the laptop in front of you.
- Ping, serve, and other `shell.exec` calls still have a 30 second cap. SSH and file send do not, because they use a PTY.
- One Taildrop send at a time.
- The SSH overlay is xterm, not a full Desktop terminal app. Fine for a shell, `apt`, and passwords. A poor place to live in tmux all day.
- xterm is fetched at runtime. Offline first launch falls back to a plain log if the CDN cannot load.

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
