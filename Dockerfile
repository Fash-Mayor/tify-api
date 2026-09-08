# ============================================================
# Dockerfile for tify-api
#
# Why this exists: Render (and most cloud hosts) can run a plain
# Node app directly, but that only gives us Node/npm. Our server
# also shells out to `spotdl` (a Python command-line tool) and
# `ffmpeg` (for audio conversion) — neither of which a bare Node
# environment has. Docker lets us build our own little Linux
# machine with exactly what we need installed, so it behaves the
# same on Render as it does on our laptop.
# ============================================================

# ---- 1. Base image ----
# We start from an official Node image. The "slim" variant is
# Debian Linux with just the essentials — small, but still gives
# us `apt-get` to install other system packages on top (unlike
# the even smaller "alpine" variant, which uses a different package
# manager that trips up some Python packages).
# Version 22 matches the Node version on this laptop (node --version).
FROM node:22-slim

# ---- 2. System dependencies ----
# python3/pip3 -> lets us install spotdl (it's a Python tool, not npm)
# ffmpeg       -> spotdl needs it to convert/tag the downloaded audio
# ca-certificates -> needed so Python/pip can make HTTPS requests
# --no-install-recommends keeps the image smaller by skipping optional extras.
# The final `rm -rf /var/lib/apt/lists/*` deletes apt's package index cache
# afterwards — we don't need it anymore and it just adds dead weight to the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---- 3. Install spotdl itself ----
# Debian 12+ blocks plain `pip install` at the system level on purpose
# (it's worried about clashing with Debian's own Python tooling) — that's
# the "externally-managed-environment" error you'd see without this flag.
# --break-system-packages overrides that; it's safe here because this
# container's Python is ONLY ever used to run spotdl, nothing else.
RUN pip3 install --no-cache-dir --break-system-packages spotdl

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
# $PORT environment variable, which server.js reads (see next step).
EXPOSE 3000

# The command that starts the server when the container runs.
CMD ["node", "server.js"]
