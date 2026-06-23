#!/bin/bash

# Axessia Azure App Service startup script
set -e

echo "============================================================"
echo "=== Axessia boot $(date -u +'%Y-%m-%dT%H:%M:%SZ') ==="
echo "============================================================"
echo "Working directory: $(pwd)"
echo "Node version: $(node --version 2>&1)"

cd /home/site/wwwroot

# Display deployed commit information when available.
if [ -f ".deploy-sha" ]; then
    echo ""
    echo "Deployment information:"
    cat .deploy-sha
fi

# ------------------------------------------------------------
# [1/4] Chromium system libraries
# ------------------------------------------------------------

echo ""
echo "[1/4] Installing Chromium system libraries..."

apt-get update -qq 2>&1 | tail -2 || \
    echo "WARNING: apt-get update failed; continuing with installed libraries."

apt-get install -y -qq \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxcb1 \
    libxkbcommon0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    2>&1 | tail -3 || \
    echo "WARNING: Some Chromium libraries could not be installed."

echo "[1/4] Chromium library step completed."

# ------------------------------------------------------------
# [2/4] Playwright Chromium
# ------------------------------------------------------------

export PLAYWRIGHT_BROWSERS_PATH="/home/playwright-browsers"
BUNDLED_DIR="/home/site/wwwroot/playwright-browsers"

echo ""
echo "[2/4] Configuring Playwright Chromium..."
echo "Persistent browser path: $PLAYWRIGHT_BROWSERS_PATH"
echo "Bundled browser path: $BUNDLED_DIR"

mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

# Copy all browser components bundled by GitHub Actions.
# This includes chromium, chromium_headless_shell and ffmpeg.
if [ -d "$BUNDLED_DIR" ] && \
   [ -n "$(ls -A "$BUNDLED_DIR" 2>/dev/null)" ]; then

    echo "Copying bundled Playwright browser files..."

    cp -a "$BUNDLED_DIR"/. "$PLAYWRIGHT_BROWSERS_PATH"/
    chmod -R a+rx "$PLAYWRIGHT_BROWSERS_PATH"

    echo "Bundled browser files copied."
else
    echo "WARNING: Bundled Playwright browser directory is missing or empty."
    echo "Expected directory: $BUNDLED_DIR"
fi

# Ask the installed Playwright package for the exact executable it requires.
EXPECTED_BROWSER=$(
    cd /home/site/wwwroot/backend &&
    node -e \
      "process.stdout.write(require('playwright').chromium.executablePath())"
)

echo "Playwright expects Chromium at:"
echo "$EXPECTED_BROWSER"

# Temporary fallback:
# If the deployment artifact did not contain the required revision,
# download it into persistent Azure storage.
if [ ! -x "$EXPECTED_BROWSER" ]; then
    echo "Required Chromium executable is not present."
    echo "Attempting fallback Playwright browser installation..."

    cd /home/site/wwwroot/backend
    npx playwright install chromium
    cd /home/site/wwwroot

    EXPECTED_BROWSER=$(
        cd /home/site/wwwroot/backend &&
        node -e \
          "process.stdout.write(require('playwright').chromium.executablePath())"
    )
fi

# Do not start the API if scans cannot launch a browser.
if [ ! -x "$EXPECTED_BROWSER" ]; then
    echo "ERROR: Required Chromium executable is still unavailable:"
    echo "$EXPECTED_BROWSER"
    exit 1
fi

echo "[2/4] Chromium ready at:"
echo "$EXPECTED_BROWSER"

# Perform a real browser launch test before starting the API.
echo "Running Chromium startup test..."

cd /home/site/wwwroot/backend

node <<'NODE_TEST'
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setContent(
    "<!doctype html><html><body><h1>Axessia startup test</h1></body></html>"
  );

  const heading = await page.textContent("h1");

  if (heading !== "Axessia startup test") {
    throw new Error("Chromium rendered unexpected startup-test content.");
  }

  await browser.close();
  console.log("Chromium startup test passed.");
})().catch((error) => {
  console.error("Chromium startup test failed:", error);
  process.exit(1);
});
NODE_TEST

cd /home/site/wwwroot

# ------------------------------------------------------------
# [3/4] Persistent application storage
# ------------------------------------------------------------

echo ""
echo "[3/4] Preparing persistent application storage..."

mkdir -p /home/data

if [ ! -d "/home/data" ]; then
    echo "ERROR: Unable to create /home/data."
    exit 1
fi

echo "[3/4] Persistent storage ready."

# ------------------------------------------------------------
# [4/4] Frontend and backend validation
# ------------------------------------------------------------

echo ""
echo "[4/4] Validating deployed application files..."

if [ ! -f "frontend/dist/index.html" ]; then
    echo "ERROR: frontend/dist/index.html is missing."
    exit 1
fi

if [ ! -f "backend/dist/index.js" ]; then
    echo "ERROR: backend/dist/index.js is missing."
    exit 1
fi

if [ ! -d "backend/migrations" ]; then
    echo "ERROR: backend/migrations is missing."
    exit 1
fi

echo "Frontend index size: $(wc -c < frontend/dist/index.html) bytes"
echo "Frontend asset count: $(find frontend/dist/assets -maxdepth 1 -type f 2>/dev/null | wc -l)"
echo "[4/4] Application files verified."

# ------------------------------------------------------------
# Start Axessia
# ------------------------------------------------------------

export PORT="${PORT:-8080}"
export NODE_ENV="${NODE_ENV:-production}"

echo ""
echo "============================================================"
echo "Starting Axessia backend"
echo "Port: $PORT"
echo "Environment: $NODE_ENV"
echo "============================================================"

cd /home/site/wwwroot/backend
exec node dist/index.js