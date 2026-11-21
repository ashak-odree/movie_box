# MovieBox-Web

TUI-styled web interface for `MovieBox-TUI` featuring:
- **`mamamiakoi` Passphrase Gate** (`PASSCODE` env var, defaults to `mamamiakoi`)
- **Same-to-same TUI Design** (all 9 `MovieBox-TUI` color themes, keyboard-first `j`/`k`/`/`/`Enter`/`Tab`/`t`/`?`/`Esc` + mouse support)
- **Live Streaming & Direct Download** (built-in HTML5 + HLS `.m3u8` player, subtitle `.srt` -> WebVTT proxy, `Range` seeking, and one-click file download)
- **Auto-Update Scheduler** (checks `../MovieBox-TUI` git upstream every 30 min, runs `git pull --ff-only`, rebuilds `moviebox-web`, and restarts automatically via `run.sh`)

## Quick Start (Local)

```bash
cd /media/asif/Mahbub12/mviWeb/MovieBox-Web
chmod +x run.sh
./run.sh
```

Open `http://localhost:8080` and type `mamamiakoi` to enter.

## Host on Cloudflare (Free, $0/month)

1. Start `MovieBox-Web` with `./run.sh`.
2. Install `cloudflared` and run:
   ```bash
   cloudflared tunnel --url http://localhost:8080
   ```
   Or bind it to your own Cloudflare domain with a named tunnel (`cloudflared tunnel create moviebox`).

