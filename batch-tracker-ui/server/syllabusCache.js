import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", ".cache", "syllabus");
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const TTL_MS = Number(process.env.SYLLABUS_CACHE_TTL_MS) || DEFAULT_TTL_MS;

/** @type {Map<string, { sections: object, meta: object, fetchedAt: number }>} */
const memory = new Map();

function cacheKey(spreadsheetId, tabName) {
  return `${String(spreadsheetId).trim()}::${String(tabName || "Syllabus")
    .trim()
    .toLowerCase()}`;
}

function diskPath(key) {
  const safe = key.replace(/[^a-zA-Z0-9:_-]+/g, "_").slice(0, 180);
  return path.join(CACHE_DIR, `${safe}.json`);
}

function serializeSections(sections) {
  const byWeek = sections?.byWeek;
  const entries =
    byWeek instanceof Map ? [...byWeek.entries()] : Object.entries(byWeek || {});
  return {
    byWeek: Object.fromEntries(entries.map(([k, v]) => [String(k), v])),
    fallbackAll: sections?.fallbackAll || "",
  };
}

export function deserializeSections(data) {
  const raw = data?.byWeek || {};
  const byWeek = new Map();
  for (const [k, v] of Object.entries(raw)) {
    const wk = parseInt(k, 10);
    if (!Number.isNaN(wk)) byWeek.set(wk, v);
  }
  return { byWeek, fallbackAll: data?.fallbackAll || "" };
}

function isFresh(fetchedAt) {
  return typeof fetchedAt === "number" && Date.now() - fetchedAt < TTL_MS;
}

async function readDisk(key) {
  try {
    const raw = await fs.readFile(diskPath(key), "utf8");
    const parsed = JSON.parse(raw);
    if (!isFresh(parsed.fetchedAt)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDisk(key, payload) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(diskPath(key), JSON.stringify(payload), "utf8");
  } catch {
    /* disk cache is best-effort */
  }
}

/**
 * @returns {Promise<{ sections, meta, fetchedAt, source: 'memory'|'disk' } | null>}
 */
export async function getCachedLinkedSyllabus(spreadsheetId, tabName) {
  const key = cacheKey(spreadsheetId, tabName);
  const mem = memory.get(key);
  if (mem && isFresh(mem.fetchedAt)) {
    return { sections: mem.sections, meta: mem.meta, fetchedAt: mem.fetchedAt, source: "memory" };
  }
  const disk = await readDisk(key);
  if (!disk) return null;
  const sections = deserializeSections(disk.sections);
  const entry = { sections, meta: disk.meta, fetchedAt: disk.fetchedAt };
  memory.set(key, entry);
  return { ...entry, source: "disk" };
}

export async function setCachedLinkedSyllabus(spreadsheetId, tabName, sections, meta) {
  const key = cacheKey(spreadsheetId, tabName);
  const fetchedAt = Date.now();
  const entry = { sections, meta, fetchedAt };
  memory.set(key, entry);
  await writeDisk(key, {
    sections: serializeSections(sections),
    meta,
    fetchedAt,
    spreadsheetId,
    tabName,
  });
}

/** Drop cache for one workbook or everything (memory + disk). */
export async function clearSyllabusCache(spreadsheetId = null, tabName = null) {
  if (!spreadsheetId) {
    memory.clear();
    try {
      const files = await fs.readdir(CACHE_DIR);
      await Promise.all(files.map((f) => fs.unlink(path.join(CACHE_DIR, f)).catch(() => {})));
    } catch {
      /* empty */
    }
    return { cleared: "all" };
  }
  const key = cacheKey(spreadsheetId, tabName || "Syllabus");
  memory.delete(key);
  try {
    await fs.unlink(diskPath(key));
  } catch {
    /* ignore */
  }
  return { cleared: key };
}

export function getSyllabusCacheConfig() {
  return {
    ttlMs: TTL_MS,
    ttlHours: Math.round((TTL_MS / (60 * 60 * 1000)) * 10) / 10,
    cacheDir: CACHE_DIR,
    entriesInMemory: memory.size,
  };
}

/**
 * Load linked syllabus sections once, then reuse from memory/disk until TTL expires.
 * @param {boolean} [opts.forceRefresh]
 */
export async function loadLinkedSyllabusWithCache(spreadsheetId, tabName, loader, opts = {}) {
  const { forceRefresh = false } = opts;
  if (!forceRefresh) {
    const hit = await getCachedLinkedSyllabus(spreadsheetId, tabName);
    if (hit) {
      return {
        sections: hit.sections,
        meta: { ...hit.meta, cachedAt: hit.fetchedAt, cacheSource: hit.source },
        cacheHit: true,
        cacheSource: hit.source,
      };
    }
  }
  const result = await loader();
  const ok = result?.meta?.tabTitle && !result?.meta?.error;
  if (ok) {
    await setCachedLinkedSyllabus(spreadsheetId, tabName, result.sections, result.meta);
  }
  return {
    ...result,
    cacheHit: false,
    cacheSource: null,
  };
}
