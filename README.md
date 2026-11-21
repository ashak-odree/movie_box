# movie_box

TUI-styled web app for `MovieBox-TUI` with `"mamamiakoi"` passphrase gate, live streaming, direct downloads, daily GitHub Actions sync with upstream `MovieBox-TUI`, and automatic Cloudflare Worker deployment on every push to `main`.

## Structure
- `MovieBox-TUI/` — Git submodule tracking `https://github.com/mesamirh/MovieBox-Tui`
- `MovieBox-Web/` — Rust (`axum`) web server wrapping `MovieBox-TUI` + embedded TUI frontend
- `MovieBox-Worker/` — Cloudflare Worker (`wrangler.toml` + `public/` + `src/`)
- `.github/workflows/sync-moviebox-tui.yml` — Runs daily at 03:00 UTC (09:00 BDT) to pull upstream `MovieBox-TUI`, run `cargo check`, and push to `main`
- `.github/workflows/deploy-cloudflare.yml` — Automatically deploys `MovieBox-Worker` to Cloudflare on every push to `main`

## Cloudflare Auto-Deploy Setup (Choose Either)

### Option 1: Cloudflare Dashboard Git Integration (Recommended — Zero Secrets)
1. Go to **Cloudflare Dashboard → Workers & Pages → moviebox → Settings → Build**.
2. Connect GitHub repo `ashak-odree/movie_box` (Production branch: `main`).
3. Set **Root directory** to `MovieBox-Worker` and **Deploy command** to `npx wrangler deploy`.
4. Every push to `main` (including the daily `MovieBox-TUI` sync) will auto-deploy!

### Option 2: GitHub Actions (`deploy-cloudflare.yml`)
Add two Repository Secrets in GitHub (`Settings → Secrets and variables → Actions`):
- `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit)
- `CLOUDFLARE_ACCOUNT_ID` (`1604e0d6dab2f716d783fc0b6b7e7b85`)

## Local Server (`MovieBox-Web`)
```bash
git clone --recursive https://github.com/ashak-odree/movie_box.git
cd movie_box/MovieBox-Web
PORT=8090 ./run.sh
```

