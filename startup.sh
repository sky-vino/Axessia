#!/bin/bash
# =============================================================================
# Axessia (Sky) — Azure App Service startup script
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
# We require the EXACT browser binary Playwright is asking for. If the
# expected chrome executable isn't found at the path Playwright derives
# from the installed playwright-core version, force an install.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/playwright-browsers}"
echo ""
echo "[2/4] Checking Playwright Chromium at $PLAYWRIGHT_BROWSERS_PATH..."
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

# Find any installed chrome binary
CHROME_BIN=$(find "$PLAYWRIGHT_BROWSERS_PATH" -type f -name chrome 2>/dev/null | head -1)
if [ -n "$CHROME_BIN" ] && [ -x "$CHROME_BIN" ]; then
    echo "[2/4] Found chrome at $CHROME_BIN — verifying it matches the Playwright version..."
    # Try a quick launch dry-run by listing the version. If Playwright's
    # expected path differs from what's on disk, the runtime will fail anyway,
    # so we run install with --dry-run-style check: presence of folder name
    # like chromium-NNNN where NNNN matches.
    cd backend
    EXPECTED=$(node -e "const r=require('playwright-core/lib/server/registry/index.js'); console.log(r.registry?.findExecutable?.('chromium')?.executablePath?.() || '')" 2>/dev/null || echo "")
    cd ..
    if [ -n "$EXPECTED" ] && [ ! -f "$EXPECTED" ]; then
        echo "  Mismatch — Playwright expects $EXPECTED but it does not exist."
        echo "  Re-installing Chromium..."
        cd backend
        npx playwright install chromium 2>&1 | tail -8
        cd ..
    else
        echo "[2/4] Chromium version matches Playwright — skipping install."
    fi
else
    echo "[2/4] No chrome binary found — installing fresh..."
    cd backend
    npx playwright install chromium 2>&1 | tail -8
    cd ..
fi
echo "[2/4] Done."

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
export PORT="${PORT:-8080}"
export NODE_ENV="${NODE_ENV:-production}"

echo ""
echo "============================================================"
echo "Starting Node backend on port $PORT (NODE_ENV=$NODE_ENV)"
echo "============================================================"
cd backend
exec node dist/index.js
