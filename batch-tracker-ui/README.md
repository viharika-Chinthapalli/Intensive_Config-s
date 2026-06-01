# Batch tracker UI

Primary flow: **master tracker alignment** — read your **Assessments Master Tracker** (the grid workbook with batch/week and links in **Syllabus & Pattern** — **not** the per-batch config file whose tabs are only things like Mock/Main Assessment Config and Test Links). The tracker has batch in **A**, week in **B**, syllabus workbook link in the **Syllabus & Pattern** column, and a **batch config** Insert link in the next column (often **I**) pointing at each batch’s Google file. Optionally a second link column (**J**) is still read for legacy layouts. The tool follows each syllabus link’s **Syllabus** tab, extracts the week block, and searches older batches for the best reuse match. APIs: `POST /api/syllabus-align-from-master`, `POST /api/copy-config-template`.

## Config template copy (`POST /api/copy-config-template`)

After **Align**, the UI’s **Copy template → destination** uses the **same** tracker column (the one after **Syllabus & Pattern**, often **I**) **twice**: **source** = that column on the **align winner** row (e.g. `B3W8` when reuse points there); **destination** = that column on the **target** row (e.g. `B7W7`). The copy API replaces Mock/Main Assessment & Interview tabs on the destination file (creating tabs via Sheets copy if missing) and partially updates **Test Links**. An optional **second** column (**J**) is not used for this flow.

Exact column letters are in `masterAlignMeta` (`configTemplateColumnLetter`, etc.).
**Body:** `sourceSpreadsheetId`, `destinationSpreadsheetId` (IDs or full `docs.google.com` URLs). You can still call the API from scripts with any pair of IDs.

**Requires:** Service account **Editor** on the destination and at least **Viewer** on the source template. Destination must already include a **Test Links** tab with the expected label row.

## What “aligned” means

- Row **1** of each batch tab must contain **exact** header text for the two columns you care about (default `B9W2` and `B10W2`).
- For each **data row** (from row 2 downward), the tool compares the two cells. If they are the same string (after trim), that row counts as **aligned** for that tab.
- A batch tab is **fully aligned** when there is **at least one** compared row and **zero** rows where the two values differ. Rows where **both** cells are empty are skipped.

Adjust the header names in the UI if your tracker uses different labels.

## Master tracker alignment (`POST /api/syllabus-align-from-master`)

**Body:** `masterSpreadsheetId`, `masterSheetName` (e.g. `Phase1 - Status`), `targetBatch`, `targetWeek`, optional `linkedSyllabusTabName` (default `Syllabus`), optional `skipMasterHeaderRows` (default `1`), optional `maxWeek`.

**Requires:** Service account can read the master and every linked syllabus spreadsheet. The **Syllabus & Pattern** column must expose a Google Sheets URL (hyperlink or plain URL); the server resolves the spreadsheet id and reads the linked **Syllabus** tab. Week sections are detected from text like `Weekly Assessment - N` or `Week - N` in columns A–C. The master **tab name** is matched to the file’s real worksheet titles (trim / case-insensitive) so small typos or hidden characters do not break ranges like `'Phase1 - Status'!A2:Z3000`. Read ranges are **clamped** to the tab’s grid (`gridProperties.rowCount` / `columnCount`) so values like **Read master through row** = 3000 do not exceed the sheet (e.g. 982 rows); extend the grid in Google Sheets if you need more rows scanned.

If Google returns **quota exceeded** / **read requests per minute** while opening many linked workbooks in one run, the server **retries with backoff** on each linked-workbook Sheets call, **spaces** successive workbook loads (default **1100 ms**; override with **`SHEETS_INTER_WORKBOOK_DELAY_MS`**), and **only loads** linked files for batch/week keys the aligner may compare (not every row on the master — set **`ALIGN_LOAD_ALL_SYLLABUS_WORKBOOKS=1`** to restore loading all rows). Tune **`SHEETS_LINKED_MAX_ATTEMPTS`** / **`SHEETS_LINKED_BASE_DELAY_MS`** for heavier backoff. Raising **`SYLLABUS_CACHE_TTL_MS`** helps repeat runs. For sustained traffic, request a **higher Sheets API quota** in Google Cloud Console for the project tied to your service account.

## Syllabus workbook (Syllabus + optional Pattern tabs)

Use this when **one tab** (often named **`Syllabus`**) has **column A** = batch (dropdown), **B** = week (dropdown), **H** = syllabus text.

1. Enter the **exact tab name** that contains **A** (batch), **B** (week), and **H** (syllabus). In many workbooks this tab is literally named **`Syllabus`**. Use **Load tab names** to pull all sheet titles from the file and pick from suggestions.
2. Optional: **Pattern** tab — if your workbook has a **`Pattern`** (or similarly named) tab, enter it so **Claude** can use that grid as extra context when judging whether two syllabi match. Local heuristic does not read the Pattern tab.
3. Paste **batch lines** and **week lines** (for example `Batch - 6` … `Batch - 12`, and `Week - 13` … `Week - 1`). Numbers are taken from the **last** `123` group in each line so `Week - 13` resolves to week **13**.
4. **Find near-matching syllabus** compares column **H** for all included rows (with non-empty syllabus). It reports:
   - **Pairs above threshold**: two different rows whose syllabus text is similar enough (default **82%** combined score).
   - **Closest other row**: for every row, the single best match to another row’s syllabus (even below the threshold), with a **match %** number.

The score mixes normalized Levenshtein (character edits) with word-overlap (Jaccard), capped for very long text. Change **Minimum match %** in the UI if you want stricter or looser “almost matching”.

**Headers:** set **Rows to skip from top** if your table does not start on row 2 (default skips **1** header row).

### Optional: Claude (Anthropic) for semantic matching

1. Add to the **server** `.env` (same folder as `package.json`):

   ```env
   ANTHROPIC_API_KEY=sk-ant-api03-...
   # optional — override if your workspace uses a different model id
   ANTHROPIC_MODEL=claude-sonnet-4-20250514
   ```

2. Run `npm install` after pulling (adds `@anthropic-ai/sdk`).

3. In the UI, set **Match engine** to **Claude only** or **Both**. The API key stays on the server only — **do not** paste it into the React app or commit it to git.

Claude returns pairs it considers the same syllabus (minor wording OK) and a **similarity_0_to_100** score; pairs below **Minimum match % (Claude)** are dropped. Large syllabi are truncated per item (see `ANTHROPIC_MAX_CHARS_PER_SYLLABUS` / `ANTHROPIC_MAX_ITEMS` in `.env.example`).

**API:** `GET /api/spreadsheet/sheets?spreadsheetId=…` returns all tab titles. `POST /api/syllabus-match` accepts `sheetName` (tab with A/B/H), optional `syllabusSheetName` (override data tab if different from `sheetName`), and optional `patternSheetName` (Claude reference only).

## Prerequisites

1. **Google Cloud project** with **Google Sheets API** enabled.
2. **Service account** + JSON key file.
3. **Share the spreadsheet** with the service account email (shown in the JSON as `client_email`) with **Editor** access so the app can read batch tabs and update Config.

## Setup

```bash
cd batch-tracker-ui
npm install
```

Copy `.env.example` to `.env` and set `GOOGLE_APPLICATION_CREDENTIALS` to the path of your service account JSON, for example:

```env
GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
PORT=8787
```

Create a tab named **Config** (or whatever you set in the UI) in the spreadsheet before running **Update Config sheet** — the API only overwrites cell values; it does not create new tabs.

## Run

Terminal 1 (API):

```bash
npm run dev:server
```

Terminal 2 (UI), or use combined:

```bash
npm run dev
```

Open **http://localhost:5173**. Paste the spreadsheet URL or ID, list **exact tab names** for each batch, set column headers, then **Analyze batches** or **Update Config sheet**.

## Sheet layout tips

- **Batch tabs**: same structure on each tab — headers in row 1, including `B9W2` and `B10W2` (or your chosen pair).
- **Config tab**: the update replaces **A1:E** with a header row plus one row per batch tab you listed, with columns: `Batch`, `B9W2_vs_B10W2`, `Status`, `AlignedRows`, `UpdatedAt`.

## Security

Do not commit `service-account.json`, anything under `secrets/` except `secrets/.gitkeep`, or `.env`. Keep the JSON key private. The server loads `import "dotenv/config"` first, so variables in `.env` override defaults.

## Deploy on Render (free tier)

One **Web Service** runs the API and serves the built React app from the same URL (so `/api` works without CORS tricks).

### Fix “UI not built” / JSON on `/`

Render’s **Build Command** must run **`npm run build`** (Vite). **`npm install` alone does not create `client/dist`** — that is the usual cause of `{"error":"UI not built",...}`.

| **Root Directory** (Render → Settings) | **Build Command** (copy exactly) | **Start Command** |
|----------------------------------------|----------------------------------|-------------------|
| `batch-tracker-ui` | `npm ci && npm run build` | `npm start` |
| *(empty — repo root)* | `npm --prefix batch-tracker-ui ci && npm --prefix batch-tracker-ui run build` | `npm --prefix batch-tracker-ui start` |

After saving, trigger **Manual Deploy** → **Clear build cache & deploy** once. In **Logs**, confirm you see **`vite build`** and **`dist/`** output.

### 1. Prerequisites

- Repo on GitHub (e.g. `Intensive_Config-s` with `batch-tracker-ui/` inside).
- Google **service account** JSON (same as local). You will **not** upload the file to git; you add it in Render as a secret.

### 2. Create the service

1. Log in at [render.com](https://render.com) → **New +** → **Web Service**.
2. Connect **GitHub** and select your repository.
3. Configure:
   - **Name:** e.g. `batch-tracker-ui`
   - **Region:** closest to you
   - **Branch:** `main`
   - **Root Directory:** leave **empty** (repo root) **recommended** for this monorepo — then use the build/start commands below.  
     *Alternatively* set Root Directory to **`batch-tracker-ui`** and use the shorter commands in parentheses.
   - **Runtime:** Node
   - **Build Command:**  
     `npm --prefix batch-tracker-ui ci && npm --prefix batch-tracker-ui run build`  
     *(If Root Directory is `batch-tracker-ui`: `npm ci && npm run build`.)*  
     The build must create `batch-tracker-ui/client/dist/index.html` (or `client/dist/...` when cwd is that folder). Vite is a **dependency** so production `npm ci` still installs it.
   - **Start Command:**  
     `npm --prefix batch-tracker-ui start`  
     *(If Root Directory is `batch-tracker-ui`: `npm start`.)*
4. **Instance type:** Free (cold starts after idle are normal on the free tier).

**Where is “Master syllabus align”?** On the deployed site it is the page at **`/`** — your `https://…onrender.com/` with no path (not a separate `/app` URL). Locally run `npm run dev` in `batch-tracker-ui` and open **http://localhost:5173/**.

### 3. Environment variables (Environment tab)

Add as **Secret** where possible:

| Key | Value |
|-----|--------|
| **Either** `GOOGLE_SERVICE_ACCOUNT_JSON` | The **entire** service account JSON as **one line** (minified). Example: run `jq -c . < secrets/service-account.json` on Mac/Linux, or paste compact JSON from any JSON minifier. |
| **Or** `GOOGLE_APPLICATION_CREDENTIALS` | Path to a JSON file **only if** you also mount that file (e.g. Render secret file); otherwise prefer `GOOGLE_SERVICE_ACCOUNT_JSON`. |

Optional: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, and any tuning vars from `.env.example`.

Do **not** set `PORT` yourself — Render sets it; the server reads `process.env.PORT`.

### 4. Deploy

Click **Create Web Service**. Wait for build + deploy. Open the **`.onrender.com`** URL: you should see the UI; align and config copy should work if every Sheet is shared with the service account email from the JSON.

### 5. After deploy

- First request after sleep may take **30–60 seconds** on free tier.
- If the UI is blank, check deploy logs: `npm run build` must succeed so `client/dist/index.html` exists (the server serves that folder in production).

## Pushing to GitHub

1. Confirm nothing sensitive is tracked: `git status` should **not** list `.env`, `secrets/*.json`, or `node_modules/`. Those paths are in `.gitignore`.
2. If you ever committed a key by mistake, rotate the service account key in Google Cloud and use `git filter-repo` or BFG to purge history before pushing again.
3. Teammates clone the repo, run `cp .env.example .env` (or copy on Windows), place the service account JSON at `secrets/service-account.json` **or** set `GOOGLE_APPLICATION_CREDENTIALS` to any path outside the repo, then `npm install` and `npm run dev`.

```bash
git add -A
git status   # review: no .env, no secrets/*.json
git commit -m "Your message"
git remote add origin https://github.com/ORG/REPO.git   # once
git push -u origin main
```
