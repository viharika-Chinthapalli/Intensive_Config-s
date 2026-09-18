# Intensive_Config-s

Master syllabus alignment and batch config tools live in **`batch-tracker-ui/`**. See [`batch-tracker-ui/README.md`](batch-tracker-ui/README.md) for setup (`.env`, Google service account, `npm run dev`).

## Deploy on Railway

1. Push this repo to GitHub (remote `origin`).
2. Open [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → select **Intensive_Config-s**.
3. Prefer **Root Directory** empty (repo root). Config files:
   - `railway.json` / `nixpacks.toml` — build & start `batch-tracker-ui`
4. **Variables** → add:
   - **`GOOGLE_SERVICE_ACCOUNT_JSON`** = full service account JSON as **one line** (do not commit the key).
5. **Settings** → **Networking** → **Generate domain**.
6. Open the `*.up.railway.app` URL — Master syllabus align UI + `/api` on the same origin.

If Root Directory is **`batch-tracker-ui`**, Railway uses `batch-tracker-ui/railway.json` (`npm ci && npm run build` / `npm start`).

**Note:** Free Railway accounts have a resource limit. If deploy fails with “resource provision limit exceeded”, free an unused service or upgrade, then redeploy.

## Render (optional)

After a successful deploy, open your Render URL with **no path**. Build must run Vite (`npm run build`), not only `npm install`. See `batch-tracker-ui/README.md`.

**Local dev:** `cd batch-tracker-ui && npm run dev` → http://localhost:5173
