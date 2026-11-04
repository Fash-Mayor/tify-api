const express = require('express');
const cors = require('cors');
// We use `spawn` (not `exec`) to run yt-dlp — see runYtDlp() below for why.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// Our pure-Node replacement for spotdl's "which song is this link?" step.
const { extractTrackId, getTrackMetadata } = require('./spotify');

const app = express();

// Cloud hosts (like Render) assign the port dynamically via the PORT
// environment variable and expect us to listen on whatever they give us —
// there's no guarantee it'll be 3000. Locally, that env var won't exist,
// so `|| 3000` falls back to the old hardcoded value for local testing.
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---- API key gate ----
// Right now this server only gets requests from you, over a private ngrok
// tunnel. Once it has a permanent public URL, anyone who finds that URL
// could hit /download and burn our hosting bandwidth/CPU running yt-dlp
// on our behalf. This is a minimal fix: every request must send a header
//   x-api-key: <same secret value as the server's API_KEY env var>
// or it gets rejected before doing any work.
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  // No key configured — most likely you're just running this locally to
  // test. We don't hard-fail so local dev still works, but we do warn
  // loudly so this can't silently ship to production with no auth.
  console.warn('[!] WARNING: API_KEY is not set — running with NO auth. Set API_KEY before deploying publicly.');
}

app.use((req, res, next) => {
  if (!API_KEY) return next(); // auth disabled locally when no key is configured
  const suppliedKey = req.header('x-api-key');
  if (suppliedKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid API key' });
  }
  next();
});

// ---- YouTube cookie file (works around YouTube blocking our server) ----
// yt-dlp sources the actual audio from YouTube. YouTube is much more
// aggressive about blocking anonymous/datacenter requests (like our
// Render server) than requests that look like a real signed-in browser.
// The fix: give yt-dlp a `cookies.txt` exported from a real, logged-in
// YouTube session, and it'll send requests that look like that browser.
//
// On Render this file is uploaded as a "Secret File", which Render mounts
// at /etc/secrets/<filename> — never committed to git, never in our repo.
// Locally, this path just won't exist, so we skip the flag entirely and
// yt-dlp runs without cookies (may just be more likely to get blocked,
// same as we saw in testing).
const COOKIE_FILE_PATH = process.env.YTDLP_COOKIE_FILE || '/etc/secrets/cookies.txt';
const hasCookieFile = fs.existsSync(COOKIE_FILE_PATH);

// yt-dlp doesn't just READ the cookie file — when it finishes, it tries to
// WRITE updated cookies back into it. Render mounts secret files as
// read-only, so that write would crash the download with a permission
// error. Fix: copy the secret once at startup to a writable temp location
// and point yt-dlp at the copy instead.
let ytDlpCookiePath = null;
if (hasCookieFile) {
  try {
    ytDlpCookiePath = path.join(os.tmpdir(), 'tify-yt-cookies.txt');
    fs.copyFileSync(COOKIE_FILE_PATH, ytDlpCookiePath);
  } catch (err) {
    console.warn(`[!] Could not copy cookie file to a writable location (${err.message}) — using it in place.`);
    ytDlpCookiePath = COOKIE_FILE_PATH;
  }
} else {
  console.warn(`[!] No YouTube cookie file found at ${COOKIE_FILE_PATH} — yt-dlp downloads may get blocked by YouTube's bot detection.`);
}

// Which yt-dlp program to run. Normally just "yt-dlp" from the PATH, but
// you can point YTDLP_PATH at a specific binary (handy for testing a newer
// version locally without replacing your installed one).
const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp';

// Kill a yt-dlp run if it takes longer than this. Without a limit, a stuck
// download would hold its session (and its RAM) forever.
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS) || 3 * 60 * 1000;

// Global database in memory to track active downloads.
// "In memory" means this object lives in RAM only — it resets to empty
// every time the server restarts (a deploy, a crash, a free-tier host
// waking back up). Fine for a personal app: worst case, a download that
// was mid-flight during a restart just needs to be retried.
const activeSessions = {};

// ---- Helpers ----

/**
 * Turn "AC/DC - Back In Black?" into a name that's safe to save on any OS.
 * Windows, Android and iOS all reject some characters in filenames
 * (/ \ : * ? " < > |), so we swap those out and trim the length.
 */
function toSafeFileName(name) {
  return name
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '')    // invisible control characters
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'track';
}

/**
 * Run yt-dlp with the given arguments and resolve with its exit code.
 *
 * Why `spawn` instead of `exec`?
 *   `exec` collects EVERYTHING the program prints into one big string in
 *   memory and only hands it to us at the very end. With chatty tools that
 *   can be megabytes. `spawn` instead gives us the output as a live stream,
 *   chunk by chunk, so we can read each line (e.g. "[download] 42.0%"),
 *   use it, and let it go.
 *
 *   `spawn` also passes arguments as an ARRAY directly to the program, with
 *   no shell in between. That means a malicious "URL" like
 *   `"; rm -rf / #` can't sneak in extra shell commands — with `exec` and a
 *   string we were one missing quote away from that.
 *
 * @param {string[]} args        command-line arguments for yt-dlp
 * @param {(line: string) => void} onLine  called for every output line
 */
function runYtDlp(args, onLine) {
  return new Promise((resolve) => {
    const child = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      onLine(`[tify] yt-dlp exceeded ${DOWNLOAD_TIMEOUT_MS / 1000}s — killing it.`);
      child.kill('SIGKILL');
    }, DOWNLOAD_TIMEOUT_MS);

    // Output arrives in arbitrary chunks, not neat lines — a chunk can end
    // halfway through a line. So we keep the unfinished tail in `buffer`
    // and only pass complete lines on.
    const handleStream = (stream) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n|\r/);
        buffer = lines.pop();
        lines.filter(Boolean).forEach(onLine);
      });
      stream.on('end', () => buffer && onLine(buffer));
    };
    handleStream(child.stdout);
    handleStream(child.stderr);

    // 'error' fires if the program couldn't even start — most commonly
    // ENOENT, meaning yt-dlp isn't installed / isn't on the PATH.
    child.on('error', (err) => {
      clearTimeout(timer);
      onLine(`[tify] Failed to start yt-dlp: ${err.message}`);
      resolve(-1);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/**
 * Search YouTube for the track and download its audio into `tempDir`.
 * Resolves with the downloaded file's name, or null if nothing came down.
 */
async function downloadAudio(sessionId, track, tempDir) {
  const session = activeSessions[sessionId];

  // Keep only the last few output lines for error reports. A fixed-size
  // list means memory use stays tiny no matter how much yt-dlp prints.
  const recentLines = [];
  const onLine = (line) => {
    recentLines.push(line);
    if (recentLines.length > 25) recentLines.shift();

    // yt-dlp prints lines like "[download]  42.3% of 3.21MiB at 1.2MiB/s".
    // We grab the percentage so /status can report real progress.
    const pct = line.match(/\[download\]\s+([\d.]+)%/);
    if (pct && session) session.progress = Math.min(100, Math.round(parseFloat(pct[1])));
  };

  // "Rick Astley - Never Gonna Give You Up audio" — adding "audio" nudges
  // YouTube towards official audio uploads instead of music videos (which
  // often have intros/skits that don't match the Spotify version).
  const query = [track.artist, track.title].filter(Boolean).join(' - ') + ' audio';

  const baseArgs = [
    // Prefer the best audio-only stream that's ALREADY .m4a (AAC). Phones
    // play that natively, so we don't need ffmpeg to convert it to .mp3 —
    // that conversion alone was ~180 MB of RAM. `/ba` = "otherwise, best
    // audio of any format".
    '-f', 'ba[ext=m4a]/ba',
    '--no-playlist',
    // Print each progress update on its own line (instead of overwriting
    // one line with \r), which makes it easy for us to parse.
    '--newline',
    '--no-mtime',
    // YouTube now makes clients solve a small JavaScript puzzle before it
    // hands out working audio URLs — without it, downloads fail with
    // "HTTP Error 403: Forbidden". yt-dlp needs a JS engine to solve it.
    // spotdl used Deno for this (an extra ~120 MB runtime), but yt-dlp can
    // use Node too — and we're ALREADY running inside Node! So we point it
    // at our own Node binary (process.execPath) and skip Deno entirely.
    '--js-runtimes', `node:${process.execPath}`,
    // Don't nag about updates in our logs; the Docker build always
    // installs the latest release anyway.
    '--no-update',
    // Save as track.<ext> inside this session's private folder. We rename
    // it to "Artist - Title.m4a" ourselves afterwards.
    '-o', path.join(tempDir, 'track.%(ext)s'),
  ];
  if (ytDlpCookiePath) baseArgs.push('--cookies', ytDlpCookiePath);

  // ATTEMPT 1 (only if we know the Spotify duration): look at the top 5
  // YouTube results and take the first one whose length is within ±20s of
  // the Spotify track. This is roughly the matching trick spotdl used, and
  // it avoids grabbing e.g. a 10-minute "extended mix" or a 30s short.
  if (track.durationMs) {
    const seconds = Math.round(track.durationMs / 1000);
    const exitCode = await runYtDlp(
      [
        `ytsearch5:${query}`,
        '--match-filter', `duration >= ${seconds - 20} & duration <= ${seconds + 20}`,
        // Stop after the first match. yt-dlp exits with code 101 when it
        // hits this limit — that's a success for us, not an error.
        '--max-downloads', '1',
        ...baseArgs,
      ],
      onLine
    );
    const file = findAudioFile(tempDir);
    if (file) return file;
    console.warn(`[!] [Session ${sessionId}] No duration-matched result (yt-dlp exit ${exitCode}) — falling back to top search result.`);
  }

  // ATTEMPT 2: just take the #1 search result.
  const exitCode = await runYtDlp([`ytsearch1:${query}`, ...baseArgs], onLine);
  const file = findAudioFile(tempDir);
  if (file) return file;

  console.error(`[-] [Session ${sessionId}] yt-dlp produced no audio file (exit ${exitCode}). Last output:\n${recentLines.join('\n')}`);
  return null;
}

/** Find the finished audio file in a folder (ignoring half-done .part files). */
function findAudioFile(dir) {
  try {
    return fs.readdirSync(dir).find((f) => /\.(m4a|mp3|webm|opus|ogg|aac)$/i.test(f)) || null;
  } catch {
    return null;
  }
}

// STEP 1: Trigger the download and return a tracking ID instantly
//
// Downloading a track can take several seconds — long enough that if we
// made the phone wait on this one request for the whole thing, it'd
// likely time out. So instead this handler kicks off the work and
// responds immediately with an ID; the phone comes back later (STEP 2)
// to ask "is it done yet?" This is the classic "async job" pattern.
//
// The one thing we DO wait for is the Spotify metadata lookup (usually
// well under a second). That way a bad link fails right away with a
// clear message, and the phone gets the song title/artist/cover up front.
app.get('/download', async (req, res) => {
    const spotifyUrl = req.query.url;
    if (!spotifyUrl) return res.status(400).json({ success: false, error: "Missing URL" });

    const trackId = await extractTrackId(spotifyUrl);
    if (!trackId) {
      return res.status(400).json({
        success: false,
        error: 'That does not look like a Spotify track link (playlists/albums are not supported yet).',
      });
    }

    let track;
    try {
      track = await getTrackMetadata(trackId);
    } catch (err) {
      console.error(`[-] Metadata lookup failed for track ${trackId}: ${err.message}`);
      return res.status(502).json({ success: false, error: 'Could not read track info from Spotify.' });
    }

    const sessionId = crypto.randomUUID();

    // Initialize session state
    activeSessions[sessionId] = {
      status: 'downloading',
      progress: 0,
      track,
      fileName: null,
      filePath: null,
    };

    // Respond immediately to prevent timeouts!
    res.json({ success: true, sessionId, track });

    // Everything below this line runs AFTER we've already responded to the
    // phone. Node keeps executing this function in the background while the
    // HTTP request itself is already finished — that's what makes the
    // "respond instantly, work continues after" trick possible.
    const tempDir = path.join(__dirname, 'temp_downloads', sessionId);
    fs.mkdirSync(tempDir, { recursive: true });

    console.log(`\n[+] [Session ${sessionId}] Downloading "${track.artist} - ${track.title}"...`);

    try {
      const downloadedFile = await downloadAudio(sessionId, track, tempDir);
      if (!downloadedFile) throw new Error('no audio file produced');

      // Rename "track.m4a" -> "Rick Astley - Never Gonna Give You Up.m4a"
      // so the phone saves/shares it with a human-readable name.
      const ext = path.extname(downloadedFile);
      const niceName = toSafeFileName([track.artist, track.title].filter(Boolean).join(' - ')) + ext;
      const finalPath = path.join(tempDir, niceName);
      fs.renameSync(path.join(tempDir, downloadedFile), finalPath);

      // Mark the session as ready for the phone to pull
      Object.assign(activeSessions[sessionId], {
        status: 'ready',
        progress: 100,
        fileName: niceName,
        filePath: finalPath,
      });
      console.log(`[+] [Session ${sessionId}] Download complete! "${niceName}" is cached and ready.`);
    } catch (err) {
      console.error(`[-] [Session ${sessionId}] Download failed: ${err.message}`);
      if (activeSessions[sessionId]) activeSessions[sessionId].status = 'failed';
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// STEP 2: Phone will ping this route to monitor progress
app.get('/status', (req, res) => {
    const { sessionId } = req.query;
    const session = activeSessions[sessionId];
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json({
      status: session.status,
      progress: session.progress,
      track: session.track,
      fileName: session.fileName,
    });
});

// STEP 3: Phone downloads the pre-packaged file instantly
app.get('/get-file', (req, res) => {
    const { sessionId } = req.query;
    const session = activeSessions[sessionId];
    
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ error: "File not ready or session invalid" });
    }

    console.log(`[+] Pushing file to phone for session: ${sessionId}`);

    // res.download() streams the file straight to the phone and sets the
    // right headers (filename, content-type) for us. The callback here
    // fires once that transfer finishes (or fails) — that's our cue that
    // it's safe to delete the temp folder, since nobody needs it anymore.
    res.download(session.filePath, session.fileName, (err) => {
        // Cleanup file system and memory tracking after download ends
        try {
            const dirPath = path.dirname(session.filePath);
            fs.rmSync(dirPath, { recursive: true, force: true });
            delete activeSessions[sessionId];
            console.log(`[+] Session ${sessionId} cleaned up successfully.`);
        } catch (cleanupErr) {
            console.error("Cleanup error:", cleanupErr);
        }
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`===================================================`);
    console.log(`Async Spotify Audio API listening on Port: ${PORT}`);
    console.log(`===================================================`);
});
