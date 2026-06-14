const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const manifest = require("./manifest.json");

const CINESRC_BASE = "https://cinesrc.st/embed";

/**
 * Build a CineSrc embed URL for a movie or TV episode.
 * Returns a stream object whose `externalUrl` opens the player page.
 * (Stremio will open it in the built-in browser / WebView.)
 */
function buildCineSrcUrl(type, tmdbId, season, episode, opts = {}) {
  let url;

  if (type === "movie") {
    url = `${CINESRC_BASE}/movie/${tmdbId}`;
  } else {
    url = `${CINESRC_BASE}/tv/${tmdbId}?s=${season}&e=${episode}`;
  }

  // Optional customisation forwarded from env / config
  const params = new URLSearchParams();

  if (opts.autoskip)       params.set("autoskip",  "true");
  if (opts.autonext === false) params.set("autonext", "false");
  if (opts.quality)        params.set("quality",   opts.quality);
  if (opts.color)          params.set("color",     opts.color.replace("#", "%23"));
  if (opts.seek)           params.set("seek",      String(opts.seek));

  const qs = params.toString();
  if (qs) url += (url.includes("?") ? "&" : "?") + qs;

  return url;
}

/**
 * Convert a Stremio ID to a TMDB ID.
 *
 * Stremio uses two ID formats:
 *   - "tmdb:12345"          → TMDB native  (pass directly)
 *   - "tt1234567"           → IMDb ID      → must call TMDB API to convert
 *
 * For simplicity this addon supports both, but IMDb→TMDB conversion
 * requires a free TMDB API key set in TMDB_API_KEY env var.
 */
async function resolveTmdbId(stremioId, type) {
  if (stremioId.startsWith("tmdb:")) {
    return stremioId.replace("tmdb:", "");
  }

  // IMDb ID (tt…) — convert via TMDB Find API
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.warn(
      `[CineSrc] TMDB_API_KEY not set – cannot convert IMDb ID ${stremioId} to TMDB ID.`
    );
    return null;
  }

  const tmdbType = type === "movie" ? "movie" : "tv";
  const res = await fetch(
    `https://api.themoviedb.org/3/find/${stremioId}?api_key=${apiKey}&external_source=imdb_id`
  );

  if (!res.ok) return null;
  const data = await res.json();

  const results =
    tmdbType === "movie" ? data.movie_results : data.tv_results;
  if (!results || results.length === 0) return null;

  return String(results[0].id);
}

// ---------------------------------------------------------------------------
// Addon definition
// ---------------------------------------------------------------------------

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[CineSrc] Stream request: type=${type} id=${id}`);

  let tmdbId, season, episode;

  if (type === "movie") {
    tmdbId = await resolveTmdbId(id, "movie");
  } else if (type === "series") {
    // Stremio series ID format: "<stremioId>:<season>:<episode>"
    const parts = id.split(":");
    // Handle both "tmdb:12345:1:1" and "tt1234567:1:1"
    if (parts[0] === "tmdb") {
      tmdbId = parts[1];
      season  = parts[2];
      episode = parts[3];
    } else {
      // IMDb format: "tt1234567:1:1"
      season  = parts[parts.length - 2];
      episode = parts[parts.length - 1];
      const baseId = parts.slice(0, parts.length - 2).join(":");
      tmdbId = await resolveTmdbId(baseId, "series");
    }
  }

  if (!tmdbId) {
    console.warn("[CineSrc] Could not resolve TMDB ID – returning empty.");
    return { streams: [] };
  }

  // Build player options from env
  const opts = {
    autoskip:  process.env.CINESRC_AUTOSKIP  === "true",
    autonext:  process.env.CINESRC_AUTONEXT  !== "false",
    quality:   process.env.CINESRC_QUALITY   || "",
    color:     process.env.CINESRC_COLOR     || "#e50914",
    seek:      Number(process.env.CINESRC_SEEK) || 10,
  };

  const embedUrl = buildCineSrcUrl(type === "series" ? "tv" : "movie", tmdbId, season, episode, opts);

  console.log(`[CineSrc] Resolved embed URL: ${embedUrl}`);

  return {
    streams: [
      {
        name:        "CineSrc",
        description: "▶ Open in CineSrc player\nMultiple servers • No P2P",
        externalUrl: embedUrl,
        // behaviorHints lets Stremio know this isn't a raw video URL
        behaviorHints: {
          notWebReady: false,
        },
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 7860;

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`[CineSrc] Addon running at http://localhost:${PORT}/manifest.json`);
