const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const manifest = require("./manifest.json");
const axios = require("axios");
const cheerio = require("cheerio");

const CINESRC_BASE = "https://cinesrc.st/embed";

/**
 * Build a CineSrc embed URL for a movie or TV episode with Surge & Febbox settings.
 */
function buildCineSrcUrl(type, tmdbId, season, episode, opts = {}) {
  let url;

  if (type === "movie") {
    url = `${CINESRC_BASE}/movie/${tmdbId}`;
  } else {
    url = `${CINESRC_BASE}/tv/${tmdbId}?s=${season}&e=${episode}`;
  }

  const params = new URLSearchParams();

  // Forces the Surge server
  params.set("server", "surge"); 

  // Injects the Febbox premium token from your Hugging Face secrets if available
  const febboxToken = process.env.FEBBOX_TOKEN;
  if (febboxToken) {
    params.set("febbox", febboxToken);
  }

  if (opts.autoskip)         params.set("autoskip",  "true");
  if (opts.autonext === false) params.set("autonext", "false");
  if (opts.quality)         params.set("quality",   opts.quality);
  if (opts.color)          params.set("color",     opts.color.replace("#", "%23"));
  if (opts.seek)           params.set("seek",      String(opts.seek));

  const qs = params.toString();
  if (qs) url += (url.includes("?") ? "&" : "?") + qs;

  return url;
}

/**
 * Convert a Stremio ID to a TMDB ID using the TMDB Find API.
 */
async function resolveTmdbId(stremioId, type) {
  if (stremioId.startsWith("tmdb:")) {
    return stremioId.replace("tmdb:", "");
  }

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

  const results = tmdbType === "movie" ? data.movie_results : data.tv_results;
  if (!results || results.length === 0) return null;

  return String(results[0].id);
}

// ---------------------------------------------------------------------------
// Addon definition & Extraction Engine
// ---------------------------------------------------------------------------

const builder = new addonBuilder(manifest);

/**
 * Background Scraper: Inspects the CineSrc player page to pull the direct link
 */
async function scrapeDirectVideoFile(embedUrl) {
  try {
    // 1. Convert the embed URL to target the bootstrap endpoint directly
    const bootstrapUrl = embedUrl.replace('/embed/', '/api/c/bootstrap/');
    
    console.log(`[CineSrc API] Intercepting internal configuration at: ${bootstrapUrl}`);

    // 2. Query the endpoint using authorization headers matching your setup
    const response = await axios.get(bootstrapUrl, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://cinesrc.st/",
        "Origin": "https://cinesrc.st",
        "Accept": "application/json"
      }
    });

    // 3. Inspect the JSON payload response for stream urls or source objects
    const dataString = JSON.stringify(response.data);
    
    // Look for any clean .m3u8 master file patterns embedded inside the response keys
    const m3u8Regex = /(https?:\/\/[^"\s']+\.m3u8[^"\s']*)/i;
    const match = dataString.match(m3u8Regex);
    
    if (match && match[0]) {
      let cleanUrl = match[0].replace(/\\/g, ''); 
      console.log(`[CineSrc API] Stream isolated out of bootstrap structure: ${cleanUrl}`);
      return cleanUrl;
    }

    // 4. Fallback trace if the stream array key uses standard variable names
    if (response.data && response.data.url) return response.data.url;
    if (response.data && response.data.file) return response.data.file;
    if (response.data && response.data.sources && response.data.sources[0]) {
      return response.data.sources[0].file || response.data.sources[0].url;
    }

    console.warn("[CineSrc API] Bootstrap data gathered but no direct file URL matched inside.");
    return embedUrl; 
  } catch (error) {
    console.error(`[CineSrc API] Error querying internal player bootstrap path:`, error.message);
    return embedUrl;
  }
}

// Re-added the missing async stream handler block wrapper
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[CineSrc] Stream request: type=${type} id=${id}`);

  let tmdbId, season, episode;

  if (type === "movie") {
    tmdbId = await resolveTmdbId(id, "movie");
  } else if (type === "series") {
    const parts = id.split(":");
    if (parts[0] === "tmdb") {
      tmdbId = parts[1];
      season  = parts[2];
      episode = parts[3];
    } else {
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

  const opts = {
    autoskip:  process.env.CINESRC_AUTOSKIP  === "true",
    autonext:  process.env.CINESRC_AUTONEXT  !== "false",
    quality:   process.env.CINESRC_QUALITY   || "",
    color:     process.env.CINESRC_COLOR     || "#e50914",
    seek:      Number(process.env.CINESRC_SEEK) || 10,
  };

  const embedUrl = buildCineSrcUrl(type === "series" ? "tv" : "movie", tmdbId, season, episode, opts);
  console.log(`[CineSrc] Generated player web URL: ${embedUrl}`);

  // Run the background scraper
  const videoStreamUrl = await scrapeDirectVideoFile(embedUrl);

  return {
    streams: [
      {
        name:        "CineSrc Direct",
        description: "▶ Extracted Native HTTP Playback\nPlays directly inside Stremio",
        url:         videoStreamUrl, 
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            "request": {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Referer": "https://cinesrc.st/",
              "Origin": "https://cinesrc.st"
            }
          }
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
