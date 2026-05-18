name: Build and deploy Node app to Azure Web App - axessia-app

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node 20
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      # ── Frontend build ───────────────────────────────────────────────────
      - name: Install frontend deps
        working-directory: frontend
        run: npm install --no-audit --no-fund --legacy-peer-deps

      - name: Build frontend (Vite)
        working-directory: frontend
        run: npm run build

      - name: Verify frontend build
        run: |
          test -f frontend/dist/index.html
          ls -la frontend/dist

      # ── Backend build ────────────────────────────────────────────────────
      - name: Install backend deps
        working-directory: backend
        run: npm install --no-audit --no-fund --legacy-peer-deps

      - name: Build backend (tsc)
        working-directory: backend
        run: npm run build

      # ── Install Playwright Chromium INTO the build ───────────────────────
      # We download Chromium to a local folder that we then ship inside the
      # zip. This bypasses all the npx-can't-find-the-CLI issues at runtime.
      - name: Install Playwright Chromium for ship
        working-directory: backend
        env:
          PLAYWRIGHT_BROWSERS_PATH: ${{ github.workspace }}/playwright-browsers
        run: |
          npx playwright install chromium
          echo "Chromium installed at:"
          ls -la "$PLAYWRIGHT_BROWSERS_PATH"

      - name: Verify backend build
        run: |
          test -f backend/dist/index.js
          test -f backend/migrations/init.sqlite.sql
          ls backend/dist
          ls backend/migrations

      # ── Stage deploy directory ──────────────────────────────────────────
      - name: Stage deploy directory
        run: |
          mkdir -p deploy/backend deploy/frontend deploy/playwright-browsers

          cp -r backend/dist          deploy/backend/dist
          cp -r backend/node_modules  deploy/backend/node_modules
          cp -r backend/migrations    deploy/backend/migrations
          cp    backend/package.json  deploy/backend/package.json

          cp -r frontend/dist         deploy/frontend/dist

          # Pre-built Chromium bundled in zip; startup.sh copies it to /home
          cp -r playwright-browsers/* deploy/playwright-browsers/ 2>/dev/null || true

          cp    startup.sh            deploy/startup.sh
          chmod +x deploy/startup.sh

          echo ""
          echo "Critical files check:"
          test -f deploy/backend/dist/index.js                 && echo "  OK  backend/dist/index.js"
          test -f deploy/backend/migrations/init.sqlite.sql    && echo "  OK  backend/migrations/init.sqlite.sql"
          test -f deploy/frontend/dist/index.html              && echo "  OK  frontend/dist/index.html"
          test -f deploy/startup.sh                            && echo "  OK  startup.sh"
          test -d deploy/backend/node_modules                  && echo "  OK  backend/node_modules"
          CHROME=$(find deploy/playwright-browsers -name chrome -type f | head -1)
          if [ -n "$CHROME" ]; then
            echo "  OK  bundled chrome at $CHROME"
          else
            echo "  WARNING: no chrome binary found in deploy/playwright-browsers"
          fi

          echo ""
          echo "Deploy tree (top level):"
          ls -la deploy/

      - name: Create deployment zip
        working-directory: deploy
        run: |
          zip -qr ../release.zip .
          echo "Deploy zip size: $(du -h ../release.zip | cut -f1)"

      # ── Azure deploy ─────────────────────────────────────────────────────
      - name: Login to Azure
        uses: azure/login@v2
        with:
          client-id:       ${{ secrets.AZUREAPPSERVICE_CLIENTID_2B7F8A68563540588D2B9FCDDE24980F }}
          tenant-id:       ${{ secrets.AZUREAPPSERVICE_TENANTID_8ED8A0C152054104A26BD00F1B5AE9E3 }}
          subscription-id: ${{ secrets.AZUREAPPSERVICE_SUBSCRIPTIONID_AFB2DB03E1CD43C295D6E3C5CB7EB2AF }}

      - name: Deploy to Azure Web App
        uses: azure/webapps-deploy@v3
        with:
          app-name:  axessia-app
          slot-name: Production
          package:   release.zip
