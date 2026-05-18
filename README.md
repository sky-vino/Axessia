# Axessia — Sky Accessibility Platform

Enterprise accessibility testing platform. Single Azure App Service container
hosting the React frontend and the Node.js + Express backend that runs
Playwright-based WCAG scans, all under one origin.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Azure App Service  ·  axessia-app  (Linux, Node 20)                │
│                                                                     │
│   startup.sh                                                        │
│     ├── apt: chromium system libs                                   │
│     ├── npm install --omit=dev   (cached on /home/node-modules)     │
│     ├── playwright install chromium  (cached on /home/...)          │
│     └── node backend/dist/index.js                                  │
│                                                                     │
│   Express app:                                                      │
│     /api/*    REST endpoints                                        │
│     /ws       WebSocket scan progress                               │
│     /         React SPA from frontend/dist                          │
│                                                                     │
│   Persistent storage (Azure Files mount at /home):                  │
│     /home/data/accessibility.sqlite                                 │
│     /home/playwright-browsers/                                      │
│     /home/node-modules/                                             │
└─────────────────────────────────────────────────────────────────────┘
```

## Repository layout

```
.
├── backend/                  Node.js + TypeScript + Express
│   ├── src/
│   │   ├── index.ts          App entry: API, /ws, static SPA, SPA fallback
│   │   ├── routes/           auth, scans, issues, projects, users
│   │   ├── scanner/          Playwright + axe-core + heuristics
│   │   ├── services/         scanQueue (memory/Redis), aiService, reportService
│   │   ├── middleware/       auth (JWT), error handler
│   │   └── utils/            db (SQLite), wsManager, logger
│   ├── migrations/init.sqlite.sql
│   └── package.json
│
├── frontend/                 React + Vite + Tailwind
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/            Login, Dashboard, NewScan, ScanDetail, History, Users
│   │   ├── components/       Layout, six tab components
│   │   ├── services/api.ts
│   │   └── index.css         Sky brand tokens
│   └── package.json
│
├── startup.sh                App Service startup command (`bash startup.sh`)
├── .github/workflows/main_axessia-app.yml   build & deploy pipeline
└── README.md
```

## Required Azure App Service settings

Go to Azure portal → `axessia-app` → **Configuration** → **Application settings**.
Add or update these. Items marked **NEW** are needed for this stack switch.

| Setting | Value |
|---|---|
| `WEBSITES_PORT` | `4000` |
| `NODE_ENV` | `production` |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false` |
| `ENABLE_ORYX_BUILD` | `false` |
| `PLAYWRIGHT_BROWSERS_PATH` | `/home/playwright-browsers` |
| `DATABASE_URL` | `sqlite:///home/data/accessibility.sqlite` |
| `STATIC_DIR` **NEW** | `/home/site/wwwroot/frontend/dist` |
| `SCAN_QUEUE_DRIVER` **NEW** | `memory` |
| `SCAN_QUEUE_CONCURRENCY` **NEW** | `2` |
| `JWT_SECRET` | (keep existing) |
| `JWT_REFRESH_SECRET` | (keep existing) |
| `DEFAULT_ADMIN_EMAIL` | `admin@axessia.local` |
| `DEFAULT_ADMIN_PASSWORD` | (keep existing strong password) |
| `AZURE_OPENAI_ENDPOINT` | (keep existing) |
| `AZURE_OPENAI_API_KEY` | (keep existing) — note this app uses `_API_KEY`, not `_KEY` |
| `AZURE_OPENAI_DEPLOYMENT` | (keep existing) |
| `AZURE_OPENAI_API_VERSION` | `2024-10-21` |
| `FRONTEND_URL` **NEW** | `*` (same-origin deploy; tighten to your domain later if you want strict CORS) |

**Important — switch the stack first:**

Azure portal → `axessia-app` → **Configuration** → **General settings** tab:
- **Stack:** Node
- **Major version:** Node 20 LTS
- **Minor version:** Node 20 LTS
- **Startup command:** `bash startup.sh`

Click **Save**.

> If your existing app was Python 3.11, switching the stack is the **one
> manual step** required before deploying this repo. Without it, the App
> Service will try to run Python on the deploy and the boot will fail.

## How the deploy happens

1. You push to `main` on this repo.
2. GitHub Actions runs `.github/workflows/main_axessia-app.yml`:
   - Sets up Node 20
   - Installs frontend deps and runs `npm run build` → `frontend/dist/`
   - Installs backend deps and runs `npm run build` → `backend/dist/`
   - Zips everything except `node_modules`
   - Logs in to Azure with OIDC and pushes the zip to `axessia-app`
3. App Service receives the zip, extracts to `/home/site/wwwroot/`, runs
   `bash startup.sh`.
4. `startup.sh`:
   - Installs Chromium libs via apt-get
   - Installs `node_modules` into `/home/node-modules/` (cached across boots)
   - Installs Playwright Chromium into `/home/playwright-browsers/` (cached)
   - Ensures `/home/data` exists for SQLite
   - Starts `node backend/dist/index.js`
5. Express serves `/api/*` and `/ws`, plus the React SPA from
   `/home/site/wwwroot/frontend/dist/`.

First boot after a fresh stack switch takes **~5 minutes** (Chromium install
and apt). Subsequent boots take **~30 seconds** thanks to the `/home`-cached
node_modules and Chromium.

## Local development

```bash
# Backend
cd backend
npm install
cp ../.env.example .env  # if you have one; or set vars manually
npx playwright install chromium
npm run dev   # runs ts-node-dev on :4000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev   # opens on http://localhost:3000, proxies /api and /ws to :4000
```

Default login: `admin@axessia.local` / `Admin@123`. Demo users `user1`–`user5`
share password `Accessibility`.

## Rollback

If a deploy goes wrong, the previous Streamlit and Axessia-FastAPI builds are
still in this repo's commit history. To roll back:

```bash
git revert HEAD
git push origin main
```

Or in Azure portal: **Deployment Center → Logs → Redeploy** a previous run.

The new app stores data at `/home/data/accessibility.sqlite`. Any prior
SQLite from the FastAPI Axessia (at `/home/data/axessia.sqlite`) is untouched
and remains recoverable.

## Useful endpoints

- `GET /api/health` — returns `{status, name, version, queue, ai_provider}`
- `GET /api/docs` — not exposed in this Express app (use the README's API
  reference in the backend folder for the route list)
- `WS /ws` — scan progress; subscribe with `{type:"subscribe", scanId:"…"}`

## Notes

- On B2 plan (3.5 GB RAM), `SCAN_QUEUE_CONCURRENCY=2` is the upper bound.
  Each Playwright scan peaks ~600–800 MB. Drop to `1` if you see OOM kills.
- SQLite + Azure Files is fine for a single instance. If you scale out,
  switch to Azure PostgreSQL by changing `DATABASE_URL`.
- All passwords are bcrypt-hashed (cost factor 12). JWT access tokens
  expire in 15 minutes; refresh tokens in 7 days.
- Change the admin password from the **Users** tab after first login.
