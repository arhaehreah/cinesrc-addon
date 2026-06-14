const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const manifest = require("./manifest.json");
const axios = require("axios");
const cheerio = require("cheerio");

const CINESRC_BASE = "https://cinesrc.st/embed";

/**
 * Build a CineSrc embed URL for a movie or TV episode.
 */
function buildCineSrcUrl(type, tmdbId, season, episode, opts = {}) {
  let url;

  if (type === "movie") {
    url = `${CINESRC_BASE}/movie/${tmdbId}`;
  } else {
    url = `${CINESRC_BASE}/tv/${tmdbId}?s=${season}&e=${episode}`;
  }

  const params = new URLSearchParams();

  // Force your preferred server profile (e.g., surge)
  params.set("server", "surge"); 

  // --- ADD FEBBOX PREMIUM ACCESS TOKEN ---
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
    // 1. Fetch the CineSrc web page source code with premium/server parameters attached
    const { data } = await axios.get(embedUrl, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://cinesrc.st/",
        "Origin": "https://cinesrc.st"
      }
    });

    // Convert the data payload safely to a string for pattern matching
    const htmlString = typeof data === 'string' ? data : JSON.stringify(data);
    
    // 2. Scan the body for an explicit Master Playlist path (.m3u8)
    // This regular expression captures standard and premium HLS playback assets
    const m3u8Regex = /(https?:\/\/[^"\s']+\.m3u8[^"\s']*)/i;
    const match = htmlString.match(m3u8Regex);
    
    if (match && match[0]) {
      // Clean up any backslash JSON escaping characters
      let cleanUrl = match[0].replace(/\\/g, ''); 
      console.log(`[CineSrc Extractor] Isolated direct target stream: ${cleanUrl}`);
      return cleanUrl;
    }
    
    // 3. Fallback: If CineSrc wraps the Surge/Febbox player inside an inner iframe, find it
    const cheerio = require('cheerio');
    const $ = cheerio.load(data);
    const iframeSrc = $("iframe").attr("src");
    
    if (iframeSrc) {
      console.log(`[CineSrc Extractor] Found nested player frame: ${iframeSrc}`);
      return iframeSrc;
    }

    console.warn("[CineSrc Extractor] No direct multimedia track isolated in primary frame.");
    return embedUrl; // Safe fallback so Stremio doesn't instantly crash
  } catch (error) {
    console.error(`[CineSrc Extractor] Critical error fetching ${embedUrl}:`, error.message);
    return null;
  }
};
    
    const $ = cheerio.load(data);
    
    // 2. Locate the stream source
    let finalStreamUrl = "";
    
    // Looks for an iframe target on the page
    const iframeSrc = $("iframe").attr("src");
    if (iframeSrc) {
      finalStreamUrl = iframeSrc;
    } else {
      // Fallback to the embed URL if no nested stream container is found immediately
      finalStreamUrl = embedUrl;
    }
    
    return finalStreamUrl;
  } catch (error) {
    console.error(`[CineSrc Extractor] Error scraping ${embedUrl}:`, error.message);
    return null;
  }
}

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

  // Fire up the background html parser
  const videoStreamUrl = await scrapeDirectVideoFile(embedUrl);

  return {
    streams: [
      {
        name:        "CineSrc Direct",
        description: "▶ Extracted Native HTTP Playback\nPlays directly inside Stremio",
        url:         videoStreamUrl || embedUrl, 
        behaviorHints: {
          notWebReady: true, // Configures the media streaming engine to bridge external player rules
          proxyHeaders: {
            "request": {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
              "Referer": "https://cinesrc.st/"
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
