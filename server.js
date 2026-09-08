const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
// could hit /download and burn our hosting bandwidth/CPU running spotdl
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

// Global database in memory to track active downloads.
// "In memory" means this object lives in RAM only — it resets to empty
// every time the server restarts (a deploy, a crash, a free-tier host
// waking back up). Fine for a personal app: worst case, a download that
// was mid-flight during a restart just needs to be retried.
const activeSessions = {};

// STEP 1: Trigger the download and return a tracking ID instantly
//
// Downloading + converting a track can take several seconds — long enough
// that if we made the phone wait on this one request for the whole thing,
// it'd likely time out. So instead this handler kicks off the work and
// responds immediately with just an ID; the phone comes back later (STEP 2)
// to ask "is it done yet?" This is the classic "async job" pattern.
app.get('/download', (req, res) => {
    const spotifyUrl = req.query.url;
    if (!spotifyUrl) return res.status(400).json({ error: "Missing URL" });

    const sessionId = crypto.randomUUID();

    // Initialize session state
    activeSessions[sessionId] = { status: 'downloading', fileName: null, filePath: null };

    // Respond immediately to prevent timeouts!
    res.json({ success: true, sessionId });

    // Everything below this line runs AFTER we've already responded to the
    // phone. Node keeps executing this callback in the background while the
    // HTTP request itself is already finished — that's what makes the
    // "respond instantly, work continues after" trick possible.
    const tempDir = path.join(__dirname, 'temp_downloads', sessionId);
    fs.mkdirSync(tempDir, { recursive: true });

    console.log(`\n[+] [Session ${sessionId}] Background download started...`);

    // `exec` runs a shell command — here, the actual `spotdl` CLI tool —
    // as if we'd typed it into a terminal ourselves, with `cwd: tempDir`
    // meaning "run it as if we're standing inside this session's temp
    // folder", so whatever file spotdl produces lands there. The callback
    // fires once that process exits (success or failure).
    exec(`spotdl "${spotifyUrl}"`, { cwd: tempDir }, (error) => {
        if (error) {
            console.error(`[-] spotDL Error: ${error.message}`);
            activeSessions[sessionId].status = 'failed';
            fs.rmSync(tempDir, { recursive: true, force: true });
            return;
        }

        const files = fs.readdirSync(tempDir);
        // NOTE: .find() grabs only the FIRST matching audio file. That's fine
        // for a single track, but if `spotifyUrl` were a playlist/album, spotdl
        // would download several files here and we'd silently ignore all but
        // one of them. Multi-track support needs to change this bit (e.g. zip
        // everything in tempDir instead of picking one file) — noted for later.
        const audioFile = files.find(f => f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.ogg'));

        if (!audioFile) {
            activeSessions[sessionId].status = 'failed';
            fs.rmSync(tempDir, { recursive: true, force: true });
            return;
        }

        // Mark the session as ready for the phone to pull
        activeSessions[sessionId].status = 'ready';
        activeSessions[sessionId].fileName = audioFile;
        activeSessions[sessionId].filePath = path.join(tempDir, audioFile);
        console.log(`[+] [Session ${sessionId}] Conversion complete! File is cached and ready.`);
    });
});

// STEP 2: Phone will ping this route to monitor progress
app.get('/status', (req, res) => {
    const { sessionId } = req.query;
    const session = activeSessions[sessionId];
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json({ status: session.status });
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