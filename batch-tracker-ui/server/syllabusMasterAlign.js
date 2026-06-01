/**
 * Master tracker → linked syllabus workbooks → align target B{b}W{w}
 * against older batches using the user's priority rules.
 */

function tokenize(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

function wordJaccard(a, b) {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Target coverage: how much of target appears in candidate [0,1] */
function targetRecall(target, cand) {
  const t = tokenize(target);
  const c = tokenize(cand);
  if (t.size === 0) return 1;
  let inter = 0;
  for (const w of t) if (c.has(w)) inter++;
  return inter / t.size;
}

/** Candidate-only extras vs target (high = candidate teaches more than target) */
function excessFraction(target, cand) {
  const t = tokenize(target);
  const c = tokenize(cand);
  if (c.size === 0) return 0;
  let extra = 0;
  for (const w of c) if (!t.has(w)) extra++;
  return extra / c.size;
}

function normalizeSyllabusLine(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[-–]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[|"]/g, "")
    .replace(/\bwalkthrough\b/g, "walk through")
    .replace(/\bgenai\b/g, "gen ai")
    .replace(/\bhooks\b/g, "hook");
}

function lineTokenSet(line) {
  const stop = new Set(["part", "intro", "to", "the", "and", "of", "in", "a", "an", "1", "2", "3"]);
  return new Set(
    line
      .split(" ")
      .filter((w) => w.length > 2 && !stop.has(w))
  );
}

/** If both lines name a lesson "part" / episode number and they differ, do not treat as the same unit (e.g. HTTP Part 1 vs Part 2). */
function conflictingLessonPartNumbers(a, b) {
  const re = /\bpart\s*-?\s*(\d+)\b/gi;
  const pickLast = (s) => {
    const m = [...String(s).toLowerCase().matchAll(re)];
    return m.length ? m[m.length - 1][1] : null;
  };
  const pa = pickLast(a);
  const pb = pickLast(b);
  return pa != null && pb != null && pa !== pb;
}

/** Fuzzy match for syllabus unit titles (walk-through vs walkthrough, GenAI wording, etc.). */
function linesMatch(a, b) {
  if (!a || !b) return false;
  if (conflictingLessonPartNumbers(a, b)) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = lineTokenSet(a);
  const tb = lineTokenSet(b);
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const denom = Math.min(ta.size, tb.size);
  return denom > 0 && inter / denom >= 0.82;
}

function lineCoveredIn(line, otherLines) {
  if (otherLines.some((o) => linesMatch(line, o))) return true;
  if (/\bgen\s*ai\b/.test(line)) {
    return otherLines.some((o) => /\bgen\s*ai\b/.test(o));
  }
  return false;
}

/** Topic / unit lines (non-empty rows from syllabus tab text). */
export function syllabusTopicLines(text) {
  const lines = [];
  for (const raw of String(text || "").split(/\n/)) {
    const line = normalizeSyllabusLine(raw);
    if (line.length > 2) lines.push(line);
  }
  return lines;
}

/** Share of target lines present in candidate [0,1]. */
export function targetLineRecall(targetText, candText) {
  const tLines = syllabusTopicLines(targetText);
  const cLines = syllabusTopicLines(candText);
  if (!tLines.length) return 1;
  let hit = 0;
  for (const t of tLines) if (lineCoveredIn(t, cLines)) hit++;
  return hit / tLines.length;
}

/** Target topic lines with no fuzzy match in the candidate (subset gaps). */
export function targetTopicLinesMissingFromCandidate(targetText, candText) {
  const tLines = syllabusTopicLines(targetText);
  const cLines = syllabusTopicLines(candText);
  const missing = [];
  for (const t of tLines) {
    if (!lineCoveredIn(t, cLines)) missing.push(t);
  }
  return missing;
}

/** Share of candidate lines not in target [0,1] — must be ~0 to reuse (no extra units). */
export function candidateLineExcess(targetText, candText) {
  const tLines = syllabusTopicLines(targetText);
  const cLines = syllabusTopicLines(candText);
  if (!cLines.length) return 0;
  let extra = 0;
  for (const c of cLines) if (!lineCoveredIn(c, tLines)) extra++;
  return extra / cLines.length;
}

/** Target line coverage at or above this → “safe to reuse config” (0 extra units only). */
export const REUSE_CONFIG_MIN_LINE_REC = 0.98;

/** Caution reuse: older syllabus has this many extra substantive units vs target (not 3+). */
export const CAUTION_REUSE_MAX_EXTRA_UNITS = 2;

const CAUTION_REUSE_MIN_LINE_REC = 0.85;

const SECTION_HEADER =
  /^(frontend development|computer programming|gen ai|introduction to git|introduction to git & github)$/i;

/** Topic lines taught in candidate but not in target (strict reuse rule). */
export function substantiveExtraLinesInCandidate(targetText, candText) {
  const tLines = syllabusTopicLines(targetText);
  const cLines = syllabusTopicLines(candText);
  const extras = [];
  for (const c of cLines) {
    if (c.length < 8) continue;
    if (SECTION_HEADER.test(c)) continue;
    if (!lineCoveredIn(c, tLines)) extras.push(c);
  }
  return extras;
}

/** Reuse allowed only when candidate has zero extra units vs target (subset or exact). */
export function candidateExceedsTarget(targetText, candText) {
  if (substantiveExtraLinesInCandidate(targetText, candText).length > 0) return true;
  const exc = excessFraction(targetText, candText);
  return exc > 0.08;
}

/** Same-week “caution” row: 1–2 extra units vs target but still enough overlap to suggest manual review. */
export function qualifiesCautionReuseVersusTarget(cmp) {
  if (!cmp || cmp.extraLineCount < 1 || cmp.extraLineCount > CAUTION_REUSE_MAX_EXTRA_UNITS) return false;
  if (cmp.lineRec < CAUTION_REUSE_MIN_LINE_REC) return false;
  /* Allow a couple of extra rows without requiring near-zero token drift (extras often introduce new words). */
  if (cmp.lineExc > 0.45) return false;
  if (cmp.exc > 0.25) return false;
  return true;
}

export function compareVersusTarget(targetText, candText) {
  const t = String(targetText || "").trim();
  const c = String(candText || "").trim();
  const jac = wordJaccard(t, c);
  const rec = targetRecall(t, c);
  const exc = excessFraction(t, c);
  const lineRec = targetLineRecall(t, c);
  const lineExc = candidateLineExcess(t, c);
  const extraLines = substantiveExtraLinesInCandidate(t, c);
  const missingLines = targetTopicLinesMissingFromCandidate(t, c);
  const classification = classifyVersusTarget(targetText, candText, {
    jac,
    rec,
    exc,
    lineRec,
    lineExc,
  });
  return {
    classification,
    jac,
    rec,
    exc,
    lineRec,
    lineExc,
    extraLineCount: extraLines.length,
    extraLineSamples: extraLines.slice(0, 5),
    missingLineCount: missingLines.length,
    missingLineSamples: missingLines.slice(0, 5),
  };
}

/**
 * @returns {'exact'|'more'|'less'|'unknown'}
 * - exact: same units as target (strict line coverage)
 * - more: candidate has units/topics target does not (cannot reuse)
 * - less: candidate is a subset of target (missing units, no extras)
 */
export function classifyVersusTarget(targetText, candText, precomputed = null) {
  const t = String(targetText || "").trim();
  const c = String(candText || "").trim();
  if (!t.length && !c.length) return "exact";
  if (!c.length) return "less";
  if (!t.length) return "unknown";

  const jac = precomputed?.jac ?? wordJaccard(t, c);
  const rec = precomputed?.rec ?? targetRecall(t, c);
  const exc = precomputed?.exc ?? excessFraction(t, c);
  const lineRec = precomputed?.lineRec ?? targetLineRecall(t, c);
  const lineExc = precomputed?.lineExc ?? candidateLineExcess(t, c);
  const extraLines = substantiveExtraLinesInCandidate(t, c);

  if (extraLines.length > 0 || exc > 0.08) return "more";

  if (lineRec >= 0.995 && lineExc <= 0.02 && rec >= 0.92 && exc <= 0.06) return "exact";
  if (lineRec >= 0.99 && lineExc <= 0.03 && jac >= 0.9) return "exact";

  if (lineRec < 0.995 || rec < 0.92) return "less";
  if (lineRec >= 0.92 && lineExc <= 0.05 && extraLines.length === 0) return "less";
  return "unknown";
}

/** Non-empty trimmed cells from a values row (values.get), joined for syllabus body text. */
function joinRowText(row, maxCol = 40) {
  const bits = [];
  const r = row || [];
  for (let j = 0; j < maxCol && j < r.length; j++) {
    const t = String(r[j] ?? "").trim();
    if (t) bits.push(t);
  }
  return bits.join("\n");
}

export function parseWeekHeaderFromRow(row) {
  for (let idx = 0; idx <= 8; idx++) {
    const s = String(row?.[idx] ?? "").trim();
    if (!s) continue;
    let m = s.match(/weekly\s*assessment\s*[-–]?\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/weekly\s*assessment\s*week\s*[-–]?\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/^weekly\s+assessment\s*[-–]?\s*(\d+)\s*$/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/^weekly\s+assessment\s+week\s*[-–]?\s*(\d+)\s*$/i);
    if (m) return parseInt(m[1], 10);
    /* Prefer whole-cell week labels to avoid matching "Week - 3" inside long body copy. */
    m = s.match(/^week\s*[-–]\s*(\d+)\s*$/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/^week\s+(\d+)\s*$/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/^week\s*(\d+)\s*[-–:]/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/^w\s*(\d+)\s*$/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/^w\s*(\d+)\s*[-–:]/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Build map weekNumber -> syllabus text from Syllabus tab grid (columns A,B,C typical).
 * If no week headers found, returns { fallbackAll: string } only.
 */
export function extractSyllabusSectionsByWeek(values) {
  const rows = values || [];
  const byWeek = new Map();
  let currentWeek = null;
  let parts = [];

  const flush = () => {
    if (currentWeek === null) return;
    const text = parts.join("\n").trim();
    if (text) {
      const prev = byWeek.get(currentWeek) || "";
      byWeek.set(currentWeek, prev ? `${prev}\n${text}` : text);
    }
    parts = [];
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const wk = parseWeekHeaderFromRow(row);
    const line = joinRowText(row);

    if (wk !== null) {
      flush();
      currentWeek = wk;
      /* Include full row text so a header-only row in column A (or body in A) is not dropped. */
      if (line) parts.push(line);
    } else if (currentWeek !== null && line) {
      parts.push(line);
    }
  }
  flush();

  if (byWeek.size === 0) {
    const lines = rows.flatMap((r) => joinRowText(r).split("\n").filter(Boolean));
    return { byWeek: new Map(), fallbackAll: lines.join("\n").trim() };
  }
  return { byWeek, fallbackAll: "" };
}

export function getSyllabusForWeek(sections, week) {
  if (sections.byWeek.has(week)) return sections.byWeek.get(week) || "";
  if (sections.fallbackAll) return sections.fallbackAll;
  return "";
}

export function extractSpreadsheetIdFromUrl(url) {
  const m = String(url || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : "";
}

/**
 * Pick the syllabus content tab inside a linked workbook.
 * Workbooks from the “Syllabus & Pattern” column usually have Syllabus + Pattern tabs;
 * alignment always reads Syllabus (Pattern is reference-only unless you change linkedSyllabusTabName).
 */
export function pickSyllabusWorkbookTab(tabs, preferredName = "Syllabus") {
  const list = (tabs || []).filter(Boolean);
  if (!list.length) return null;
  const want = String(preferredName || "Syllabus").trim();
  let hit = list.find((t) => t === want) || list.find((t) => t.toLowerCase() === want.toLowerCase());
  if (hit) return hit;
  hit = list.find((t) => /^syllabus\s*$/i.test(String(t).trim()));
  if (hit) return hit;
  const candidates = list.filter((t) => {
    const s = String(t).trim();
    return /syllabus/i.test(s) && !/^pattern\s*$/i.test(s);
  });
  if (candidates.length === 1) return candidates[0];
  hit = candidates.find((t) => !/pattern/i.test(t)) || candidates[0];
  return hit || null;
}

export function workbookHasSyllabusAndPatternTabs(tabs) {
  const list = (tabs || []).map((t) => String(t).trim().toLowerCase());
  return list.some((t) => t === "syllabus" || /^syllabus\b/.test(t)) && list.some((t) => t === "pattern");
}

/** Older batch covers every target unit line; may include extra units (trim before reuse). */
export const SUPERSET_REUSE_MAX_EXTRA_UNITS = 20;

/** Same-week row qualifies as exact (full scan, not only the nearest older batch). */
function isSameWeekExactMatch(cmp) {
  if (!cmp || cmp.extraLineCount > 0 || cmp.lineExc > 0.02) return false;
  if (cmp.classification === "exact") return true;
  return cmp.lineRec >= 0.992 && cmp.lineExc <= 0.02 && cmp.rec >= 0.9;
}

/**
 * Search older batches for reuse syllabus for target B{Tb}W{Tw}:
 * 1) Exact match: same calendar week W{Tw} only, full scan B{Tb-1}…B1.
 * 2) Reuse / superset / subset / caution: compare **all weeks** present on older rows in `syllabusByKey` (so B3W8 can win vs B7W7 when it fits better than B6W7).
 * 3) `reuse_config`: same week as target, ≥98% line recall, zero missing target units, zero extra rows.
 * 4) `reuse_superset`: full target coverage with extra rows; rank by fewest extras, then smallest |W−Wtarget|, then older batch.
 */
export function alignSyllabusSearch({
  targetBatch,
  targetWeek,
  syllabusByKey,
  targetText,
  maxWeek = 30,
}) {
  const steps = [];
  const Tb = targetBatch;
  const Tw = targetWeek;
  const targetKey = `B${Tb}W${Tw}`;

  const reuseCandidates = [];
  const cautionReuseCandidates = [];
  const supersetReuseCandidates = [];
  const exactSameWeek = [];

  const rankReuseCandidates = (list) =>
    [...list].sort((a, b) => {
      if (a.missingLineCount !== b.missingLineCount) return a.missingLineCount - b.missingLineCount;
      if (b.lineRec !== a.lineRec) return b.lineRec - a.lineRec;
      if (a.extraLineCount !== b.extraLineCount) return a.extraLineCount - b.extraLineCount;
      const wa = Math.abs(a.week - Tw);
      const wb = Math.abs(b.week - Tw);
      if (wa !== wb) return wa - wb;
      const distA = Tb - a.batch;
      const distB = Tb - b.batch;
      if (distA !== distB) return distA - distB;
      return b.rec - a.rec;
    });

  const rankSupersetReuse = (list) =>
    [...list].sort((a, b) => {
      if (a.extraLineCount !== b.extraLineCount) return a.extraLineCount - b.extraLineCount;
      const wa = Math.abs(a.week - Tw);
      const wb = Math.abs(b.week - Tw);
      if (wa !== wb) return wa - wb;
      if (a.lineExc !== b.lineExc) return a.lineExc - b.lineExc;
      if (a.exc !== b.exc) return a.exc - b.exc;
      if (a.batch !== b.batch) return a.batch - b.batch;
      if (b.lineRec !== a.lineRec) return b.lineRec - a.lineRec;
      return 0;
    });

  const considerReuseCandidate = (b, w, key, text, cmp) => {
    if (!text?.trim() || !String(targetText).trim()) return;

    if (cmp.extraLineCount === 0) {
      if (candidateExceedsTarget(targetText, text)) return;
      if (cmp.classification === "more") return;
      reuseCandidates.push({
        key,
        batch: b,
        week: w,
        textPreview: text.slice(0, 200),
        ...cmp,
        exceedsTarget: false,
      });
      return;
    }

    if (
      Math.abs(w - Tw) <= 1 &&
      cmp.extraLineCount >= 1 &&
      cmp.extraLineCount <= CAUTION_REUSE_MAX_EXTRA_UNITS &&
      qualifiesCautionReuseVersusTarget(cmp)
    ) {
      cautionReuseCandidates.push({
        key,
        batch: b,
        week: w,
        textPreview: text.slice(0, 200),
        ...cmp,
        exceedsTarget: true,
      });
    }

    if (
      cmp.missingLineCount === 0 &&
      cmp.extraLineCount > 0 &&
      cmp.extraLineCount <= SUPERSET_REUSE_MAX_EXTRA_UNITS
    ) {
      supersetReuseCandidates.push({
        key,
        batch: b,
        week: w,
        textPreview: text.slice(0, 200),
        ...cmp,
        exceedsTarget: true,
      });
    }
  };

  const pickBestExact = () => {
    if (!exactSameWeek.length) return null;
    return rankReuseCandidates(exactSameWeek)[0];
  };

  const pickBestReuse = () => {
    if (!reuseCandidates.length) return null;
    return rankReuseCandidates(reuseCandidates)[0];
  };

  const pickBestReuseConfig = () => {
    const above = reuseCandidates.filter(
      (c) =>
        c.week === Tw &&
        c.lineRec >= REUSE_CONFIG_MIN_LINE_REC &&
        c.missingLineCount === 0
    );
    if (!above.length) return null;
    return rankReuseCandidates(above)[0];
  };

  const pickBestCaution = () => {
    if (!cautionReuseCandidates.length) return null;
    return rankReuseCandidates(cautionReuseCandidates)[0];
  };

  const pickBestSupersetReuse = () => {
    if (!supersetReuseCandidates.length) return null;
    return rankSupersetReuse(supersetReuseCandidates)[0];
  };

  const tryWeek = (b, w, reason, allowReusePool = false) => {
    if (w < 1 || w > maxWeek) return null;
    const key = `B${b}W${w}`;
    const text = syllabusByKey.get(key);
    const step = { key, reason, hasData: Boolean(text && text.trim()) };
    steps.push(step);
    if (!text?.trim()) {
      step.classification = "no_data";
      return null;
    }
    const cmp = compareVersusTarget(targetText, text);
    step.classification = cmp.classification;
    step.metrics = {
      lineRec: Math.round(cmp.lineRec * 1000) / 1000,
      lineExc: Math.round(cmp.lineExc * 1000) / 1000,
      rec: Math.round(cmp.rec * 1000) / 1000,
      exc: Math.round(cmp.exc * 1000) / 1000,
      extraUnits: cmp.extraLineCount,
      missingUnits: cmp.missingLineCount,
    };
    if (cmp.extraLineSamples?.length) {
      step.extraLineSamples = cmp.extraLineSamples;
    }
    if (cmp.missingLineSamples?.length) {
      step.missingLineSamples = cmp.missingLineSamples;
    }
    if (allowReusePool) {
      if (w === Tw && isSameWeekExactMatch(cmp)) {
        exactSameWeek.push({
          key,
          batch: b,
          week: w,
          textPreview: text.slice(0, 200),
          ...cmp,
        });
      } else {
        considerReuseCandidate(b, w, key, text, cmp);
      }
    }
    return { classification: cmp.classification, cmp };
  };

  const weekSet = new Set([Tw]);
  for (const mapKey of syllabusByKey.keys()) {
    const m = String(mapKey).match(/^B(\d+)W(\d+)$/i);
    if (!m) continue;
    const bb = parseInt(m[1], 10);
    const ww = parseInt(m[2], 10);
    if (bb < Tb && bb >= 1 && ww >= 1 && ww <= maxWeek) weekSet.add(ww);
  }
  const weeksSorted = [...weekSet].sort((a, b) => a - b);

  for (let b = Tb - 1; b >= 1; b--) {
    for (const w of weeksSorted) {
      const tag = w === Tw ? "same week as target" : `cross-week W${w} (target W${Tw})`;
      tryWeek(b, w, `B${b}W${w}: ${tag} · older batches + weeks in master`, true);
    }
  }

  const bestExact = pickBestExact();
  if (bestExact) {
    return {
      targetKey,
      winner: {
        key: bestExact.key,
        batch: bestExact.batch,
        week: bestExact.week,
        reason: `exact match at B${bestExact.batch}W${bestExact.week} (same week W${Tw}; best of B${Tb - 1}…B1)`,
        matchType: "exact",
        metrics: {
          lineRec: bestExact.lineRec,
          lineExc: bestExact.lineExc,
          rec: bestExact.rec,
          exc: bestExact.exc,
          extraUnits: bestExact.extraLineCount,
          missingUnits: bestExact.missingLineCount,
        },
      },
      steps,
      bestReuseCandidate: pickBestReuse(),
    };
  }

  const bestReuseConfig = pickBestReuseConfig();
  if (bestReuseConfig) {
    const bar = Math.round(REUSE_CONFIG_MIN_LINE_REC * 100);
    return {
      targetKey,
      winner: {
        key: bestReuseConfig.key,
        batch: bestReuseConfig.batch,
        week: bestReuseConfig.week,
        reason: `${bar}%+ line coverage, all target units present, zero extra rows at B${bestReuseConfig.batch}W${bestReuseConfig.week} — config reuse recommended (full scan B${Tb - 1}…B1)`,
        matchType: "reuse_config",
        metrics: {
          lineRec: bestReuseConfig.lineRec,
          lineExc: bestReuseConfig.lineExc,
          rec: bestReuseConfig.rec,
          exc: bestReuseConfig.exc,
          extraUnits: bestReuseConfig.extraLineCount,
          missingUnits: bestReuseConfig.missingLineCount,
        },
      },
      steps,
      bestReuseCandidate: bestReuseConfig,
      message: `No full syllabus match. ${bestReuseConfig.key} covers every target unit (0 missing), ≥${bar}% line recall, no extra rows — safe to reuse config after a quick spot-check.`,
    };
  }

  const bestSuperset = pickBestSupersetReuse();
  if (bestSuperset) {
    const k = bestSuperset.extraLineCount;
    const unitWord = k === 1 ? "unit" : "units";
    const weekHint =
      bestSuperset.week !== Tw
        ? ` Source week W${bestSuperset.week} (target is W${Tw}) — align master week before reusing.`
        : "";
    const supersetNote = `All ${targetKey} units appear in ${bestSuperset.key}; ${k} extra ${unitWord} in the older syllabus — trim or branch those before reusing config.${weekHint}`;
    return {
      targetKey,
      winner: {
        key: bestSuperset.key,
        batch: bestSuperset.batch,
        week: bestSuperset.week,
        reason: `full target coverage at B${bestSuperset.batch}W${bestSuperset.week} with ${k} extra row(s) vs ${targetKey} (fewest extras among older batches; cross-week scan)`,
        matchType: "reuse_superset",
        supersetNote,
        metrics: {
          lineRec: bestSuperset.lineRec,
          lineExc: bestSuperset.lineExc,
          rec: bestSuperset.rec,
          exc: bestSuperset.exc,
          extraUnits: bestSuperset.extraLineCount,
          missingUnits: bestSuperset.missingLineCount,
        },
      },
      steps,
      bestReuseCandidate: bestSuperset,
      message: `No exact or ≥${Math.round(REUSE_CONFIG_MIN_LINE_REC * 100)}% zero-extra match. ${supersetNote}`,
    };
  }

  const bestReuse = pickBestReuse();
  if (bestReuse) {
    const bar = Math.round(REUSE_CONFIG_MIN_LINE_REC * 100);
    const pct = Math.round(bestReuse.lineRec * 100);
    const miss = bestReuse.missingLineCount;
    return {
      targetKey,
      winner: {
        key: bestReuse.key,
        batch: bestReuse.batch,
        week: bestReuse.week,
        reason: `best 0-extra subset B${bestReuse.batch}W${bestReuse.week} (${pct}% line coverage, 0 extra, ${miss} target unit(s) missing vs ${targetKey}; cross-week scan)`,
        matchType: "closest_subset",
        metrics: {
          lineRec: bestReuse.lineRec,
          lineExc: bestReuse.lineExc,
          rec: bestReuse.rec,
          exc: bestReuse.exc,
          extraUnits: bestReuse.extraLineCount,
          missingUnits: bestReuse.missingLineCount,
        },
      },
      steps,
      bestReuseCandidate: bestReuse,
      message: `No row with full target coverage or ≥${bar}% zero-extra match. ${bestReuse.key}: ${miss} target unit(s) missing, 0 extra (${pct}% coverage).`,
    };
  }

  const bestCaution = pickBestCaution();
  if (bestCaution) {
    const n = bestCaution.extraLineCount;
    const bar = Math.round(REUSE_CONFIG_MIN_LINE_REC * 100);
    const miss = bestCaution.missingLineCount;
    const caution =
      n === 1
        ? "1 extra unit is in the older syllabus vs target — reuse config only with caution after review."
        : "2 extra units are in the older syllabus vs target — reuse config only with caution after review.";
    return {
      targetKey,
      winner: {
        key: bestCaution.key,
        batch: bestCaution.batch,
        week: bestCaution.week,
        reason: `B${bestCaution.batch}W${bestCaution.week} (${n} extra, ${miss} target unit(s) still missing; caution only, |W−Wtarget|≤1)`,
        matchType: "reuse_caution",
        caution,
        metrics: {
          lineRec: bestCaution.lineRec,
          lineExc: bestCaution.lineExc,
          rec: bestCaution.rec,
          exc: bestCaution.exc,
          extraUnits: bestCaution.extraLineCount,
          missingUnits: bestCaution.missingLineCount,
        },
      },
      steps,
      bestReuseCandidate: bestCaution,
      message: `No full-coverage or ≥${bar}% zero-extra row. ${bestCaution.key}: ${caution} (${miss} target unit(s) still missing).`,
    };
  }

  return {
    targetKey,
    winner: null,
    steps,
    bestReuseCandidate: null,
    message: `No exact, no ≥${Math.round(
      REUSE_CONFIG_MIN_LINE_REC * 100
    )}% zero-extra row, no full target coverage with ≤${SUPERSET_REUSE_MAX_EXTRA_UNITS} extras, and no caution row at W${Tw} (B${Tb - 1}…B1).`,
  };
}
