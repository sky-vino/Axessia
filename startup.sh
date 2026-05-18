#!/bin/bash
# =============================================================================
# Axessia (Sky) — Azure App Service startup script
# =============================================================================
# node_modules and built dist/ are shipped inside the deploy zip, so this
# script does the minimum needed on each boot:
#   1. Install Chromium system libs (apt) — needed by Playwright
#   2. Ensure Playwright Chromium browser binary is on disk
#   3. Make sure /home/data exists for SQLite
#   4. Start Node
# =============================================================================
set -e

echo "============================================================"
echo "=== Axessia (Sky) — boot $(date -u +'%Y-%m-%dT%H:%M:%SZ') ==="
echo "============================================================"
echo "cwd:  $(pwd)"
echo "node: $(node --version 2>&1)"
echo "npm:  $(npm --version 2>&1)"

cd /home/site/wwwroot

# ── 1. Chromium system libraries ────────────────────────────────────────────
echo ""
echo "[1/4] Installing Chromium system libraries..."
apt-get update -qq 2>&1 | tail -2 || echo "  (apt-get update non-fatal failure)"
apt-get install -y -qq \
    libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxcb1 libxkbcommon0 libx11-6 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    2>&1 | tail -3 || echo "  (some libs may have failed — continuing)"
echo "[1/4] Done."

# ── 2. Playwright Chromium ───────────────────────────────────────────────────
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/playwright-browsers}"
echo ""
echo "[2/4] Ensuring Playwright Chromium at $PLAYWRIGHT_BROWSERS_PATH..."
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
if [ -z "$(ls -A "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null)" ]; then
    cd backend
    npx playwright install chromium 2>&1 | tail -5 || echo "  (playwright install warning)"
    cd ..
    echo "[2/4] Chromium installed."
else
    echo "[2/4] Chromium already present — skipping."
fi

# ── 3. Persistent storage ────────────────────────────────────────────────────
echo ""
echo "[3/4] Ensuring /home/data exists..."
mkdir -p /home/data
echo "[3/4] OK."

# ── 4. Frontend sanity check ─────────────────────────────────────────────────
echo ""
echo "[4/4] Frontend build check..."
if [ -f frontend/dist/index.html ]; then
    echo "  frontend/dist/index.html present ($(wc -c < frontend/dist/index.html) bytes)"
    echo "  asset count: $(ls -1 frontend/dist/assets 2>/dev/null | wc -l)"
else
    echo "  WARNING: frontend/dist/index.html not found. Only /api will work."
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
