# CineSrc Stremio Addon

A Stremio addon that delivers movie and TV-show streams via **CineSrc** — multiple servers, no P2P, direct HTTP playback through an embed player.

This repo ships **two things**:

| What | Where | Use when… |
|---|---|---|
| **Standalone addon** | `addon.js` + `manifest.json` | You want a fresh, self-contained addon |
| **NuvioStreams provider** | `nuvio-provider/cinesrc.js` | You already run NuvioStreams and just want to add CineSrc as an extra source |

---

## Standalone Addon

### How it works

Stremio identifies content by **TMDB IDs** (`tmdb:12345`) or **IMDb IDs** (`tt1234567`). CineSrc also uses TMDB IDs, so:

- `tmdb:…` IDs are passed straight through.
- `tt…` IMDb IDs are converted to TMDB IDs via the free TMDB API (requires `TMDB_API_KEY`).

The addon returns an `externalUrl` stream — Stremio opens it in its built-in WebView, which renders the CineSrc embed player.

### Quick start

```bash
git clone <this-repo>
cd cinesrc-stremio-addon

cp .env.example .env
# edit .env and set TMDB_API_KEY (free from themoviedb.org)

npm install
npm start
```

Then open Stremio and install the addon from:

```
http://localhost:7860/manifest.json
```

### Docker

```bash
# Build and run
docker compose up -d

# Or without compose
docker build -t cinesrc-addon .
docker run -p 7860:7860 -e TMDB_API_KEY=your_key cinesrc-addon
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7860` | HTTP port |
| `TMDB_API_KEY` | *(required for IMDb IDs)* | Free key from [themoviedb.org](https://www.themoviedb.org/settings/api) |
| `CINESRC_AUTOSKIP` | `false` | Auto-skip intro/recap segments |
| `CINESRC_AUTONEXT` | `true` | Auto-play next episode |
| `CINESRC_QUALITY` | `1080` | Preferred quality: `1080`, `720`, `480` |
| `CINESRC_COLOR` | `#e50914` | Player accent colour (hex) |
| `CINESRC_SEEK` | `10` | Seek-button duration in seconds (1–99) |
| `CINESRC_FEBBOX` | *(optional)* | FebBox auth token for premium source access |

---

## NuvioStreams Provider (drop-in patch)

If you run [NuvioStreams](https://github.com/tapframe/NuvioStreamsAddon), you can add CineSrc as an extra provider in three steps:

### 1. Copy the provider file

```bash
cp nuvio-provider/cinesrc.js /path/to/NuvioStreamsAddon/providers/cinesrc.js
```

### 2. Register the provider in NuvioStreams

Open `addon.js` (or wherever providers are imported) and add:

```js
const cinesrcProvider = require('./providers/cinesrc');

// Add to the end of your providers array, e.g.:
const providers = [
  // … existing providers …
  cinesrcProvider,
];
```

NuvioStreams typically iterates `providers` and calls `getMovieStreams` / `getEpisodeStreams` on each. The CineSrc provider exports exactly those methods, so it slots in without any other changes.

### 3. Set env vars (optional)

Add these to your NuvioStreams `.env`:

```env
CINESRC_ENABLED=true      # set to false to disable without removing the file
CINESRC_AUTOSKIP=false
CINESRC_AUTONEXT=true
CINESRC_QUALITY=1080
CINESRC_COLOR=#e50914
CINESRC_SEEK=10
CINESRC_FEBBOX=           # optional premium token
```

---

## Notes

- **IMDb → TMDB conversion** is done at request time using the [TMDB Find API](https://developer.themoviedb.org/reference/find-by-id). Results are not cached by default; add your own cache layer (e.g. `node-cache`) if you want to reduce API calls.
- CineSrc streams are embed pages, not raw video files. Stremio opens them in its built-in browser. This works well on desktop and Android; iOS behaviour depends on the Stremio version.
- No scraping, no cookies, no proxies needed — CineSrc handles server selection internally.

## License

MIT
