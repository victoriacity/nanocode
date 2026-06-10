# Nanocode

A multi-user web workspace for shared dev hosts. Browse to `http://<host>:2333`, log in with a one-time code from your terminal, and you get multi-tab terminals, a project file explorer, and coding-agent tabs (Claude / Codex / Cursor / OpenCode) — all persisted across reloads, reboots, and device hand-offs.

## Features

- **Multi-user system mode** — single systemd-managed router runs as an unprivileged service account; per-user workers run as the invoking UID. No user needs to join any group.
- **Multi-tab terminals** — bash, Claude Code, Codex, Cursor Agent, OpenCode. Each agent launches with its max-permissions / no-approvals flag. Agent `/exit` drops you to a raw login shell instead of going dead.
- **Project file explorer** — tree, breadcrumb, inline edit, drag-drop uploads, markdown / code / image / **GLB 3D-model** preview.
- **Persistent sessions** — 3-day rolling TTL on the auth cookie; PTYs survive worker restarts; scrollback replays after a host reboot.
- **Cross-device** — log in on a laptop, pick the same session up on a phone.
- **Dark mode** — header toggle, OS-preference detection, FOUC-free pre-paint, xterm theme swap on the fly.
- **No build step** — vanilla JS served as static files by the router (decoupled from worker health, so a busy worker can't break cold-load).
- **Auto-update** — systemd timer checks GitHub releases nightly, drops in new versions without manual intervention.

## Install (system mode, recommended)

Requires Linux with systemd, Node ≥ 18, and a user that can `sudo`.

```bash
sudo apt-get update
sudo apt-get install -y git build-essential nodejs npm curl

git clone https://github.com/victoriacity/nanocode.git /tmp/nanocode
sudo /tmp/nanocode/scripts/install.sh
sudo systemctl enable --now nanocode
```

The installer:

- Creates a `nanocode` system user/group (service account; **no human user needs to be in this group**).
- Lays the app under `/usr/lib/nanocode/`, the CLI at `/usr/local/bin/nanocode`, the systemd unit at `/etc/systemd/system/nanocode.service`.
- Builds + installs `nanocode-spawn` as setuid-root (mode 4755). This is the only piece that runs with elevated privileges, and only momentarily — it drops to the invoking UID before exec'ing the worker.
- Installs and enables the daily auto-update timer (`nanocode-update.timer`).
- Listens on port **2333** by default. Change with `Environment=PORT=…` in `/etc/systemd/system/nanocode.service`.

**Per user — run as that user, NOT as root:**

```bash
nanocode login
# → prints a one-time claim code
# → paste it at http://<host>:2333/login in your browser
```

Any user on the host can run `nanocode login`. No group membership required. Sessions last 3 days rolling. Workers auto-reconnect to the router after restarts.

## Maintain

### Check status

```bash
systemctl status nanocode               # router (always running)
nanocode status                         # your worker
journalctl -u nanocode -f               # router logs (live)
sudo systemctl list-timers nanocode-update.timer
```

### Restart the router (workers preserved)

```bash
sudo systemctl restart nanocode
# Workers auto-reconnect through their backoff loop.
# PTYs and live agent sessions survive.
```

### Restart your worker (PTYs and agent state lost)

```bash
nanocode logout && nanocode login
```

You'd do this if your worker is stuck, or to pick up new worker-side code after an update. Agents' on-disk work (git commits, file edits) is preserved; only their in-memory conversation context is lost.

### Update

The `nanocode-update.timer` runs `/usr/lib/nanocode/nanocode-update.sh` daily at ~04:00 + jitter. It compares `/usr/lib/nanocode/package.json`'s version to the latest GitHub release tag; if they differ, it downloads the release tarball, runs `install.sh` from inside it, restarts the router.

Run it on demand:

```bash
sudo /usr/lib/nanocode/nanocode-update.sh
```

Disable auto-update:

```bash
sudo systemctl disable --now nanocode-update.timer
```

### Uninstall

```bash
sudo systemctl disable --now nanocode nanocode-update.timer
sudo rm -rf /usr/lib/nanocode /etc/systemd/system/nanocode.service /etc/systemd/system/nanocode-update.{service,timer}
sudo rm /usr/local/bin/nanocode
sudo userdel nanocode && sudo groupdel nanocode
sudo systemctl daemon-reload
```

User data at `~/.nanocode/` (data.json, scrollback, runtime env) is preserved unless you explicitly remove it.

## Known limitations

- After a host reboot, each user must run `nanocode login` once to bring their worker back. `loginctl enable-linger <user>` + a per-user `systemctl --user` template will fully automate this (open follow-up).
- File explorer browses local projects only. Remote-SSH projects show a "remote browsing unsupported" state — use terminal tabs.
- xterm symlink-escape from a project sandbox isn't lexically blocked (acceptable for the single-user-trusted-host model).

## Single-user mode (dev / hacking)

If you don't want system mode and just want to run nanocode against your own user, the legacy single-user mode still works:

```bash
git clone https://github.com/victoriacity/nanocode.git
cd nanocode
npm install
npm start
# → http://localhost:3000
```

PM2 / `npm run pm2:start` keeps it alive across reboots if you want a quick persistent setup without going through system mode.

## Architecture

See [`docs/system-mode-design.md`](docs/system-mode-design.md) for the privilege-drop, auth flow, IPC framing, and the trust model. [`docs/architecture.md`](docs/architecture.md) covers the application layer (project store, PTY sessions, file explorer).

## Tests

```bash
npm test
```
