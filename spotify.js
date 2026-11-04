// ============================================================
// spotify.js — turn a Spotify link into { title, artist, ... }
//
// Why this exists: we used to hand the Spotify URL to `spotdl` (a big
// Python tool) mainly so it could figure out "which song is this?".
// That costs ~220 MB of RAM just to load Python + its libraries.
//
// It turns out Spotify already gives that info away for free on its
// public *embed* page — the little player widget you see embedded in
// blogs (https://open.spotify.com/embed/track/<id>). That page ships a
// JSON blob inside a <script id="__NEXT_DATA__"> tag with the title,
// artists, duration and cover art. So we just fetch that page with
// Node's built-in `fetch` and read the JSON. No API keys, no Python,
// no npm packages.
// ============================================================

// Spotify serves a slimmer/different page to unknown clients, so we
// identify as a normal desktop browser to get the standard embed page.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Never let a slow Spotify response hang our request forever.
const FETCH_TIMEOUT_MS = 10_000;

// A Spotify track ID is always 22 characters of letters/digits (base62).
const TRACK_ID_PATTERN = /track[/:]([A-Za-z0-9]{22})/;

/**
 * Pull the 22-character track ID out of the different shapes a Spotify
 * link can come in:
 *   https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc
 *   https://open.spotify.com/intl-fr/track/4uLU6hMCjMI75M1A2tKUQC
 *   spotify:track:4uLU6hMCjMI75M1A2tKUQC
 *   https://spotify.link/AbCdEf   (short share link — we follow it first)
 *
 * Returns the ID string, or null if this isn't a track link (e.g. it's a
 * playlist or album, which we don't support yet).
 */
async function extractTrackId(input) {
  if (!input || typeof input !== 'string') return null;
  const url = input.trim();

  // Easy case: the ID is right there in the link.
  const direct = url.match(TRACK_ID_PATTERN);
  if (direct) return direct[1];

  // Short links (spotify.link / spoti.fi) hide the real URL behind a
  // redirect. We follow it and look for the track ID in wherever we end
  // up — either the final URL or, failing that, the page's HTML (some
  // short links land on an "open in app" page that contains the real URL).
  if (/^https?:\/\/(spotify\.link|spoti\.fi)\//i.test(url)) {
    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const fromUrl = res.url.match(TRACK_ID_PATTERN);
      if (fromUrl) return fromUrl[1];
      const fromBody = (await res.text()).match(/open\.spotify\.com\/track\/([A-Za-z0-9]{22})/);
      if (fromBody) return fromBody[1];
    } catch (err) {
      console.error(`[-] Could not expand short Spotify link ${url}: ${err.message}`);
    }
  }

  return null;
}

/**
 * PRIMARY: read the __NEXT_DATA__ JSON from the embed page.
 * Gives us everything: title, all artists, duration, cover art.
 */
async function fetchFromEmbedPage(trackId) {
  const res = await fetch(`https://open.spotify.com/embed/track/${trackId}`, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`embed page returned HTTP ${res.status}`);

  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('embed page had no __NEXT_DATA__ block');

  // The track info lives a few levels deep. Optional chaining (?.) means
  // "if any step along this path is missing, just give me undefined"
  // instead of crashing — Spotify could reshuffle this at any time.
  const entity = JSON.parse(match[1])?.props?.pageProps?.state?.data?.entity;
  const title = entity?.name || entity?.title;
  if (!title) throw new Error('embed JSON did not contain a track title');

  const artists = (entity.artists || []).map((a) => a.name).filter(Boolean);

  // Spotify lists several sizes of the cover. Pick the biggest one.
  const images = entity.visualIdentity?.image || [];
  const biggestImage = images.reduce(
    (best, img) => (!best || (img.maxWidth || 0) > (best.maxWidth || 0) ? img : best),
    null
  );

  return {
    id: trackId,
    title,
    artists,
    artist: artists.join(', '),
    durationMs: entity.duration || null,
    coverUrl: biggestImage?.url || null,
  };
}

/**
 * FALLBACK: Spotify's official oEmbed endpoint. It's a stable, documented
 * API, but it only gives us the title (no artist / duration). That's still
 * enough to search YouTube with, just less accurately — better than failing.
 */
async function fetchFromOembed(trackId) {
  const trackUrl = `https://open.spotify.com/track/${trackId}`;
  const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`oEmbed returned HTTP ${res.status}`);

  const data = await res.json();
  if (!data.title) throw new Error('oEmbed response had no title');

  return {
    id: trackId,
    title: data.title,
    artists: [],
    artist: '',
    durationMs: null,
    coverUrl: data.thumbnail_url || null,
  };
}

/**
 * Main entry point used by server.js.
 * Tries the rich embed page first, then the oEmbed fallback.
 * Throws if neither works (caller turns that into an HTTP error).
 */
async function getTrackMetadata(trackId) {
  try {
    return await fetchFromEmbedPage(trackId);
  } catch (embedErr) {
    console.warn(`[!] Embed lookup failed for ${trackId} (${embedErr.message}) — trying oEmbed fallback...`);
    return await fetchFromOembed(trackId);
  }
}

module.exports = { extractTrackId, getTrackMetadata };
