#!/bin/bash
# =============================================================================
# Axessia (Sky) — Azure App Service startup script
# =============================================================================
# What this does on each App Service boot:
#   1. Install Chromium system libraries (apt) so Playwright can launch a
#      headless browser. ~10s after the first time the layer is cached.
#   2. Install backend Node dependencies into /home/node-modules (persistent),
#      and link them into backend/. Skipped on subsequent boots.
#   3. Install Playwright Chromium into /home/playwright-browsers (persistent).
#      Skipped on subsequent boots.
#   4. Ensure /home/data exists for the SQLite file.
#   5. Sanity-check that the React build is on disk.
#   6. Start Node + Express.
# =============================================================================
set -e

echo "============================================================"
echo "=== Axessia (Sky) — Startup at $(date -u +'%Y-%m-%dT%H:%M:%SZ') ==="
echo "============================================================"
echo "cwd:     $(pwd)"
echo "user:    $(id -un)"
echo "node:    $(node --version 2>&1)"
echo "npm:     $(npm --version 2>&1)"

cd /home/site/wwwroot

# ── 1. Chromium system libraries ────────────────────────────────────────────
echo ""
echo "[1/5] Installing Chromium system libraries..."
apt-get update -qq 2>&1 | tail -2 || echo "  (apt-get update non-fatal failure)"
apt-get install -y -qq \
    libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxcb1 libxkbcommon0 libx11-6 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    2>&1 | tail -3 || echo "  (some libs may have failed — continuing)"
echo "[1/5] Done."

# ── 2. Backend node_modules (cached on /home) ───────────────────────────────
NODE_MODULES_CACHE=/home/node-modules
echo ""
echo "[2/5] Ensuring backend node_modules at $NODE_MODULES_CACHE..."

mkdir -p "$NODE_MODULES_CACHE"

# Use the cache directory if the package-lock matches what's already installed.
PKG_HASH=$(sha1sum backend/package-lock.json 2>/dev/null | cut -c1-12 || echo "nolock")
STAMP="$NODE_MODULES_CACHE/.installed-$PKG_HASH"

if [ ! -f "$STAMP" ]; then
    echo "  Installing fresh node_modules (hash=$PKG_HASH)..."
    rm -rf "$NODE_MODULES_CACHE"/*
    cd backend
    npm ci --omit=dev --no-audit --no-fund --prefix "$NODE_MODULES_CACHE" || \
        npm install --omit=dev --no-audit --no-fund --prefix "$NODE_MODULES_CACHE"
    cd ..
    touch "$STAMP"
    echo "  Done."
else
    echo "  Cached node_modules match current package-lock.json — skipping."
fi

# Symlink the cached node_modules into backend/ so Node resolution works
if [ ! -e backend/node_modules ]; then
    ln -s "$NODE_MODULES_CACHE/node_modules" backend/node_modules
fi
echo "[2/5] Done."

# ── 3. Playwright Chromium ───────────────────────────────────────────────────
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/playwright-browsers}"
echo ""
echo "[3/5] Ensuring Playwright Chromium at $PLAYWRIGHT_BROWSERS_PATH..."
if [ ! -d "$PLAYWRIGHT_BROWSERS_PATH" ] || [ -z "$(ls -A "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null)" ]; then
    mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
    cd backend
    npx playwright install chromium 2>&1 | tail -5
    cd ..
    echo "[3/5] Chromium installed."
else
    echo "[3/5] Chromium already present — skipping."
fi

# ── 4. Persistent storage ────────────────────────────────────────────────────
echo ""
echo "[4/5] Ensuring persistent storage paths exist..."
mkdir -p /home/data
echo "[4/5] /home/data ready."

# ── 5. Frontend assets sanity check ──────────────────────────────────────────
echo ""
echo "[5/5] Frontend build check..."
if [ -f frontend/dist/index.html ]; then
    echo "  frontend/dist/index.html present ($(wc -c < frontend/dist/index.html) bytes)"
    echo "  asset count: $(ls -1 frontend/dist/assets 2>/dev/null | wc -l)"
else
    echo "  WARNING: frontend/dist/index.html not found. API will still serve."
fi

# ── Boot ──────────────────────────────────────────────────────────────────
export PORT="${PORT:-4000}"
export NODE_ENV="${NODE_ENV:-production}"

echo ""
echo "============================================================"
echo "Starting Node backend on port $PORT (NODE_ENV=$NODE_ENV)"
echo "============================================================"
cd backend
exec node dist/index.js
