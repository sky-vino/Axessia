#!/bin/bash
# Axessia (Sky) — Azure App Service startup script
set -e

echo "============================================================"
echo "=== Axessia (Sky) — boot $(date -u +'%Y-%m-%dT%H:%M:%SZ') ==="
echo "============================================================"
echo "cwd:  $(pwd)"
echo "node: $(node --version 2>&1)"

cd /home/site/wwwroot

# [1/4] Chromium system libraries
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

# [2/4] Copy bundled Chromium from zip to persistent storage
export PLAYWRIGHT_BROWSERS_PATH="/home/playwright-browsers"
echo ""
echo "[2/4] Setting up Playwright Chromium at $PLAYWRIGHT_BROWSERS_PATH..."

BUNDLED_DIR="/home/site/wwwroot/playwright-browsers"
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

if [ -d "$BUNDLED_DIR" ] && [ -n "$(ls -A "$BUNDLED_DIR" 2>/dev/null)" ]; then
    BUNDLED_VERSION=$(ls -1 "$BUNDLED_DIR" | grep '^chromium-' | head -1)
    if [ -n "$BUNDLED_VERSION" ]; then
        TARGET="$PLAYWRIGHT_BROWSERS_PATH/$BUNDLED_VERSION"
        if [ ! -d "$TARGET" ] || [ ! -f "$TARGET/chrome-linux64/chrome" ]; then
            echo "  Copying bundled $BUNDLED_VERSION to $TARGET ..."
            rm -rf "$TARGET"
            cp -r "$BUNDLED_DIR/$BUNDLED_VERSION" "$TARGET"
            cp -r "$BUNDLED_DIR"/* "$PLAYWRIGHT_BROWSERS_PATH/" 2>/dev/null || true
            chmod -R +rx "$TARGET" || true
            echo "  Copied."
        else
            echo "  $BUNDLED_VERSION already present — skipping copy."
        fi
    else
        echo "  WARNING: no chromium-* folder found in $BUNDLED_DIR"
    fi
else
    echo "  WARNING: $BUNDLED_DIR empty or missing. Scans will fail until Chromium is installed."
fi

CHROME_BIN=$(find "$PLAYWRIGHT_BROWSERS_PATH" -type f -name chrome 2>/dev/null | head -1)
if [ -n "$CHROME_BIN" ] && [ -x "$CHROME_BIN" ]; then
    echo "[2/4] Chrome ready at $CHROME_BIN"
else
    echo "[2/4] WARNING: no executable chrome binary found after setup."
fi

# [3/4] Persistent storage
echo ""
echo "[3/4] Ensuring /home/data exists..."
mkdir -p /home/data
echo "[3/4] OK."

# [4/4] Frontend sanity check
echo ""
echo "[4/4] Frontend build check..."
if [ -f frontend/dist/index.html ]; then
    echo "  frontend/dist/index.html present ($(wc -c < frontend/dist/index.html) bytes)"
    echo "  asset count: $(ls -1 frontend/dist/assets 2>/dev/null | wc -l)"
else
    echo "  WARNING: frontend/dist/index.html not found."
fi

# Boot
export PORT="${PORT:-8080}"
export NODE_ENV="${NODE_ENV:-production}"

echo ""
echo "============================================================"
echo "Starting Node backend on port $PORT (NODE_ENV=$NODE_ENV)"
echo "============================================================"
cd backend
exec node dist/index.js
