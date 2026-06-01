# Intensive_Config-s

Master syllabus alignment and batch config tools live in **`batch-tracker-ui/`**. See [`batch-tracker-ui/README.md`](batch-tracker-ui/README.md) for setup (`.env`, Google service account, `npm run dev`).

## Render (hosted UI)

After a successful deploy, open your Render URL with **no path** — e.g. `https://YOUR-SERVICE.onrender.com/` — that is the **Master syllabus align** React app (same origin as `/api`).

If you only see JSON like `{"error":"UI not built",...}`, the Vite client did not build or the service is using the wrong root directory. In the Render dashboard set **Root Directory** to **(empty)** so the repo root is used, or sync the latest `render.yaml` (build uses `npm --prefix batch-tracker-ui …`). **Build logs** must show `vite build` completing and must not show `vite: not found`.

**Local dev (frontend):** run `npm run dev` inside `batch-tracker-ui` and open **http://localhost:5173** (Vite proxies `/api` to the server on port 8787).
