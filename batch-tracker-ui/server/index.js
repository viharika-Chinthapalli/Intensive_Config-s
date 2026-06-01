import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import { google } from "googleapis";
import path from "path";
import { fileURLToPath } from "url";
import { anthropicNearDuplicatePairs } from "./anthropicSyllabus.js";
import {
  alignSyllabusSearch,
  extractSyllabusSectionsByWeek,
  getSyllabusForWeek,
  extractSpreadsheetIdFromUrl,
  parseWeekHeaderFromRow,
  pickSyllabusWorkbookTab,
  workbookHasSyllabusAndPatternTabs,
} from "./syllabusMasterAlign.js";
import {
  clearSyllabusCache,
  getSyllabusCacheConfig,
  loadLinkedSyllabusWithCache,
} from "./syllabusCache.js";
import { copyConfigTemplateSheets } from "./copyConfigTemplateSheets.js";
import { withGoogleSheetsQuotaRetry } from "./googleSheetsRetry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

/** For Render etc.: paste full service account JSON in `GOOGLE_SERVICE_ACCOUNT_JSON`. Else use `GOOGLE_APPLICATION_CREDENTIALS` path or local `secrets/service-account.json`. */
function loadGoogleAuthOptions() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (rawJson && String(rawJson).trim()) {
    try {
      const credentials = JSON.parse(rawJson);
      return { credentials, clientEmail: credentials.client_email || null };
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON.");
    }
  }
  const keyFile =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(__dirname, "..", "secrets", "service-account.json");
  return { keyFile, credentials: null, clientEmail: null };
}

function getServiceAccountEmailForHints() {
  try {
    const o = loadGoogleAuthOptions();
    if (o.clientEmail) return o.clientEmail;
    const fp = o.keyFile;
    if (fp && fs.existsSync(fp)) {
      const j = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (j.client_email) return j.client_email;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** When Google returns 403 / PERMISSION_DENIED, point users at the exact email to share with. */
function googleSheetsPermissionHint(err) {
  const msg = String(err?.message || "").toLowerCase();
  const code = err?.code;
  const status = err?.response?.status;
  const denied =
    code === 403 ||
    status === 403 ||
    msg.includes("permission") ||
    msg.includes("caller does not have") ||
    msg.includes("insufficient permission");
  if (!denied) return null;

  const email = getServiceAccountEmailForHints();
  if (email) {
    return `Google blocked access. In each Sheet (the master tracker: column H syllabus links, column I config templates, and every linked workbook): Share → add ${email} → Viewer or Editor → Save. Retry after a few seconds.`;
  }
  return "Google blocked access. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON (full JSON) and share every spreadsheet with that account’s client_email.";
}

/** First error message from Sheets API JSON body (often more specific than Gaxios message). */
function googleSheetsApiReason(err) {
  const d = err?.response?.data?.error;
  if (!d) return null;
  return d.errors?.[0]?.message || d.message || null;
}

function getSheetsClient() {
  const o = loadGoogleAuthOptions();
  const auth = new google.auth.GoogleAuth(
    o.credentials
      ? {
          credentials: o.credentials,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        }
      : {
          keyFile: o.keyFile,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        }
  );

  return google.sheets({ version: "v4", auth });
}

/** First row = headers; returns { headers, rows: string[][] } */
function parseValues(values) {
  if (!values || values.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = (values[0] || []).map((h) => String(h ?? "").trim());
  const rows = values.slice(1).map((r) => r.map((c) => (c == null ? "" : String(c))));
  return { headers, rows };
}

function colIndex(headers, name) {
  const i = headers.findIndex((h) => h === name);
  return i;
}

/**
 * Compare B10W2 column vs B9W2 for each data row.
 * Alignment = same string value (after trim) for both cells in that row.
 */
function analyzeBatchSheet(headers, rows, baselineHeader, compareHeader) {
  const iBase = colIndex(headers, baselineHeader);
  const iCmp = colIndex(headers, compareHeader);
  if (iBase < 0 || iCmp < 0) {
    return {
      ok: false,
      error: `Missing column(s). Found headers: ${headers.join(", ")}. Need "${baselineHeader}" and "${compareHeader}".`,
      alignedRows: [],
      misalignedRows: [],
    };
  }

  const alignedRows = [];
  const misalignedRows = [];

  rows.forEach((row, idx) => {
    const lineNo = idx + 2; // 1-based sheet row (header is row 1)
    const vBase = String(row[iBase] ?? "").trim();
    const vCmp = String(row[iCmp] ?? "").trim();
    if (vBase === "" && vCmp === "") return;
    const firstCell = String(row[0] ?? "").trim() || `(row ${lineNo})`;
    if (vBase === vCmp) {
      alignedRows.push({ sheetRow: lineNo, label: firstCell, baseline: vBase, compare: vCmp });
    } else {
      misalignedRows.push({
        sheetRow: lineNo,
        label: firstCell,
        baseline: vBase,
        compare: vCmp,
      });
    }
  });

  return {
    ok: true,
    alignedRows,
    misalignedRows,
    summary: {
      alignedCount: alignedRows.length,
      misalignedCount: misalignedRows.length,
    },
  };
}

/**
 * Pull batch/week index from a dropdown label (handles "Batch - 6", "Week - 13", "6").
 * Uses the last number group so "Week - 13" is 13, not -13.
 */
function parseCellNumber(cell) {
  const s = String(cell ?? "").trim();
  if (!s) return NaN;
  const groups = s.match(/\d+/g);
  if (!groups || !groups.length) return NaN;
  return parseInt(groups[groups.length - 1], 10);
}

/** Parse `B3W8` / `B 3 W 8` → { batch, week } for master grid row lookup. */
function parseBatchWeekKey(key) {
  const m = String(key || "").match(/^B\s*(\d+)\s*W\s*(\d+)$/i);
  if (!m) return null;
  const batch = parseInt(m[1], 10);
  const week = parseInt(m[2], 10);
  if (!Number.isFinite(batch) || !Number.isFinite(week)) return null;
  return { batch, week };
}

function parseIdList(rawLines) {
  if (!rawLines || !Array.isArray(rawLines)) return [];
  return rawLines
    .map((line) => parseCellNumber(line))
    .filter((n) => !Number.isNaN(n));
}

function levenshteinRatio(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 1;
  if (!s.length || !t.length) return 0;
  const m = s.length;
  const n = t.length;
  if (m > 2000 || n > 2000) return wordJaccard(s, t);
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  const dist = dp[n];
  return 1 - dist / Math.max(m, n);
}

function wordJaccard(a, b) {
  const sa = new Set(
    String(a)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
  );
  const sb = new Set(
    String(b)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
  );
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function combinedSimilarity(a, b) {
  const r = levenshteinRatio(a, b);
  const j = wordJaccard(a, b);
  return Math.round((0.45 * r + 0.55 * j) * 1000) / 1000;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/** Escape single quotes in a sheet title for A1 notation. */
function escapeSheetTitle(title) {
  return String(title).replace(/'/g, "''");
}

/** Strip control chars / NBSP for comparing tab names to the client string. */
function normalizeSheetTabName(s) {
  return String(s || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

/**
 * If tab titles look like a per-batch config file (not the master tracker grid), add guidance.
 * @param {string[]} titles
 */
function hintIfTabListLooksLikeBatchConfigWorkbookNotTracker(titles) {
  if (!Array.isArray(titles) || titles.length === 0) return "";
  const lower = titles.map((x) => String(x).toLowerCase());
  const hasMockMainCfg =
    lower.some((x) => x.includes("mock assessment config")) &&
    lower.some((x) => x.includes("main assessment config"));
  const hasInterviewCfg =
    lower.some((x) => x.includes("mock interview config")) ||
    lower.some((x) => x.includes("main interview config"));
  const hasTestLinks = lower.some((x) => x.replace(/\s+/g, " ") === "test links" || x.includes("test links"));
  const looksLikeTracker = lower.some((x) =>
    /phase|status|tracker|master|cohort|intake|delivery|roadmap|syllabus/i.test(x)
  );
  const looksLikeConfigPack = hasMockMainCfg && (hasInterviewCfg || hasTestLinks);
  if (looksLikeConfigPack && !looksLikeTracker) {
    return " This file’s tabs look like a **batch config** workbook (Mock/Main Assessment Config, Interview Config, Test Links). That is not the master **tracker**. Use the **tracker** spreadsheet URL instead—the one with rows for each batch/week, a “Syllabus & Pattern” column with links to each batch’s Google file, and config/template links in the columns to the right (often column I and beyond). Then set **Master tab** to that tracker’s phase/status sheet (e.g. Phase1 - Status).";
  }
  return "";
}

/**
 * Resolve a user-entered tab title to the exact `properties.title` from the spreadsheet
 * (avoids "Unable to parse range" when hidden characters differ slightly).
 * @returns {{ ok: true, title: string, allTitles: string[] } | { ok: false, allTitles: string[], hint: string }}
 */
async function resolveWorksheetTitleForApiRequests(sheetsApi, spreadsheetId, requestedTitle) {
  const norm = normalizeSheetTabName(requestedTitle);
  if (!norm) {
    return { ok: false, allTitles: [], hint: "masterSheetName is empty." };
  }
  const { data } = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  const allTitles = (data.sheets || []).map((s) => s.properties?.title).filter(Boolean);
  let found = allTitles.find((t) => normalizeSheetTabName(t) === norm);
  if (!found) {
    found = allTitles.find(
      (t) => normalizeSheetTabName(t).toLowerCase() === norm.toLowerCase()
    );
  }
  if (!found) {
    const sample = allTitles.slice(0, 30).join(" · ");
    const wrongBookHint = hintIfTabListLooksLikeBatchConfigWorkbookNotTracker(allTitles);
    return {
      ok: false,
      allTitles,
      hint: `No worksheet tab matches "${requestedTitle}". Tabs in this file: ${sample}${allTitles.length > 30 ? " …" : ""}.${wrongBookHint}`,
    };
  }
  return { ok: true, title: found, allTitles };
}

/**
 * Tab grid size from the spreadsheet (ranges beyond this return "exceeds grid limits").
 * @returns {{ rowCount: number, columnCount: number } | null}
 */
async function getSheetGridBoundsForTitle(sheetsApi, spreadsheetId, sheetTitle) {
  try {
    const { data } = await sheetsApi.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(title,gridProperties))",
    });
    const sheet = (data.sheets || []).find((s) => s.properties?.title === sheetTitle);
    const gp = sheet?.properties?.gridProperties;
    const rowCount = gp?.rowCount;
    const columnCount = gp?.columnCount;
    if (typeof rowCount !== "number" || rowCount < 1) return null;
    if (typeof columnCount !== "number" || columnCount < 1) {
      return { rowCount, columnCount: 18278 };
    }
    return { rowCount, columnCount };
  } catch {
    return null;
  }
}

/** @param {number} wantZeroBasedLastColumn
 * @param {number | null | undefined} columnCount 1-based count from API
 */
function clampLastColumnIndexToGrid(wantZeroBasedLastColumn, columnCount) {
  if (typeof columnCount !== "number" || columnCount < 1) return wantZeroBasedLastColumn;
  return Math.min(wantZeroBasedLastColumn, columnCount - 1);
}
function colLetterFromIndex(zeroBased) {
  let n = zeroBased + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Scan order: detected “Syllabus & Pattern” column first, then neighbors (handles horizontal layout / insert columns). */
function syllabusColScanOrder(centerIdx, maxCol = 45) {
  const out = [];
  const seen = new Set();
  const push = (i) => {
    if (i < 0 || i > maxCol || seen.has(i)) return;
    seen.add(i);
    out.push(i);
  };
  push(centerIdx);
  for (let d = 1; d <= maxCol; d++) {
    push(centerIdx - d);
    push(centerIdx + d);
  }
  return out;
}

/**
 * Find 0-based column index of “Syllabus & Pattern” (or similar) from the header row.
 * Frozen / scrollable UI does not change API column order; insert columns do.
 */
async function detectSyllabusPatternColumnIndex(
  sheetsApi,
  spreadsheetId,
  sheetTitle,
  headerRow1Based,
  sheetColumnCount
) {
  const safe = escapeSheetTitle(sheetTitle);
  const row = Math.max(1, Number(headerRow1Based) || 1);
  const scanEndIdx = clampLastColumnIndexToGrid(51, sheetColumnCount);
  const rightLetter = colLetterFromIndex(scanEndIdx);
  try {
    const { data } = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${safe}'!A${row}:${rightLetter}${row}`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const cells = data.values?.[0] || [];
    for (let i = 0; i < cells.length; i++) {
      const t = String(cells[i] ?? "")
        .trim()
        .toLowerCase();
      if (!t) continue;
      if (t.includes("syllabus") && t.includes("pattern")) return i;
      if (/syllabus\s*&\s*pattern/.test(t)) return i;
    }
  } catch {
    /* fall through */
  }
  return 7;
}

async function fetchMasterRowSnapshotForApi(
  sheetsApi,
  spreadsheetId,
  sheetTitle,
  sheetRow,
  syllabusColIdx,
  sheetColumnCount
) {
  const safe = escapeSheetTitle(sheetTitle);
  const wantLast = Math.max(25, syllabusColIdx + 4);
  const lastIdx = clampLastColumnIndexToGrid(wantLast, sheetColumnCount);
  const right = colLetterFromIndex(lastIdx);
  const range = `'${safe}'!A${sheetRow}:${right}${sheetRow}`;
  const syllabusColumnLinkSpreadsheetId = await extractSheetLinkFromGridColumn(
    sheetsApi,
    spreadsheetId,
    sheetTitle,
    sheetRow,
    syllabusColIdx
  );
  const { data: dF } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: "FORMULA",
  });
  const { data: dV } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const fRow = dF.values?.[0] ?? [];
  const vRow = dV.values?.[0] ?? [];
  const maxL = Math.max(fRow.length, vRow.length, syllabusColIdx + 1);
  const columns = [];
  for (let i = 0; i < maxL; i++) {
    const formula = fRow[i] != null ? String(fRow[i]) : "";
    const formatted = vRow[i] != null ? String(vRow[i]) : "";
    if (!formula.trim() && !formatted.trim()) continue;
    columns.push({
      letter: colLetterFromIndex(i),
      index: i,
      isDetectedSyllabusColumn: i === syllabusColIdx,
      formula: formula.slice(0, 2000),
      formatted: formatted.slice(0, 2000),
    });
  }
  return {
    sheetRow,
    range,
    syllabusColumnIndex: syllabusColIdx,
    syllabusColumnLetter: colLetterFromIndex(syllabusColIdx),
    /** Set when Insert link / rich text hides URL behind display text (normal for this tracker). */
    syllabusColumnLinkSpreadsheetId,
    columns,
  };
}

/** Parse one or more B{b}W{w} targets from JSON body (array, multiline text, or legacy single fields). */
function normalizeAlignTargets(body) {
  const raw = body?.targets;
  if (Array.isArray(raw) && raw.length > 0) {
    const out = [];
    for (const t of raw) {
      const b = parseInt(String(t.batch ?? t.targetBatch ?? ""), 10);
      const w = parseInt(String(t.week ?? t.targetWeek ?? ""), 10);
      if (!Number.isNaN(b) && !Number.isNaN(w) && b >= 1 && w >= 1) out.push({ batch: b, week: w });
    }
    if (out.length) return out;
  }
  const text = String(body?.alignTargetsText ?? "").trim();
  if (text) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const L = line.trim();
      if (!L) continue;
      let m = L.match(/^B\s*(\d+)\s*W\s*(\d+)$/i);
      if (!m) m = L.match(/^(\d+)\s+(\d+)\s*$/);
      if (!m) m = L.match(/^(\d+)\s*,\s*(\d+)\s*$/);
      if (!m) m = L.match(/^(\d+)\s*\/\s*(\d+)\s*$/);
      if (m) out.push({ batch: parseInt(m[1], 10), week: parseInt(m[2], 10) });
    }
    if (out.length) return out;
  }
  const b = parseInt(String(body?.targetBatch ?? ""), 10);
  const w = parseInt(String(body?.targetWeek ?? ""), 10);
  return [{ batch: b, week: w }];
}

/** Log master row A–Z (formula + formatted) for the API server terminal. */
function logAlignSnapshotsToConsole(targetKey, snapshots) {
  console.log(`\n[align] rowSnapshots ${targetKey} (${snapshots.length} sheet row(s))`);
  for (const s of snapshots) {
    if (s.error) {
      console.log(`  sheetRow ${s.sheetRow}: ${s.error}`);
      continue;
    }
    const sid = s.syllabusColumnLinkSpreadsheetId ?? null;
    console.log(
      `  sheetRow ${s.sheetRow}  syllabusColumn=${s.syllabusColumnLetter ?? "?"}  syllabusColumnLinkSpreadsheetId=${sid ? JSON.stringify(sid) : "null"}`
    );
    for (const col of s.columns || []) {
      const f = col.formula || "";
      const v = col.formatted || "";
      if (!String(f).trim() && !String(v).trim()) continue;
      console.log(`    ${col.letter}${s.sheetRow} FORMULA=${JSON.stringify(String(f).slice(0, 900))}`);
      if (String(v).trim() !== String(f).trim()) {
        console.log(`           FORMATTED=${JSON.stringify(String(v).slice(0, 900))}`);
      }
    }
  }
  console.log(`[align] end ${targetKey}\n`);
}

/**
 * GET ?spreadsheetId=…
 * List tab titles in the spreadsheet (for picking Syllabus / Pattern).
 */
app.get("/api/spreadsheet/sheets", async (req, res) => {
  try {
    const spreadsheetId = String(req.query.spreadsheetId || "").trim();
    if (!spreadsheetId) {
      return res.status(400).json({ error: "Query parameter spreadsheetId is required." });
    }
    const sheets = getSheetsClient();
    const { data } = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "properties.title,sheets(properties(title,sheetId))",
    });
    const titles = (data.sheets || []).map((s) => s.properties?.title).filter(Boolean);
    res.json({ spreadsheetId, sheetTitles: titles });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: e.message || "Failed to list sheets",
      hint: "Share the spreadsheet with the service account (Editor).",
    });
  }
});

async function fetchSheetPlainGrid(sheetsApi, spreadsheetId, sheetTitle, maxChars = 14000) {
  const safe = escapeSheetTitle(sheetTitle);
  const { data } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `'${safe}'!A:ZZ`,
  });
  const values = data.values || [];
  const text = values.map((row) => row.join("\t")).join("\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated after ${maxChars} characters]`;
}
/**
 * Single tracker tab: column A = batch, B = week, H = syllabus.
 * Body: {
 *   spreadsheetId, sheetName,
 *   batches: number[] | string lines,
 *   weeks: number[] | string lines,
 *   minSimilarity?: 0-1 default 0.82,
 *   skipHeaderRows?: number default 1 (row 1 = headers)
 *   matchEngine?: "local" | "anthropic" | "both" — anthropic uses ANTHROPIC_API_KEY on the server
 *   minSimilarityLLM?: 0-100 default 78 — minimum Claude similarity to keep a pair
 *   syllabusSheetName?: optional tab name — if set, A/B/H are read from this tab (e.g. "Syllabus"); else uses sheetName
 *   patternSheetName?: optional tab (e.g. "Pattern") — text passed to Claude as reference only
 * }
 */
app.post("/api/syllabus-match", async (req, res) => {
  try {
    const {
      spreadsheetId,
      sheetName,
      syllabusSheetName,
      patternSheetName,
      batches: batchesInput,
      weeks: weeksInput,
      minSimilarity = 0.82,
      skipHeaderRows = 1,
      matchEngine = "local",
      minSimilarityLLM = 78,
    } = req.body || {};

    const dataTab = String(syllabusSheetName || "").trim() || String(sheetName || "").trim();
    if (!spreadsheetId || !dataTab) {
      return res.status(400).json({
        error: "spreadsheetId and a tab name are required (sheetName, or syllabusSheetName alone).",
      });
    }

    const batchSet = new Set(
      Array.isArray(batchesInput) ? parseIdList(batchesInput) : parseIdList(String(batchesInput).split(/\r?\n/))
    );
    const weekSet = new Set(
      Array.isArray(weeksInput) ? parseIdList(weeksInput) : parseIdList(String(weeksInput).split(/\r?\n/))
    );

    if (batchSet.size === 0 || weekSet.size === 0) {
      return res.status(400).json({
        error: "Provide at least one batch number and one week number (e.g. lines like 'Batch - 6' or just '6').",
      });
    }

    const engine = String(matchEngine || "local").toLowerCase();
    if (engine !== "local" && engine !== "anthropic" && engine !== "both") {
      return res.status(400).json({ error: 'matchEngine must be "local", "anthropic", or "both".' });
    }
    if (engine === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({
        error:
          'matchEngine is "anthropic" but ANTHROPIC_API_KEY is not set. Add it to the server .env (never put API keys in the browser).',
      });
    }

    const sheets = getSheetsClient();
    const safeSheet = escapeSheetTitle(dataTab);
    const range = `'${safeSheet}'!A:H`;
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    const values = data.values || [];
    const start = Math.max(0, Number(skipHeaderRows) || 0);
    const entries = [];

    for (let i = start; i < values.length; i++) {
      const row = values[i] || [];
      const batch = parseCellNumber(row[0]);
      const week = parseCellNumber(row[1]);
      if (Number.isNaN(batch) || Number.isNaN(week)) continue;
      if (!batchSet.has(batch) || !weekSet.has(week)) continue;
      const syllabus = String(row[7] ?? "").trim();
      const sheetRow = i + 1;
      const key = `B${batch}W${week}`;
      entries.push({
        key,
        sheetRow,
        batch,
        week,
        syllabus,
        syllabusPreview: syllabus.length > 160 ? `${syllabus.slice(0, 160)}…` : syllabus,
      });
    }

    const withText = entries.filter((e) => e.syllabus.length > 0);
    const missingSyllabus = entries.filter((e) => !e.syllabus.length).map((e) => ({ key: e.key, sheetRow: e.sheetRow }));
    const minPct = Math.min(1, Math.max(0, Number(minSimilarity) || 0.82));
    const rawLlm = Number(minSimilarityLLM);
    const minLlm = Number.isNaN(rawLlm) ? 78 : Math.min(100, Math.max(0, rawLlm));

    const pairsHeuristic = [];
    if (engine === "local" || engine === "both") {
      for (let i = 0; i < withText.length; i++) {
        for (let j = i + 1; j < withText.length; j++) {
          const a = withText[i];
          const b = withText[j];
          const score = combinedSimilarity(a.syllabus, b.syllabus);
          if (score >= minPct) {
            pairsHeuristic.push({
              a: { key: a.key, sheetRow: a.sheetRow, batch: a.batch, week: a.week },
              b: { key: b.key, sheetRow: b.sheetRow, batch: b.batch, week: b.week },
              matchScore: score,
              matchPercent: Math.round(score * 1000) / 10,
              source: "local",
            });
          }
        }
      }
      pairsHeuristic.sort((x, y) => y.matchScore - x.matchScore);
    }

    let patternContext = null;
    let patternSheetUsed = null;
    let patternLoadError = null;
    const patternTab = String(patternSheetName || "").trim();
    if (patternTab) {
      try {
        patternContext = await fetchSheetPlainGrid(sheets, spreadsheetId, patternTab);
        patternSheetUsed = patternTab;
      } catch (err) {
        patternLoadError = err instanceof Error ? err.message : String(err);
      }
    }

    let pairsAnthropic = [];
    let anthropicError = null;
    if ((engine === "anthropic" || engine === "both") && process.env.ANTHROPIC_API_KEY) {
      try {
        pairsAnthropic = await anthropicNearDuplicatePairs(withText, {
          minScore: minLlm,
          patternContext,
          patternSheetTitle: patternSheetUsed,
        });
      } catch (err) {
        anthropicError = err instanceof Error ? err.message : String(err);
        if (engine === "anthropic") {
          return res.status(502).json({
            error: anthropicError,
            hint: "Check ANTHROPIC_API_KEY, ANTHROPIC_MODEL, and billing on your Anthropic account.",
          });
        }
      }
    } else if (engine === "both" && !process.env.ANTHROPIC_API_KEY) {
      anthropicError = "ANTHROPIC_API_KEY not set; skipped Claude pass.";
    }

    const bestNeighbor = new Map();
    for (const e of withText) {
      let best = null;
      let bestScore = -1;
      for (const o of withText) {
        if (o === e) continue;
        const sc = combinedSimilarity(e.syllabus, o.syllabus);
        if (sc > bestScore) {
          bestScore = sc;
          best = o;
        }
      }
      if (best && bestScore >= 0) {
        bestNeighbor.set(`${e.sheetRow}`, {
          key: e.key,
          sheetRow: e.sheetRow,
          closestOther: best.key,
          closestOtherRow: best.sheetRow,
          matchScore: bestScore,
          matchPercent: Math.round(bestScore * 1000) / 10,
        });
      }
    }

    res.json({
      spreadsheetId,
      sheetName: sheetName || dataTab,
      dataSheetUsed: dataTab,
      syllabusSheetName: String(syllabusSheetName || "").trim() || null,
      patternSheetUsed,
      patternLoadError,
      patternContextChars: patternContext ? patternContext.length : 0,
      matchEngine: engine,
      batchSet: [...batchSet].sort((a, b) => a - b),
      weekSet: [...weekSet].sort((a, b) => a - b),
      minSimilarity: minPct,
      minSimilarityLLM: minLlm,
      rowCountScanned: values.length - start,
      entriesIncluded: entries.length,
      entriesWithSyllabus: withText.length,
      missingSyllabus,
      entries: entries.map((e) => ({
        key: e.key,
        sheetRow: e.sheetRow,
        batch: e.batch,
        week: e.week,
        hasSyllabus: e.syllabus.length > 0,
        syllabusPreview: e.syllabusPreview,
      })),
      nearMatchPairsHeuristic: pairsHeuristic,
      nearMatchPairsAnthropic: pairsAnthropic,
      anthropicError,
      nearMatchPairs: engine === "anthropic" ? pairsAnthropic : pairsHeuristic,
      closestPerRow: [...bestNeighbor.values()].sort((x, y) => y.matchScore - x.matchScore),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: e.message || "Syllabus match failed",
      hint: "Share the spreadsheet with your service account (Editor). Check tab name and columns A, B, H.",
    });
  }
});

/**
 * Body: {
 *   spreadsheetId: string,
 *   batchSheetNames: string[],
 *   baselineHeader: "B9W2",
 *   compareHeader: "B10W2",
 *   configSheetName?: "Config",
 *   configBatchColumnHeader?: "Batch" | first column if omitted
 * }
 */
app.post("/api/analyze", async (req, res) => {
  try {
    const {
      spreadsheetId,
      batchSheetNames = [],
      baselineHeader = "B9W2",
      compareHeader = "B10W2",
    } = req.body || {};

    if (!spreadsheetId || !Array.isArray(batchSheetNames) || batchSheetNames.length === 0) {
      return res.status(400).json({
        error: "spreadsheetId and non-empty batchSheetNames[] are required.",
      });
    }

    const sheets = getSheetsClient();
    const results = [];

    for (const sheetTitle of batchSheetNames) {
      const range = `'${sheetTitle.replace(/'/g, "''")}'!A:ZZ`;
      const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });
      const { headers, rows } = parseValues(data.values);
      const analysis = analyzeBatchSheet(headers, rows, baselineHeader, compareHeader);
      results.push({
        sheetTitle,
        headers,
        ...analysis,
      });
    }

    const aligningSheets = results.filter((r) => r.ok && r.summary?.alignedCount > 0 && r.summary?.misalignedCount === 0);
    const partial = results.filter((r) => r.ok && r.summary?.misalignedCount > 0);

    res.json({
      spreadsheetId,
      baselineHeader,
      compareHeader,
      results,
      aligningBatchSheets: aligningSheets.map((r) => r.sheetTitle),
      sheetsWithMisalignment: partial.map((r) => ({
        sheetTitle: r.sheetTitle,
        misalignedRows: r.misalignedRows,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: e.message || "Analyze failed",
      hint: "Share the spreadsheet with your service account email (Editor) and check GOOGLE_APPLICATION_CREDENTIALS.",
    });
  }
});

/**
 * Writes/merges Config tab: columns Batch | Status | MatchedWith | Notes
 * Body: { spreadsheetId, configSheetName, baselineHeader, compareHeader, batchSheetNames }
 */
app.post("/api/update-config", async (req, res) => {
  try {
    const {
      spreadsheetId,
      configSheetName = "Config",
      batchSheetNames = [],
      baselineHeader = "B9W2",
      compareHeader = "B10W2",
    } = req.body || {};

    if (!spreadsheetId || !batchSheetNames.length) {
      return res.status(400).json({ error: "spreadsheetId and batchSheetNames required." });
    }

    const sheets = getSheetsClient();

    // Re-run analysis
    const perSheet = [];
    for (const sheetTitle of batchSheetNames) {
      const range = `'${sheetTitle.replace(/'/g, "''")}'!A:ZZ`;
      const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });
      const { headers, rows } = parseValues(data.values);
      const analysis = analyzeBatchSheet(headers, rows, baselineHeader, compareHeader);
      const fullyAligned =
        analysis.ok &&
        analysis.summary.misalignedCount === 0 &&
        analysis.summary.alignedCount > 0;
      perSheet.push({
        sheetTitle,
        fullyAligned,
        analysis,
      });
    }

    const headerRow = ["Batch", "B9W2_vs_B10W2", "Status", "AlignedRows", "UpdatedAt"];
    const now = new Date().toISOString();
    const dataRows = perSheet.map((p) => {
      const status = !p.analysis.ok
        ? "ERROR"
        : p.fullyAligned
          ? "ALIGNED"
          : p.analysis.summary.misalignedCount > 0
            ? "MISALIGNED"
            : "NO_DATA";
      const alignedCount = p.analysis.ok ? p.analysis.summary.alignedCount : 0;
      return [
        p.sheetTitle,
        `${baselineHeader}↔${compareHeader}`,
        status,
        String(alignedCount),
        now,
      ];
    });

    const values = [headerRow, ...dataRows];
    const safeName = configSheetName.replace(/'/g, "''");
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${safeName}'!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    res.json({
      ok: true,
      configSheetName,
      rowsWritten: values.length,
      aligningBatchSheets: perSheet.filter((p) => p.fullyAligned).map((p) => p.sheetTitle),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: e.message || "Update failed",
      hint: "Ensure a tab named exactly as configSheetName exists, or create empty 'Config' sheet first.",
    });
  }
});

/** Grid fields for Insert link cells (display text in UI, URL in hyperlink / rich text / format). */
const GRID_CELL_FIELDS =
  "sheets(data(startRow,rowData(values(userEnteredValue,formattedValue,hyperlink,textFormatRuns,userEnteredFormat,effectiveFormat,chipRuns))))";

function extractSheetLinkIdFromRowValues(rawVals, syllabusColIdx = 7) {
  const v = [...(rawVals || [])];
  const need = Math.max(syllabusColIdx + 4, 16);
  while (v.length < need) v.push(null);
  for (const col of syllabusColScanOrder(syllabusColIdx)) {
    if (col >= v.length) continue;
    const id = extractSheetLinkIdFromGridCell(v[col]);
    if (id) return id;
  }
  return null;
}

function linkUriFromFormat(fmt) {
  return fmt?.link?.uri || fmt?.textFormat?.link?.uri || null;
}

/**
 * Full-column grid pass for the Syllabus & Pattern column — reliable for Insert link
 * (“replace with text”) where values.get shows only the label, not the URL.
 */
async function mergeSyllabusColumnLinksFromGrid(
  sheetsApi,
  spreadsheetId,
  sheetTitle,
  firstRow1Based,
  lastRow1Based,
  rows,
  syllabusColIdx
) {
  const safe = escapeSheetTitle(sheetTitle);
  const colLet = colLetterFromIndex(syllabusColIdx);
  try {
    const { data } = await sheetsApi.spreadsheets.get({
      spreadsheetId,
      ranges: [`'${safe}'!${colLet}${firstRow1Based}:${colLet}${lastRow1Based}`],
      includeGridData: true,
      fields: GRID_CELL_FIELDS,
    });
    const g = data?.sheets?.[0]?.data?.[0];
    const rowData = g?.rowData || [];
    const startRow0 = typeof g?.startRow === "number" ? g.startRow : firstRow1Based - 1;
    const byRow = new Map(rows.map((r) => [r.sheetRow, r]));
    for (let i = 0; i < rowData.length; i++) {
      const sheetRow = startRow0 + i + 1;
      const cell = rowData[i]?.values?.[0];
      const id = extractSheetLinkIdFromGridCell(cell);
      if (!id) continue;
      const rec = byRow.get(sheetRow);
      if (rec) rec.linkId = id;
    }
  } catch {
    /* formula / row fallback still runs */
  }
}

/** Merge Insert-link ids from a single master column into grid rows (field name on each row). */
async function mergeSheetLinkColumnIntoGridRows(
  sheetsApi,
  spreadsheetId,
  sheetTitle,
  firstRow1Based,
  lastRow1Based,
  rows,
  colIdx,
  fieldName
) {
  const safe = escapeSheetTitle(sheetTitle);
  const colLet = colLetterFromIndex(colIdx);
  try {
    const { data } = await sheetsApi.spreadsheets.get({
      spreadsheetId,
      ranges: [`'${safe}'!${colLet}${firstRow1Based}:${colLet}${lastRow1Based}`],
      includeGridData: true,
      fields: GRID_CELL_FIELDS,
    });
    const g = data?.sheets?.[0]?.data?.[0];
    const rowData = g?.rowData || [];
    const startRow0 = typeof g?.startRow === "number" ? g.startRow : firstRow1Based - 1;
    const byRow = new Map(rows.map((r) => [r.sheetRow, r]));
    for (let i = 0; i < rowData.length; i++) {
      const sheetRow = startRow0 + i + 1;
      const cell = rowData[i]?.values?.[0];
      const id = extractSheetLinkIdFromGridCell(cell);
      if (!id) continue;
      const rec = byRow.get(sheetRow);
      if (rec) rec[fieldName] = id;
    }
  } catch {
    /* ignore */
  }
}

async function mergeConfigWorkbookLinksFromGrid(
  sheetsApi,
  spreadsheetId,
  sheetTitle,
  firstRow1Based,
  lastRow1Based,
  rows,
  configColIdx
) {
  await mergeSheetLinkColumnIntoGridRows(
    sheetsApi,
    spreadsheetId,
    sheetTitle,
    firstRow1Based,
    lastRow1Based,
    rows,
    configColIdx,
    "configLinkId"
  );
}

async function mergeConfigDestinationLinksFromGrid(
  sheetsApi,
  spreadsheetId,
  sheetTitle,
  firstRow1Based,
  lastRow1Based,
  rows,
  destinationColIdx
) {
  await mergeSheetLinkColumnIntoGridRows(
    sheetsApi,
    spreadsheetId,
    sheetTitle,
    firstRow1Based,
    lastRow1Based,
    rows,
    destinationColIdx,
    "configDestinationLinkId"
  );
}

/** Master row nav labels (F–K etc.) that are not syllabus workbook links. */
function cellLooksLikeNonSyllabusNavLabel(formula, formatted) {
  const t = `${formula || ""} ${formatted || ""}`;
  if (/https:\/\/docs\.google\.com\/spreadsheets/i.test(t)) return false;
  return /student\s*data|seating\s*structure|mock\s*&\s*main|ops\s*tracker|main\s*assessment\s*&|interview\s*results|mock\s*assessment|mock\s*interview/i.test(
    t
  );
}

function cellTextMentionsSyllabus(text) {
  return /syllabus/i.test(String(text || ""));
}

/** Only Syllabus & Pattern column (and neighbors in scan order), never naked URLs from Z / results columns. */
function extractSyllabusWorkbookIdFromMasterRowCells(cells, syllabusColIdx) {
  const row = cells || [];
  for (const col of syllabusColScanOrder(syllabusColIdx)) {
    if (col >= row.length) continue;
    const id = extractSheetLinkIdFromFormulaString(row[col]);
    if (id) return { id, sourceCol: col };
  }
  for (let col = 0; col < row.length; col++) {
    const f = String(row[col] ?? "").trim();
    if (!f || !cellTextMentionsSyllabus(f)) continue;
    const id = extractSheetLinkIdFromFormulaString(f);
    if (id) return { id, sourceCol: col };
  }
  return null;
}

/** Plain URL on the row that is not from the Syllabus & Pattern column (e.g. results link in Z). */
async function findIgnoredNonSyllabusSpreadsheetOnRow(
  sheetsApi,
  spreadsheetId,
  sheetTitle,
  sheetRow,
  syllabusColIdx
) {
  const safe = escapeSheetTitle(sheetTitle);
  try {
    const { data } = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${safe}'!A${sheetRow}:AZ${sheetRow}`,
      valueRenderOption: "FORMULA",
    });
    const cells = data.values?.[0] || [];
    for (let col = 0; col < cells.length; col++) {
      if (col === syllabusColIdx) continue;
      const f = String(cells[col] ?? "").trim();
      const id = extractSpreadsheetIdFromUrl(f) || extractSheetLinkIdFromFormulaString(f);
      if (!id) continue;
      if (cellTextMentionsSyllabus(f)) continue;
      return { spreadsheetId: id, column: colLetterFromIndex(col) };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function linkedWorkbookLooksLikeResultsNotSyllabus(tabs) {
  if (!tabs?.length) return false;
  if (pickSyllabusWorkbookTab(tabs, "Syllabus")) return false;
  return tabs.some((t) => /mock|interview|result/i.test(t));
}

function cellTextIsSyllabusPatternNav(text) {
  return /syllabus\s*&\s*pattern/i.test(String(text || ""));
}

/** Grid read on F–K band for the row: Syllabus & Pattern label cell (Insert link). */
async function extractSyllabusLinkFromRowNavBand(
  sheetsApi,
  spreadsheetId,
  sheetTitle,
  sheetRow,
  syllabusColIdx
) {
  const lo = Math.max(0, syllabusColIdx - 2);
  const hi = Math.min(51, syllabusColIdx + 2);
  const safe = escapeSheetTitle(sheetTitle);
  const range = `'${safe}'!${colLetterFromIndex(lo)}${sheetRow}:${colLetterFromIndex(hi)}${sheetRow}`;
  try {
    const { data } = await sheetsApi.spreadsheets.get({
      spreadsheetId,
      ranges: [range],
      includeGridData: true,
      fields: GRID_CELL_FIELDS,
    });
    const vals = data?.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || [];
    for (let i = 0; i < vals.length; i++) {
      const col = lo + i;
      const cell = vals[i];
      const text = gridCellText(cell);
      if (col !== syllabusColIdx && !cellTextIsSyllabusPatternNav(text)) continue;
      const id = extractSheetLinkIdFromGridCell(cell);
      if (id) return id;
    }
  } catch {
    return null;
  }
  return null;
}

async function extractSheetLinkFromGridColumn(sheetsApi, spreadsheetId, sheetTitle, sheetRow, colIdx) {
  const safe = escapeSheetTitle(sheetTitle);
  const col = colLetterFromIndex(colIdx);
  try {
    const { data } = await sheetsApi.spreadsheets.get({
      spreadsheetId,
      ranges: [`'${safe}'!${col}${sheetRow}:${col}${sheetRow}`],
      includeGridData: true,
      fields: GRID_CELL_FIELDS,
    });
    const cell = data?.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0];
    return extractSheetLinkIdFromGridCell(cell);
  } catch {
    return null;
  }
}

/**
 * Resolve syllabus workbook ID from the Syllabus & Pattern column only (Insert link / HYPERLINK / merge above).
 * Does not use column Z or other plain URLs (those are often Mock/Results trackers).
 */
async function resolveMasterRowSyllabusLinkId(sheetsApi, spreadsheetId, sheetTitle, sheetRow, syllabusColIdx) {
  const safe = escapeSheetTitle(sheetTitle);
  let id = await extractSheetLinkFromGridColumn(
    sheetsApi,
    spreadsheetId,
    sheetTitle,
    sheetRow,
    syllabusColIdx
  );
  if (id) return id;

  const colLet = colLetterFromIndex(syllabusColIdx);
  try {
    const { data } = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${safe}'!${colLet}${sheetRow}:${colLet}${sheetRow}`,
      valueRenderOption: "FORMULA",
    });
    id = extractSheetLinkIdFromFormulaString(data.values?.[0]?.[0]);
    if (id) return id;
  } catch {
    /* continue */
  }

  for (let u = 1; u <= 25; u++) {
    const sr = sheetRow - u;
    if (sr < 2) break;
    id = await extractSheetLinkFromGridColumn(sheetsApi, spreadsheetId, sheetTitle, sr, syllabusColIdx);
    if (id) return id;
    try {
      const { data } = await sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range: `'${safe}'!${colLet}${sr}:${colLet}${sr}`,
        valueRenderOption: "FORMULA",
      });
      id = extractSheetLinkIdFromFormulaString(data.values?.[0]?.[0]);
      if (id) return id;
    } catch {
      /* try next */
    }
  }

  return (
    (await extractSyllabusLinkFromRowNavBand(
      sheetsApi,
      spreadsheetId,
      sheetTitle,
      sheetRow,
      syllabusColIdx
    )) || null
  );
}

async function loadLinkedSyllabusSectionsWithMeta(sheetsApi, spreadsheetId, preferredTabName) {
  const retryOpts = () => ({
    maxAttempts: Math.min(24, Math.max(8, Number(process.env.SHEETS_LINKED_MAX_ATTEMPTS) || 14)),
    baseDelayMs: Math.max(1000, Number(process.env.SHEETS_LINKED_BASE_DELAY_MS) || 2400),
  });
  const meta = {
    spreadsheetId,
    preferredTabName,
    tabTitle: null,
    availableTabs: [],
    weeks: [],
    rowCount: 0,
    error: null,
    weekHeaderSamples: [],
  };
  try {
    const { data } = await withGoogleSheetsQuotaRetry(
      `linked workbook tabs ${spreadsheetId}`,
      () =>
        sheetsApi.spreadsheets.get({
          spreadsheetId,
          fields: "sheets.properties.title",
        }),
      retryOpts()
    );
    meta.availableTabs = (data.sheets || []).map((s) => s.properties?.title).filter(Boolean);
    meta.hasSyllabusAndPatternTabs = workbookHasSyllabusAndPatternTabs(meta.availableTabs);
    const want = String(preferredTabName || "Syllabus").trim();
    const tabTitle = pickSyllabusWorkbookTab(meta.availableTabs, want);
    if (!tabTitle) {
      const tabList = meta.availableTabs.slice(0, 15).join(", ") || "(none)";
      if (linkedWorkbookLooksLikeResultsNotSyllabus(meta.availableTabs)) {
        meta.error =
          `Linked workbook is not a Syllabus & Pattern file (tabs: ${tabList}). It looks like Mock/Interview results. ` +
          `Use Insert link in column H (“Syllabus & Pattern”) to the batch workbook that has Syllabus and Pattern sub-sheets.`;
        meta.wrongWorkbookKind = "mock_or_results";
      } else {
        meta.error =
          `No "${want}" sub-sheet in linked workbook (tabs: ${tabList}). ` +
          `Batch files from Syllabus & Pattern usually include Syllabus and Pattern — alignment reads the Syllabus tab only.`;
      }
      return { sections: { byWeek: new Map(), fallbackAll: "" }, meta };
    }
    meta.tabTitle = tabTitle;
    const safeTab = escapeSheetTitle(tabTitle);
    const { data: sData } = await withGoogleSheetsQuotaRetry(
      `linked syllabus A:ZZ ${spreadsheetId} ${tabTitle}`,
      () =>
        sheetsApi.spreadsheets.values.get({
          spreadsheetId,
          range: `'${safeTab}'!A:ZZ`,
        }),
      retryOpts()
    );
    const values = sData.values || [];
    meta.rowCount = values.length;
    const sections = extractSyllabusSectionsByWeek(values);
    meta.weeks = [...sections.byWeek.keys()].sort((a, b) => a - b);
    for (const row of values) {
      const wk = parseWeekHeaderFromRow(row);
      if (wk == null) continue;
      if (!meta.weekHeaderSamples.some((s) => s.week === wk)) {
        const bits = [];
        for (let j = 0; j < 4 && j < (row || []).length; j++) {
          const t = String(row[j] ?? "").trim();
          if (t) bits.push(t);
        }
        meta.weekHeaderSamples.push({ week: wk, sample: bits.join(" | ").slice(0, 160) });
      }
      if (meta.weekHeaderSamples.length >= 20) break;
    }
    return { sections, meta };
  } catch (err) {
    meta.error = err instanceof Error ? err.message : String(err);
    return { sections: { byWeek: new Map(), fallbackAll: "" }, meta };
  }
}

/** First quoted string in HYPERLINK("...", ...) or HYPERLINK('...', ...) (common when API omits cell.hyperlink). */
function firstQuotedUrlFromHyperlinkFormula(formula) {
  const f = String(formula || "");
  if (!/HYPERLINK\s*\(/i.test(f)) return null;
  const m1 = f.match(/HYPERLINK\s*\(\s*"((?:[^"\\]|\\.)*)"/i);
  if (m1?.[1]) return m1[1].replace(/\\"/g, '"');
  const m2 = f.match(/HYPERLINK\s*\(\s*'((?:[^'\\]|\\.)*)'/i);
  if (m2?.[1]) return m2[1].replace(/\\'/g, "'");
  return null;
}

/** Any docs spreadsheet URL embedded in a formula string. */
function extractDocsUrlFromFormulaString(formula) {
  const f = String(formula || "");
  const m = f.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9-_]+(?:\/[^\s"'`)]*)?/);
  return m ? m[0] : null;
}

/**
 * Keys B{b}W{w} whose linked syllabi align may read (targets + older batches × relevant weeks).
 * Skips the rest of the master grid to cut Sheets read quota. Set env ALIGN_LOAD_ALL_SYLLABUS_WORKBOOKS=1 to disable.
 * @param {{ batchCell: string, weekCell: string }[]} gridRows
 * @param {{ batch: number, week: number }[]} targets
 */
function buildRequiredSyllabusKeysForAlign(gridRows, targets, maxWeekLim) {
  if (process.env.ALIGN_LOAD_ALL_SYLLABUS_WORKBOOKS === "1") return null;
  const keys = new Set();
  for (const t of targets) {
    keys.add(`B${t.batch}W${t.week}`);
    const weekSet = new Set([t.week]);
    for (const gr of gridRows) {
      const b = parseCellNumber(gr.batchCell);
      const w = parseCellNumber(gr.weekCell);
      if (Number.isNaN(b) || Number.isNaN(w)) continue;
      if (b < t.batch && w >= 1 && w <= maxWeekLim) weekSet.add(w);
    }
    for (let b = 1; b < t.batch; b++) {
      for (const w of weekSet) {
        keys.add(`B${b}W${w}`);
      }
    }
  }
  return keys;
}

/**
 * Spreadsheet ID from Syllabus & Pattern CellData.
 * Insert link → custom display text (e.g. "B5 || Syllabus & Pattern || Apr 18"); URL lives in
 * cell.hyperlink, rich-text runs, or format — not in values.get FORMULA output.
 */
function extractSheetLinkIdFromGridCell(cell) {
  if (!cell) return null;
  let id =
    extractSpreadsheetIdFromUrl(cell.hyperlink) ||
    extractSpreadsheetIdFromUrl(linkUriFromFormat(cell.userEnteredFormat)) ||
    extractSpreadsheetIdFromUrl(linkUriFromFormat(cell.effectiveFormat)) ||
    extractSpreadsheetIdFromUrl(cell.formattedValue) ||
    extractSpreadsheetIdFromUrl(gridCellText(cell));
  if (id) return id;
  const fu = cell.userEnteredValue?.formulaValue;
  if (typeof fu === "string") {
    const quoted = firstQuotedUrlFromHyperlinkFormula(fu);
    id = extractSpreadsheetIdFromUrl(quoted) || extractSpreadsheetIdFromUrl(extractDocsUrlFromFormulaString(fu));
    if (id) return id;
  }
  const runLists = [
    cell.userEnteredValue?.richTextValue?.runs,
    cell.textFormatRuns,
    cell.effectiveFormat?.textFormatRuns,
    cell.userEnteredFormat?.textFormatRuns,
  ];
  for (const runs of runLists) {
    if (!Array.isArray(runs)) continue;
    for (const run of runs) {
      id = extractSpreadsheetIdFromUrl(run?.format?.link?.uri);
      if (id) return id;
    }
  }
  const chipRuns = cell.chipRuns;
  if (Array.isArray(chipRuns)) {
    for (const run of chipRuns) {
      const chip = run?.chip;
      const uri = chip?.linkChipProperties?.uri || chip?.richLinkProperties?.uri;
      id = extractSpreadsheetIdFromUrl(uri);
      if (id) return id;
    }
  }
  return null;
}

/** Spreadsheet ID from a raw formula string (values.get … FORMULA). */
function extractSheetLinkIdFromFormulaString(formula) {
  const f = String(formula || "").trim();
  if (!f) return null;
  const direct = extractSpreadsheetIdFromUrl(f);
  if (direct) return direct;
  return extractSheetLinkIdFromGridCell({ userEnteredValue: { formulaValue: f } });
}

/**
 * Grid read sometimes omits hyperlink / formula on column H. A second values.get with
 * FORMULA returns =HYPERLINK("https://…", "label") even when CellData is sparse.
 * Uses response.range to align rows when leading empty H rows are omitted.
 */
async function mergeColumnHFormulasIntoGridRows(
  sheetsApi,
  spreadsheetId,
  sheetTitle,
  firstRow1Based,
  lastRow1Based,
  rows,
  syllabusColIdx
) {
  const formulaBySheetRow = new Map();
  const safe = escapeSheetTitle(sheetTitle);
  const colLet = colLetterFromIndex(syllabusColIdx);
  try {
    const { data } = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `'${safe}'!${colLet}${firstRow1Based}:${colLet}${lastRow1Based}`,
      valueRenderOption: "FORMULA",
    });
    const values = data.values || [];
    let startRow = firstRow1Based;
    const rangeStr = String(data.range || "");
    const rm = rangeStr.match(/![A-Za-z]+(\d+)/);
    if (rm) startRow = parseInt(rm[1], 10);
    const byRow = new Map(rows.map((r) => [r.sheetRow, r]));
    for (let j = 0; j < values.length; j++) {
      const sheetRow = startRow + j;
      const f = String(values[j]?.[0] ?? "").trim();
      if (f) formulaBySheetRow.set(sheetRow, f);
      const rec = byRow.get(sheetRow);
      if (!rec || rec.linkId) continue;
      const id = extractSheetLinkIdFromFormulaString(f);
      if (id) rec.linkId = id;
    }
  } catch {
    /* ignore; grid-only path still runs */
  }
  return formulaBySheetRow;
}

/**
 * Vertically merged column H: only the merge anchor row has link data; continuation rows
 * look empty in the API. Walk upward within the same batch until a column H link is found.
 */
function inheritColumnHFromMergedAbove(out, rowData, startRow0, formulaBySheetRow, syllabusColIdx, maxLookback = 120) {
  for (let i = 0; i < out.length; i++) {
    const rec = out[i];
    if (rec.linkId) continue;
    const tb = parseCellNumber(rec.batchCell);
    for (let depth = 1; depth <= maxLookback; depth++) {
      const prevSr = rec.sheetRow - depth;
      const kPrev = prevSr - startRow0 - 1;
      if (kPrev < 0 || kPrev >= rowData.length) break;

      const prevVals = [...(rowData[kPrev]?.values || [])];
      const pad = Math.max(11, syllabusColIdx + 4);
      while (prevVals.length < pad) prevVals.push(null);
      const prevBatch = parseCellNumber(gridCellText(prevVals[0]));
      const prevA = String(gridCellText(prevVals[0]) || "").trim();
      if (
        prevA.length > 0 &&
        !Number.isNaN(tb) &&
        !Number.isNaN(prevBatch) &&
        prevBatch !== tb
      ) {
        break;
      }

      let id = extractSheetLinkIdFromRowValues(prevVals, syllabusColIdx);
      if (!id && formulaBySheetRow && formulaBySheetRow.size > 0) {
        const f = formulaBySheetRow.get(prevSr);
        if (f) id = extractSheetLinkIdFromFormulaString(f);
      }
      if (id) {
        rec.linkId = id;
        break;
      }
    }
  }
}

/** Re-resolve target row link from Syllabus & Pattern column only; clear mistaken Z/results URLs. */
async function patchLinkIdForTargetRows(sheetsApi, spreadsheetId, sheetTitle, gridRows, tb, tw, syllabusColIdx) {
  const targets = gridRows.filter(
    (r) => parseCellNumber(r.batchCell) === tb && parseCellNumber(r.weekCell) === tw
  );
  for (const rec of targets) {
    rec.linkId =
      (await resolveMasterRowSyllabusLinkId(
        sheetsApi,
        spreadsheetId,
        sheetTitle,
        rec.sheetRow,
        syllabusColIdx
      )) || null;
  }
}

/** Plain text from a grid cell (CellData), for batch/week display strings. */
function gridCellText(cell) {
  if (!cell) return "";
  if (cell.formattedValue != null && String(cell.formattedValue).trim() !== "") {
    return String(cell.formattedValue).trim();
  }
  const ue = cell.userEnteredValue;
  if (!ue) return "";
  if (ue.stringValue != null) return String(ue.stringValue).trim();
  if (ue.numberValue != null) return String(ue.numberValue);
  if (ue.boolValue != null) return String(ue.boolValue);
  return "";
}

/**
 * Read master grid from column A through the detected syllabus column (+ buffer).
 * Column index comes from the header row (“Syllabus & Pattern”), not a hardcoded H.
 */
async function fetchMasterTrackerRowsGrid(
  sheetsApi,
  spreadsheetId,
  sheetTitle,
  firstRow1Based,
  lastRowRequested,
  syllabusColIdx,
  gridBounds
) {
  const safe = escapeSheetTitle(sheetTitle);
  const rowCap = gridBounds?.rowCount;
  const lastRow1Based = Math.min(
    lastRowRequested,
    typeof rowCap === "number" && rowCap > 0 ? rowCap : lastRowRequested
  );
  const endColIdx = clampLastColumnIndexToGrid(
    Math.max(syllabusColIdx + 3, 25),
    gridBounds?.columnCount
  );
  const endLetter = colLetterFromIndex(endColIdx);
  const rowSpan = lastRow1Based - firstRow1Based + 1;
  const chunkRows = Math.min(
    500,
    Math.max(50, Math.floor(Number(process.env.MASTER_GRID_INCLUDE_CHUNK_ROWS) || 380))
  );

  let rowData = [];
  if (rowSpan <= chunkRows) {
    const { data } = await sheetsApi.spreadsheets.get({
      spreadsheetId,
      ranges: [`'${safe}'!A${firstRow1Based}:${endLetter}${lastRow1Based}`],
      includeGridData: true,
      fields: GRID_CELL_FIELDS.replace("sheets(data(startRow,", "sheets(data(startRow,startColumn,"),
    });
    const g = data?.sheets?.[0]?.data?.[0];
    rowData = g?.rowData || [];
  } else {
    for (let chunkStart = firstRow1Based; chunkStart <= lastRow1Based; chunkStart += chunkRows) {
      const chunkEnd = Math.min(lastRow1Based, chunkStart + chunkRows - 1);
      const { data } = await sheetsApi.spreadsheets.get({
        spreadsheetId,
        ranges: [`'${safe}'!A${chunkStart}:${endLetter}${chunkEnd}`],
        includeGridData: true,
        fields: GRID_CELL_FIELDS.replace("sheets(data(startRow,", "sheets(data(startRow,startColumn,"),
      });
      const g = data?.sheets?.[0]?.data?.[0];
      const part = g?.rowData || [];
      rowData = rowData.concat(part);
    }
  }

  const startRow0 = firstRow1Based - 1;
  const out = [];
  const padLen = endColIdx + 1;
  for (let i = 0; i < rowData.length; i++) {
    const rawVals = rowData[i]?.values || [];
    const vals = [...rawVals];
    while (vals.length < padLen) vals.push(null);
    const batchCell = gridCellText(vals[0]);
    const weekCell = gridCellText(vals[1]);
    const linkId = extractSheetLinkIdFromRowValues(vals, syllabusColIdx);
    const sheetRow = startRow0 + i + 1;
    const configColIdx = syllabusColIdx + 1;
    const configDestColIdx = syllabusColIdx + 2;
    const configLinkId =
      configColIdx < vals.length && vals[configColIdx] != null
        ? extractSheetLinkIdFromGridCell(vals[configColIdx])
        : null;
    const configDestinationLinkId =
      configDestColIdx < vals.length && vals[configDestColIdx] != null
        ? extractSheetLinkIdFromGridCell(vals[configDestColIdx])
        : null;
    out.push({
      sheetRow,
      batchCell,
      weekCell,
      linkId: linkId || null,
      configLinkId: configLinkId || null,
      configDestinationLinkId: configDestinationLinkId || null,
    });
  }
  await mergeSyllabusColumnLinksFromGrid(
    sheetsApi,
    spreadsheetId,
    sheetTitle,
    firstRow1Based,
    lastRow1Based,
    out,
    syllabusColIdx
  );
  await mergeConfigWorkbookLinksFromGrid(
    sheetsApi,
    spreadsheetId,
    sheetTitle,
    firstRow1Based,
    lastRow1Based,
    out,
    syllabusColIdx + 1
  );
  await mergeConfigDestinationLinksFromGrid(
    sheetsApi,
    spreadsheetId,
    sheetTitle,
    firstRow1Based,
    lastRow1Based,
    out,
    syllabusColIdx + 2
  );
  const formulaBySheetRow = await mergeColumnHFormulasIntoGridRows(
    sheetsApi,
    spreadsheetId,
    sheetTitle,
    firstRow1Based,
    lastRow1Based,
    out,
    syllabusColIdx
  );
  inheritColumnHFromMergedAbove(out, rowData, startRow0, formulaBySheetRow, syllabusColIdx);
  inheritConfigLinkFromMergedAbove(out);
  inheritConfigDestinationLinkFromMergedAbove(out);
  return out;
}

function inheritConfigLinkFromMergedAbove(out) {
  for (let i = 0; i < out.length; i++) {
    if (out[i].configLinkId) continue;
    const batch = parseCellNumber(out[i].batchCell);
    if (Number.isNaN(batch)) continue;
    for (let j = i - 1; j >= 0; j--) {
      const b2 = parseCellNumber(out[j].batchCell);
      if (Number.isNaN(b2) || b2 !== batch) break;
      if (out[j].configLinkId) {
        out[i].configLinkId = out[j].configLinkId;
        break;
      }
    }
  }
}

function inheritConfigDestinationLinkFromMergedAbove(out) {
  for (let i = 0; i < out.length; i++) {
    if (out[i].configDestinationLinkId) continue;
    const batch = parseCellNumber(out[i].batchCell);
    if (Number.isNaN(batch)) continue;
    for (let j = i - 1; j >= 0; j--) {
      const b2 = parseCellNumber(out[j].batchCell);
      if (Number.isNaN(b2) || b2 !== batch) break;
      if (out[j].configDestinationLinkId) {
        out[i].configDestinationLinkId = out[j].configDestinationLinkId;
        break;
      }
    }
  }
}

async function fetchRowSnapshotsForTarget(
  sheetsApi,
  masterId,
  masterTab,
  gridRows,
  tb,
  tw,
  syllabusColIdx,
  targetKey,
  sheetColumnCount
) {
  const snaps = [];
  const snapRows = gridRows.filter(
    (r) => parseCellNumber(r.batchCell) === tb && parseCellNumber(r.weekCell) === tw
  );
  for (const m of snapRows) {
    try {
      const base = await fetchMasterRowSnapshotForApi(
        sheetsApi,
        masterId,
        masterTab,
        m.sheetRow,
        syllabusColIdx,
        sheetColumnCount
      );
      snaps.push({ targetKey, ...base });
    } catch (e) {
      snaps.push({ targetKey, sheetRow: m.sheetRow, error: String(e?.message || e) });
    }
  }
  return snaps;
}

/**
 * Master tracker + syllabus align. Body: { masterSpreadsheetId, masterSheetName, targets?: [{batch,week}], alignTargetsText?, targetBatch?, targetWeek?, … }
 * Response always includes rowSnapshots / rowSnapshotsByTarget (formula + formatted A–Z, syllabusColumnLinkSpreadsheetId).
 */
app.post("/api/syllabus-align-from-master", async (req, res) => {
  try {
    const {
      masterSpreadsheetId,
      masterSheetName,
      linkedSyllabusTabName = "Syllabus",
      skipMasterHeaderRows = 1,
      maxWeek = 40,
      masterLastRow = 3000,
    } = req.body || {};

    const masterId = String(masterSpreadsheetId || "").trim();
    const masterTab = String(masterSheetName || "").trim();
    const targets = normalizeAlignTargets(req.body);

    if (!masterId || !masterTab) {
      return res.status(400).json({ error: "masterSpreadsheetId and masterSheetName are required." });
    }
    if (
      !targets.length ||
      targets.some((t) => Number.isNaN(t.batch) || Number.isNaN(t.week) || t.batch < 2 || t.week < 1)
    ) {
      return res.status(400).json({
        error:
          "At least one target with batch ≥ 2 and week ≥ 1: use targets: [{batch,week}], alignTargetsText (one \"batch week\" per line), or targetBatch + targetWeek.",
      });
    }

    const sheets = getSheetsClient();
    const tabRes = await resolveWorksheetTitleForApiRequests(sheets, masterId, masterTab);
    if (!tabRes.ok) {
      return res.status(400).json({
        error: tabRes.hint,
        availableSheetTabs: tabRes.allTitles,
        likelyBatchConfigWorkbookNotTracker: Boolean(
          hintIfTabListLooksLikeBatchConfigWorkbookNotTracker(tabRes.allTitles)
        ),
      });
    }
    const masterTabResolved = tabRes.title;

    const skipHdr = Math.min(30, Math.max(0, Math.floor(Number(skipMasterHeaderRows))));
    const skipResolved = Number.isFinite(skipHdr) ? skipHdr : 1;
    const dataStart = Math.max(2, skipResolved + 1);
    const lastRowN = Math.floor(Number(masterLastRow));
    const lastRowRequested = Math.min(
      5000,
      Math.max(dataStart, Number.isFinite(lastRowN) && lastRowN > 0 ? lastRowN : 3000)
    );
    const headerRow = Math.max(1, dataStart - 1);

    const sheetGrid = await getSheetGridBoundsForTitle(sheets, masterId, masterTabResolved);
    let lastRow = lastRowRequested;
    if (sheetGrid?.rowCount) {
      lastRow = Math.min(lastRow, sheetGrid.rowCount);
    }
    if (lastRow < dataStart) {
      return res.status(400).json({
        error: `Worksheet "${masterTabResolved}" only has ${sheetGrid?.rowCount ?? "?"} row(s) in its grid; reading from row ${dataStart} would be past the sheet. Lower **Skip master header rows** or add rows in Google Sheets.`,
        sheetGridBounds: sheetGrid,
        dataStartRow: dataStart,
        masterLastRowRequested: lastRowRequested,
      });
    }

    const syllabusColIdx = await detectSyllabusPatternColumnIndex(
      sheets,
      masterId,
      masterTabResolved,
      headerRow,
      sheetGrid?.columnCount
    );

    if (sheetGrid?.columnCount && syllabusColIdx + 2 >= sheetGrid.columnCount) {
      return res.status(400).json({
        error: `Worksheet "${masterTabResolved}" has only ${sheetGrid.columnCount} column(s); need at least through column ${colLetterFromIndex(syllabusColIdx + 2)} for syllabus + template + destination links. Insert columns or widen the grid in Google Sheets.`,
        sheetGridBounds: sheetGrid,
        syllabusColumnIndexDetected: syllabusColIdx,
      });
    }

    const gridRows = await fetchMasterTrackerRowsGrid(
      sheets,
      masterId,
      masterTabResolved,
      dataStart,
      lastRowRequested,
      syllabusColIdx,
      sheetGrid
    );

    for (const t of targets) {
      await patchLinkIdForTargetRows(
        sheets,
        masterId,
        masterTabResolved,
        gridRows,
        t.batch,
        t.week,
        syllabusColIdx
      );
    }

    const masterGridEndColIdx = clampLastColumnIndexToGrid(
      Math.max(syllabusColIdx + 3, 25),
      sheetGrid?.columnCount
    );
    const masterEndLetter = colLetterFromIndex(masterGridEndColIdx);
    const targetKeysSet = new Set(targets.map((x) => `B${x.batch}W${x.week}`));
    const maxWeekLimAlign = Math.min(60, Number(maxWeek) || 40);
    const requiredSyllabusKeys = buildRequiredSyllabusKeysForAlign(gridRows, targets, maxWeekLimAlign);

    const sectionCache = new Map();
    const sectionMeta = new Map();
    const syllabusByKey = new Map();
    const linkErrors = [];
    const syllabusCacheStats = { hits: 0, fetched: 0, workbookIds: [] };
    const interWorkbookMs = Math.max(0, Number(process.env.SHEETS_INTER_WORKBOOK_DELAY_MS) || 1100);
    let lastLinkedWorkbookLoadAt = 0;

    for (const gr of gridRows) {
      if (/batch\s*number/i.test(gr.batchCell) && /assessment\s*week/i.test(gr.weekCell)) continue;
      const batch = parseCellNumber(gr.batchCell);
      const week = parseCellNumber(gr.weekCell);
      if (Number.isNaN(batch) || Number.isNaN(week)) continue;
      const key = `B${batch}W${week}`;
      if (requiredSyllabusKeys && !requiredSyllabusKeys.has(key)) continue;
      const sid = gr.linkId;
      if (!sid) {
        if (targetKeysSet.has(key)) {
          linkErrors.push({
            key,
            masterRow: gr.sheetRow,
            error:
              "No link read from the Syllabus & Pattern column — use Insert link to the batch workbook (URL may be hidden behind display text).",
          });
        }
        syllabusByKey.set(key, "");
        continue;
      }
      try {
        if (!sectionCache.has(sid)) {
          const gap = lastLinkedWorkbookLoadAt
            ? Math.max(0, interWorkbookMs - (Date.now() - lastLinkedWorkbookLoadAt))
            : 0;
          if (gap > 0) await new Promise((r) => setTimeout(r, gap));
          const loaded = await loadLinkedSyllabusWithCache(
            sid,
            linkedSyllabusTabName,
            () => loadLinkedSyllabusSectionsWithMeta(sheets, sid, linkedSyllabusTabName),
            { forceRefresh: false }
          );
          lastLinkedWorkbookLoadAt = Date.now();
          sectionCache.set(sid, loaded.sections);
          sectionMeta.set(sid, loaded.meta);
          if (loaded.cacheHit) syllabusCacheStats.hits += 1;
          else syllabusCacheStats.fetched += 1;
          if (!syllabusCacheStats.workbookIds.includes(sid)) {
            syllabusCacheStats.workbookIds.push(sid);
          }
        }
        const sections = sectionCache.get(sid);
        const text = getSyllabusForWeek(sections, week);
        syllabusByKey.set(key, text);
      } catch (err) {
        if (targetKeysSet.has(key) || linkErrors.length < 6) {
          linkErrors.push({
            key,
            spreadsheetId: sid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        syllabusByKey.set(key, "");
      }
    }

    const rowSnapshotsByTarget = {};
    let rowSnapshots = [];
    for (const t of targets) {
      const tk = `B${t.batch}W${t.week}`;
      const snaps = await fetchRowSnapshotsForTarget(
        sheets,
        masterId,
        masterTabResolved,
        gridRows,
        t.batch,
        t.week,
        syllabusColIdx,
        tk,
        sheetGrid?.columnCount
      );
      rowSnapshotsByTarget[tk] = snaps;
      rowSnapshots = rowSnapshots.concat(snaps);
      logAlignSnapshotsToConsole(tk, snaps);
    }

    const alignRuns = [];
    for (const t of targets) {
      const tb = t.batch;
      const tw = t.week;
      const targetKey = `B${tb}W${tw}`;
      const targetText = syllabusByKey.get(targetKey);

      if (!targetText || !String(targetText).trim()) {
        const matchingRows = gridRows.filter(
          (r) => parseCellNumber(r.batchCell) === tb && parseCellNumber(r.weekCell) === tw
        );
        const firstMatch = matchingRows[0];
        const linkedSid = firstMatch?.linkId || null;
        const sm = linkedSid ? sectionMeta.get(linkedSid) : null;
        const linkedFileWeeksParsed = sm?.weeks?.length
          ? sm.weeks
          : linkedSid && sectionCache.has(linkedSid)
            ? [...sectionCache.get(linkedSid).byWeek.keys()].sort((a, b) => a - b)
            : null;
        const linkedFileLoadError =
          sm?.error || linkErrors.find((e) => e.spreadsheetId === linkedSid)?.error || null;
        let ignoredUrlOnRow = null;
        if (firstMatch?.sheetRow) {
          ignoredUrlOnRow = await findIgnoredNonSyllabusSpreadsheetOnRow(
            sheets,
            masterId,
            masterTabResolved,
            firstMatch.sheetRow,
            syllabusColIdx
          );
        }
        const weekHint =
          linkedFileWeeksParsed?.length && !linkedFileWeeksParsed.includes(tw)
            ? ` Linked file has weeks [${linkedFileWeeksParsed.join(", ")}] but not W${tw}.`
            : "";
        const quotaExtra =
          linkedFileLoadError && /quota exceeded|read requests per minute/i.test(String(linkedFileLoadError))
            ? " Tip: wait a minute, set SHEETS_INTER_WORKBOOK_DELAY_MS (e.g. 2000) and SHEETS_LINKED_BASE_DELAY_MS (e.g. 4000) in .env, or increase Sheets API quota in Google Cloud."
            : "";
        const accessHint = linkedFileLoadError
          ? ` Linked workbook error: ${linkedFileLoadError}${quotaExtra ? `. ${quotaExtra}` : ""}`
          : "";
        const ignoredHint =
          ignoredUrlOnRow && sm?.wrongWorkbookKind === "mock_or_results"
            ? ` Ignored non-syllabus URL in column ${ignoredUrlOnRow.column} (${ignoredUrlOnRow.spreadsheetId}).`
            : ignoredUrlOnRow && !linkedSid
              ? ` Found a spreadsheet URL in column ${ignoredUrlOnRow.column} but it is not the syllabus Insert link — use column ${colLetterFromIndex(syllabusColIdx)}.`
              : "";
        const errMsg = `No syllabus text for ${targetKey}.${weekHint}${accessHint}${ignoredHint}`;
        alignRuns.push({
          targetKey,
          error: errMsg,
          configSpreadsheetId: firstMatch?.configLinkId ?? null,
          configDestinationSpreadsheetId: firstMatch?.configLinkId ?? null,
          configTemplateSpreadsheetId: null,
          debug: {
            masterReadRange: `A${dataStart}:${masterEndLetter}${lastRow}`,
            syllabusColumnIndex: syllabusColIdx,
            syllabusColumnLetter: colLetterFromIndex(syllabusColIdx),
            targetMatchingMasterRows: matchingRows.slice(0, 5).map((r) => ({
              sheetRow: r.sheetRow,
              hasLink: Boolean(r.linkId),
              linkSpreadsheetId: r.linkId || null,
            })),
            linkedFileWeeksParsed,
            linkedFileLoadError,
            linkedFileTabResolved: sm?.tabTitle ?? null,
            ignoredNonSyllabusSpreadsheetOnRow: ignoredUrlOnRow,
          },
        });
        continue;
      }

      const gridRowForTarget = gridRows.find(
        (r) => parseCellNumber(r.batchCell) === tb && parseCellNumber(r.weekCell) === tw
      );
      const result = alignSyllabusSearch({
        targetBatch: tb,
        targetWeek: tw,
        syllabusByKey,
        targetText,
        maxWeek: Math.min(60, Number(maxWeek) || 40),
      });
      const destConfigId = gridRowForTarget?.configLinkId ?? null;
      const reuseKey = result.winner?.key || result.bestReuseCandidate?.key || null;
      const rw = reuseKey ? parseBatchWeekKey(reuseKey) : null;
      const gridRowForReuseTemplate = rw
        ? gridRows.find(
            (r) => parseCellNumber(r.batchCell) === rw.batch && parseCellNumber(r.weekCell) === rw.week
          )
        : null;
      const templateConfigId = gridRowForReuseTemplate?.configLinkId ?? null;

      alignRuns.push({
        targetKey,
        targetSyllabusPreview: String(targetText).slice(0, 400),
        /** Target row: batch config workbook (column after Syllabus & Pattern — update this file). */
        configSpreadsheetId: destConfigId,
        configDestinationSpreadsheetId: destConfigId,
        /** Winner / reuse row: same column — copy template **from** this batch’s linked workbook (e.g. B3W8). */
        configTemplateSpreadsheetId: templateConfigId,
        ...result,
      });
    }

    const payload = {
      masterSpreadsheetId: masterId,
      masterSheetName: masterTabResolved,
      masterSheetNameRequested: masterTab !== masterTabResolved ? masterTab : undefined,
      linkedSyllabusTabName,
      dataStartRow: dataStart,
      masterLastRowRead: lastRow,
      linkErrors,
      externalWorkbooksLoaded: sectionCache.size,
      syllabusCache: {
        ...getSyllabusCacheConfig(),
        thisRequest: syllabusCacheStats,
      },
      rowSnapshots,
      rowSnapshotsByTarget,
      masterAlignMeta: {
        syllabusColumnIndex: syllabusColIdx,
        syllabusColumnLetter: colLetterFromIndex(syllabusColIdx),
        configTemplateColumnLetter: colLetterFromIndex(syllabusColIdx + 1),
        /** Optional second link column (legacy); config copy uses the template column on winner vs target rows only. */
        configDestinationColumnLetter: colLetterFromIndex(syllabusColIdx + 2),
        headerRowUsedForDetection: headerRow,
        masterGridReadRange: `A${dataStart}:${masterEndLetter}${lastRow}`,
        sheetGridRowCount: sheetGrid?.rowCount ?? null,
        sheetGridColumnCount: sheetGrid?.columnCount ?? null,
        masterLastRowRequested: lastRowRequested,
        masterLastRowClampedToGrid: lastRowRequested !== lastRow ? lastRow : undefined,
        linkedSyllabusLoadFilter: requiredSyllabusKeys
          ? { enabled: true, maxWeek: maxWeekLimAlign, keyCount: requiredSyllabusKeys.size }
          : { enabled: false },
      },
      alignRuns,
    };

    if (targets.length === 1 && alignRuns[0]?.error) {
      return res.status(400).json({
        error: alignRuns[0].error,
        ...payload,
      });
    }

    res.json(payload);
  } catch (e) {
    console.error(e);
    const apiReason = googleSheetsApiReason(e);
    res.status(500).json({
      error: apiReason && !String(e.message || "").includes(apiReason) ? `${e.message} (${apiReason})` : e.message || "Align-from-master failed",
      hint:
        googleSheetsPermissionHint(e) ||
        (/exceeds grid limits/i.test(String(e.message || ""))
          ? "The sheet tab’s grid is smaller than the requested range. Lower **Read master through row** in the UI or add rows/columns on that tab in Google Sheets, then retry."
          : "Share the master tracker and every linked syllabus workbook with the service account (Editor)."),
    });
  }
});

/**
 * Copy template config workbook (Mock/Main Assessment & Interview tabs) into a destination spreadsheet.
 * Full clone for four config tabs; Test Links: only B on the "Main Assessment Config Link — Testing" row.
 */
app.post("/api/copy-config-template", async (req, res) => {
  try {
    const { sourceSpreadsheetId, destinationSpreadsheetId } = req.body || {};
    const rawSrc = String(sourceSpreadsheetId || "").trim();
    const rawDst = String(destinationSpreadsheetId || "").trim();
    const src = extractSpreadsheetIdFromUrl(rawSrc) || rawSrc;
    const dst = extractSpreadsheetIdFromUrl(rawDst) || rawDst;
    if (!src || !dst) {
      return res.status(400).json({
        error: "sourceSpreadsheetId and destinationSpreadsheetId are required (paste both spreadsheet IDs or URLs).",
      });
    }
    const sheets = getSheetsClient();
    const summary = await copyConfigTemplateSheets(sheets, src, dst);
    res.json({
      ok: true,
      destinationUrl: `https://docs.google.com/spreadsheets/d/${dst}/edit`,
      ...summary,
    });
  } catch (e) {
    console.error(e);
    const apiReason = googleSheetsApiReason(e);
    res.status(500).json({
      error:
        apiReason && !String(e.message || "").includes(apiReason)
          ? `${e.message} (${apiReason})`
          : e.message || "copy-config-template failed",
      hint:
        googleSheetsPermissionHint(e) ||
        "Share the source (column I config template) and destination spreadsheets with the service account (Editor on destination, at least Viewer on source).",
    });
  }
});

/** Clear cached linked syllabus workbooks (memory + disk). Body: { spreadsheetId?, tabName? } — omit to clear all. */
app.post("/api/syllabus-cache/clear", async (req, res) => {
  try {
    const { spreadsheetId = null, tabName = null } = req.body || {};
    const result = await clearSyllabusCache(
      spreadsheetId ? String(spreadsheetId).trim() : null,
      tabName ? String(tabName).trim() : null
    );
    res.json({ ok: true, ...result, config: getSyllabusCacheConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to clear syllabus cache" });
  }
});

app.get("/api/syllabus-cache/status", (_req, res) => {
  res.json(getSyllabusCacheConfig());
});

/** Production / Render: serve Vite build from same origin so `/api` works without a separate UI URL. */
const clientDist = path.join(__dirname, "..", "client", "dist");
const clientIndexHtml = path.join(clientDist, "index.html");

if (fs.existsSync(clientIndexHtml)) {
  app.use(express.static(clientDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(clientIndexHtml);
  });
} else {
  console.warn(
    `[batch-tracker-ui] No UI at ${clientIndexHtml} — run "npm run build" from batch-tracker-ui. Root GET will return 503 until dist exists.`
  );
  app.get("/", (_req, res) => {
    res.status(503).json({
      error: "UI not built",
      hint:
        "Missing client/dist — Vite never ran. On Render, set Build Command to npm ci && npm run build (not only npm install). With Root Directory batch-tracker-ui use that; from repo root use npm --prefix batch-tracker-ui ci && npm --prefix batch-tracker-ui run build. Then redeploy.",
    });
  });
}

app.listen(PORT, () => {
  console.log(`Batch tracker API http://localhost:${PORT}`);
  if (fs.existsSync(clientIndexHtml)) {
    console.log(`Serving UI from ${clientDist}`);
  }
});
