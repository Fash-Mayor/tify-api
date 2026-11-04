# ============================================================
# Dockerfile for tify-api
#
# Why this exists: Render (and most cloud hosts) can run a plain
# Node app directly, but that only gives us Node/npm. Our server
# also shells out to `yt-dlp` (the tool that downloads audio from
# YouTube) — which a bare Node environment doesn't have. Docker
# lets us build our own little Linux machine with exactly what we
# need installed, so it behaves the same on Render as it does on
# our laptop.
#
# What changed in the "slim" rewrite (Phase 1 / Option 2):
#   REMOVED  python3 + pip + spotdl   (~220 MB of RAM per download)
#   REMOVED  Deno                     (~120 MB — Node now solves
#                                      YouTube's JS challenge instead)
#   ADDED    standalone yt-dlp binary (one file, Python bundled inside)
#   KEPT     ffmpeg — but ONLY for a cheap "remux" fix-up of the .m4a
#            container. We no longer re-encode to .mp3, which was the
#            memory-hungry part.
# ============================================================

# ---- 1. Base image ----
# We start from an official Node image. The "slim" variant is
# Debian Linux with just the essentials — small, but still gives
# us `apt-get` to install other system packages on top. (We avoid
# "alpine": the standalone yt-dlp binary is built for glibc-based
# Linux like Debian, and won't run on Alpine's musl libc.)
# Node 22 also matters for yt-dlp: it needs Node 20+ to use Node as
# its JavaScript runtime (see the --js-runtimes flag in server.js).
FROM node:22-slim

# ---- 2. System dependencies ----
# ffmpeg          -> lets yt-dlp tidy up the downloaded .m4a container
#                    ("FixupM4a"). This is a copy, not a re-encode, so it
#                    only uses a few MB of RAM for a couple of seconds.
# ca-certificates -> needed so yt-dlp can make HTTPS requests to YouTube
# --no-install-recommends keeps the image smaller by skipping optional extras.
# The final `rm -rf /var/lib/apt/lists/*` deletes apt's package index cache
# afterwards — we don't need it anymore and it just adds dead weight to the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---- 3. Install yt-dlp (standalone binary) ----
# yt-dlp publishes a single self-contained Linux executable on every
# release, with Python and its helper packages (including `yt-dlp-ejs`,
# the YouTube JS-challenge solver scripts) bundled INSIDE it. So we don't
# need to install Python or pip at all — just download one file and make
# it executable.
#
# We always grab the LATEST release on purpose: YouTube changes things
# often, and we saw first-hand that an older yt-dlp version (2026.07.04)
# got "HTTP Error 403: Forbidden" while the latest one worked. Every new
# deploy on Render rebuilds this image, so redeploying = updating yt-dlp.
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /usr/local/bin/yt-dlp

# Files fetched with ADD aren't executable by default, so we flip the
# "executable" permission on. Then a quick sanity check: if the binary is
# broken or can't run on this base image, the build fails HERE with a
# clear error instead of every download failing later at runtime.
RUN chmod 755 /usr/local/bin/yt-dlp && yt-dlp --version

# ---- 4. App setup ----
# Everything from here on happens inside /app in the container.
WORKDIR /app

# Copy just the dependency manifests first (not the whole codebase yet).
# Docker caches each step: as long as package.json/package-lock.json don't
# change, it reuses the cached `npm install` result instead of redoing it,
# which makes rebuilds after a small code change much faster.
COPY package*.json ./
RUN npm install --omit=dev

# Now copy the rest of our actual source code in.
COPY . .

# Documents which port the app listens on. This doesn't actually publish
# the port by itself — Render assigns a real port at runtime via the
# $PORT environment variable, which server.js reads.
EXPOSE 3000

# The command that starts the server when the container runs.
CMD ["node", "server.js"]
