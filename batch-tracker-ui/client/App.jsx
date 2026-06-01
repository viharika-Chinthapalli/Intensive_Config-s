import { useMemo, useState } from "react";

function extractSpreadsheetId(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  if (/^[a-zA-Z0-9-_]{30,}$/.test(s)) return s;
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}

/** One target per line: "7 7", "B7W7", or "7,7". */
function parseAlignTargetsFromText(s) {
  const out = [];
  for (const line of String(s).split(/\r?\n/)) {
    const L = line.trim();
    if (!L) continue;
    let m = L.match(/^B\s*(\d+)\s*W\s*(\d+)$/i);
    if (!m) m = L.match(/^(\d+)\s+(\d+)\s*$/);
    if (!m) m = L.match(/^(\d+)\s*,\s*(\d+)\s*$/);
    if (!m) m = L.match(/^(\d+)\s*\/\s*(\d+)\s*$/);
    if (m) out.push({ batch: Number(m[1]), week: Number(m[2]) });
  }
  return out;
}

function alignWinnerLabel(matchType) {
  switch (matchType) {
    case "exact":
      return "Exact";
    case "reuse_config":
      return "Reuse config";
    case "reuse_superset":
      return "Superset (trim extras)";
    case "reuse_caution":
      return "Caution";
    case "closest_subset":
      return "Subset";
    default:
      return matchType || "—";
  }
}

function alignRunsFromResponse(data) {
  if (!data) return [];
  if (Array.isArray(data.alignRuns) && data.alignRuns.length) return data.alignRuns;
  if (data.targetKey) return [data];
  return [];
}

/** Drop ranked-pool arrays before React state — UI only uses winner, steps, message, etc. */
const ALIGN_RUN_STRIP_KEYS = [
  "supersetReuseCandidatesRanked",
  "reuseCandidatesRanked",
  "cautionReuseCandidatesRanked",
  "exactMatchesFound",
];

function sanitizeAlignApiPayloadForUi(data) {
  if (!data || typeof data !== "object") return data;
  const next = { ...data };
  if (Array.isArray(next.alignRuns)) {
    next.alignRuns = next.alignRuns.map((run) => {
      if (!run || typeof run !== "object") return run;
      const r = { ...run };
      for (const k of ALIGN_RUN_STRIP_KEYS) delete r[k];
      return r;
    });
  }
  return next;
}

/** Read body as text then JSON — avoids opaque errors when API is down or returns HTML. */
async function parseJsonResponse(res) {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(
      `Empty response (HTTP ${res.status}). The API server may not be running — check the terminal for "Batch tracker API" on port 8787, or run: npm run dev:server`
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 400)}`);
  }
}

export default function App() {
  const [trackerInput, setTrackerInput] = useState("");
  const [sheetTitles, setSheetTitles] = useState([]);
  const [masterSheetName, setMasterSheetName] = useState("Phase1 - Status");
  const [alignTargetsText, setAlignTargetsText] = useState("7 10");
  const [linkedSyllabusTabAlign, setLinkedSyllabusTabAlign] = useState("Syllabus");
  const [skipMasterHeaderRows, setSkipMasterHeaderRows] = useState(1);
  const [masterLastRow, setMasterLastRow] = useState(3000);
  const [alignResult, setAlignResult] = useState(null);
  /** Per-target copy summary (key = e.g. B7W7) so multiple align targets each keep their own "Done" block. */
  const [configCopyResultsByTarget, setConfigCopyResultsByTarget] = useState({});
  /** Per-target: true while that row’s config copy request is in flight (several can run at once). */
  const [configCopyLoadingKeys, setConfigCopyLoadingKeys] = useState({});

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const spreadsheetId = useMemo(() => extractSpreadsheetId(trackerInput), [trackerInput]);

  const cfgColLetters = useMemo(() => {
    const m = alignResult?.masterAlignMeta;
    if (!m?.configTemplateColumnLetter) return { tmpl: "—", dest: "—" };
    return {
      tmpl: m.configTemplateColumnLetter,
      dest: m.configDestinationColumnLetter || "—",
    };
  }, [alignResult]);

  async function loadSheetTabs() {
    setError("");
    if (!spreadsheetId) {
      setError("Paste a spreadsheet URL or ID first.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/spreadsheet/sheets?spreadsheetId=${encodeURIComponent(spreadsheetId)}`);
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error || data.hint || res.statusText);
      setSheetTitles(data.sheetTitles || []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runAlignFromMaster() {
    setError("");
    setAlignResult(null);
    setConfigCopyResultsByTarget({});
    setConfigCopyLoadingKeys({});
    if (!spreadsheetId) {
      setError("Paste the master tracker spreadsheet URL or ID.");
      return;
    }
    if (!masterSheetName.trim()) {
      setError("Enter the master tracker tab name (e.g. Phase1 - Status).");
      return;
    }
    const targets = parseAlignTargetsFromText(alignTargetsText);
    if (!targets.length) {
      setError("Add at least one target line (batch and week, e.g. 7 7 or B7W7).");
      return;
    }
    if (targets.some((t) => t.batch < 2 || t.week < 1)) {
      setError("Each target needs batch ≥ 2 and week ≥ 1.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/syllabus-align-from-master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          masterSpreadsheetId: spreadsheetId,
          masterSheetName: masterSheetName.trim(),
          targets,
          linkedSyllabusTabName: linkedSyllabusTabAlign.trim() || "Syllabus",
          skipMasterHeaderRows: skipMasterHeaderRows,
          masterLastRow: masterLastRow,
        }),
      });
      const data = await parseJsonResponse(res);
      if (!res.ok) {
        const base = [data.error, data.hint].filter(Boolean).join("\n") || res.statusText;
        const dbg = data.alignRuns?.[0]?.debug || data.debug;
        const tabList =
          Array.isArray(data.availableSheetTabs) && data.availableSheetTabs.length && !base.includes("Tabs in this file")
            ? `\nTabs in pasted spreadsheet: ${data.availableSheetTabs.join(" · ")}`
            : "";
        const extra = dbg ? `\n${JSON.stringify(dbg, null, 2)}` : "";
        throw new Error(base + tabList + extra);
      }
      setAlignResult(sanitizeAlignApiPayloadForUi(data));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runCopyConfigTemplateFor(run, runKeyForLoading) {
    setError("");
    const tk = run?.targetKey;
    if (tk) {
      setConfigCopyResultsByTarget((prev) => {
        const next = { ...prev };
        delete next[tk];
        return next;
      });
    }
    const srcFinal = run?.configTemplateSpreadsheetId || "";
    const destFinal = run?.configDestinationSpreadsheetId || run?.configSpreadsheetId || "";
    const reuseKey = run?.winner?.key || run?.bestReuseCandidate?.key || "";
    const tmplCol = alignResult?.masterAlignMeta?.configTemplateColumnLetter || cfgColLetters.tmpl;

    if (!srcFinal) {
      setError(
        `No config workbook link on the align winner row (${reuseKey || "reuse row"}) in column ${tmplCol}. That row needs an Insert link to the batch config spreadsheet to copy from. Run Align again after fixing the tracker.`
      );
      return;
    }
    if (!destFinal) {
      setError(
        `No config workbook link on the **target** row (${run?.targetKey || "target"}) in column ${tmplCol}. Add the batch config Insert link for this target, then run Align again.`
      );
      return;
    }

    if (srcFinal === destFinal) {
      setError(
        "Template and destination are the same spreadsheet for this target. Nothing to copy — use different batch links on the tracker or pick another align outcome."
      );
      return;
    }

    const copyKey = runKeyForLoading ?? run?.targetKey ?? "__copy__";
    setConfigCopyLoadingKeys((prev) => ({ ...prev, [copyKey]: true }));
    try {
      const res = await fetch("/api/copy-config-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceSpreadsheetId: srcFinal,
          destinationSpreadsheetId: destFinal,
        }),
      });
      const data = await parseJsonResponse(res);
      if (!res.ok) {
        const msg = [data.error, data.hint].filter(Boolean).join("\n");
        throw new Error(msg || res.statusText);
      }
      if (run.targetKey) {
        setConfigCopyResultsByTarget((prev) => ({ ...prev, [run.targetKey]: data }));
      }
      if (data.destinationUrl) window.open(data.destinationUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setConfigCopyLoadingKeys((prev) => {
        const next = { ...prev };
        delete next[copyKey];
        return next;
      });
    }
  }

  return (
    <>
      <h1>Master syllabus align</h1>

      <div className="card">
        <h2>Master tracker spreadsheet</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Paste the <strong>tracker</strong> Google Sheet URL or ID — not the batch workbook opened from column I.
        </p>
        <label htmlFor="tracker">Master spreadsheet ID or URL</label>
        <input
          id="tracker"
          placeholder="https://docs.google.com/spreadsheets/d/…/edit"
          value={trackerInput}
          onChange={(e) => setTrackerInput(e.target.value)}
        />
        {spreadsheetId ? (
          <p className="sub" style={{ marginTop: "0.65rem", marginBottom: 0 }}>
            Resolved ID: <code style={{ color: "var(--accent)" }}>{spreadsheetId}</code>
          </p>
        ) : null}
      </div>

      <div className="card" style={{ borderColor: "#2a6b3f" }}>
        <h2>Align</h2>
        <label htmlFor="mastersheet">Master tab (on the tracker file)</label>
        <input
          id="mastersheet"
          list="spreadsheet-sheet-tabs"
          placeholder="Phase1 - Status"
          value={masterSheetName}
          onChange={(e) => setMasterSheetName(e.target.value)}
        />
        <label htmlFor="align-targets" style={{ display: "block", marginTop: "0.75rem" }}>
          Targets (one per line: <code>7 7</code>, <code>B8W10</code>, or <code>7,10</code>)
        </label>
        <textarea
          id="align-targets"
          rows={4}
          value={alignTargetsText}
          onChange={(e) => setAlignTargetsText(e.target.value)}
          style={{ width: "100%", maxWidth: "32rem", fontFamily: "inherit", marginTop: "0.25rem" }}
        />
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <div>
            <label htmlFor="linkedtab">Linked workbook tab</label>
            <input id="linkedtab" value={linkedSyllabusTabAlign} onChange={(e) => setLinkedSyllabusTabAlign(e.target.value)} />
          </div>
          <div>
            <label htmlFor="skipmaster">Skip master header rows</label>
            <input
              id="skipmaster"
              type="number"
              min={0}
              max={10}
              value={skipMasterHeaderRows}
              onChange={(e) => setSkipMasterHeaderRows(Number(e.target.value))}
            />
          </div>
          <div>
            <label htmlFor="masterlast">Read master through row</label>
            <input
              id="masterlast"
              type="number"
              min={50}
              max={5000}
              value={masterLastRow}
              onChange={(e) => setMasterLastRow(Number(e.target.value))}
            />
          </div>
        </div>
        <div className="actions" style={{ marginTop: "0.85rem" }}>
          <button type="button" className="btn-secondary" disabled={loading} onClick={loadSheetTabs}>
            Load tab names
          </button>
          <button type="button" className="btn-primary" disabled={loading} onClick={runAlignFromMaster}>
            {loading ? "Working…" : "Run align"}
          </button>
        </div>
      </div>

      <datalist id="spreadsheet-sheet-tabs">
        {sheetTitles.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      {alignResult ? (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h2>Results</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            {alignResult.externalWorkbooksLoaded} workbooks · cache {alignResult.syllabusCache?.thisRequest?.hits ?? "—"}/
            {alignResult.syllabusCache?.thisRequest?.fetched ?? "—"} · rows {alignResult.dataStartRow}–
            {alignResult.masterLastRowRead ?? "—"}
            {alignResult.masterAlignMeta?.masterLastRowClampedToGrid ? (
              <>
                {" "}
                (requested through row {alignResult.masterAlignMeta.masterLastRowRequested}; tab grid ends at{" "}
                {alignResult.masterAlignMeta.sheetGridRowCount ?? "?"})
              </>
            ) : null}{" "}
            · see <code>rowSnapshots</code> in Network response.
          </p>
          {alignRunsFromResponse(alignResult).map((run, runIdx) => {
            const w = run.winner;
            const ok =
              w && (w.matchType === "exact" || w.matchType === "reuse_config" || w.matchType === "reuse_superset");
            const m = w?.metrics;
            const runKey = run.targetKey || `target-${runIdx}`;
            const destConfigId = run.configDestinationSpreadsheetId || run.configSpreadsheetId || "";
            const tmplConfigId = run.configTemplateSpreadsheetId || "";
            const reuseRowKey = run.winner?.key || run.bestReuseCandidate?.key || "";
            const copyRes = configCopyResultsByTarget[runKey];
            return (
              <div
                key={runKey}
                style={{
                  marginTop: "1rem",
                  paddingTop: "0.75rem",
                  borderTop: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <h3 style={{ margin: "0 0 0.5rem" }}>{runKey}</h3>
                {run.error ? (
                  <p className="msg error" style={{ marginTop: 0 }}>
                    {run.error}
                  </p>
                ) : null}
                {!run.error && w ? (
                  <p
                    className={ok ? "msg ok" : "msg"}
                    style={{
                      marginTop: 0,
                      ...(!ok
                        ? {
                            background: "rgba(255,176,32,0.08)",
                            borderColor: "rgba(255,176,32,0.35)",
                            color: "#ffe0a8",
                          }
                        : {}),
                    }}
                  >
                    <strong>{alignWinnerLabel(w.matchType)}:</strong> {w.key}
                    <span className="sub" style={{ display: "block", marginTop: "0.35rem" }}>
                      {w.reason}
                    </span>
                    {w.supersetNote ? (
                      <span className="sub" style={{ display: "block", marginTop: "0.35rem", color: "#b8f4c8" }}>
                        {w.supersetNote}
                      </span>
                    ) : null}
                    {w.caution ? (
                      <span className="sub" style={{ display: "block", marginTop: "0.35rem", color: "#ffb86c" }}>
                        {w.caution}
                      </span>
                    ) : null}
                    {m ? (
                      <span className="sub" style={{ display: "block", marginTop: "0.35rem" }}>
                        Coverage {Math.round((m.lineRec ?? 0) * 100)}% · missing {m.missingUnits ?? 0} · extra{" "}
                        {m.extraUnits ?? 0}
                      </span>
                    ) : null}
                  </p>
                ) : null}
                {!run.error && !w ? (
                  <p className="msg error" style={{ marginTop: 0 }}>
                    {run.message || "No winner."}
                    {run.bestReuseCandidate ? (
                      <>
                        {" "}
                        Near: <strong>{run.bestReuseCandidate.key}</strong>
                      </>
                    ) : null}
                  </p>
                ) : null}
                <details style={{ marginTop: "0.65rem" }}>
                  <summary>Steps ({(run.steps || []).length})</summary>
                  <table>
                    <thead>
                      <tr>
                        <th>Key</th>
                        <th>Class</th>
                        <th>Coverage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(run.steps || []).map((s, i) => (
                        <tr key={`${runKey}-${s.key}-${i}`}>
                          <td>{s.key}</td>
                          <td>{s.classification || "—"}</td>
                          <td>
                            {s.metrics
                              ? `${Math.round(s.metrics.lineRec * 100)}% · miss ${s.metrics.missingUnits ?? 0} · ex ${s.metrics.extraUnits ?? 0}`
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
                <details style={{ marginTop: "0.5rem" }}>
                  <summary>Target preview</summary>
                  <pre style={{ whiteSpace: "pre-wrap", maxHeight: "160px", overflow: "auto", fontSize: "0.82rem" }}>
                    {run.targetSyllabusPreview || "—"}
                  </pre>
                </details>
                <div
                  style={{
                    marginTop: "1rem",
                    paddingTop: "1rem",
                    borderTop: "1px solid rgba(255,255,255,0.08)",
                  }}
                >
                  <h4 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem" }}>Config update</h4>
                  <dl style={{ margin: "0.5rem 0 0", fontSize: "0.95rem" }}>
                    <dt style={{ opacity: 0.85 }}>
                      Template source ({cfgColLetters.tmpl}
                      {reuseRowKey ? ` · ${reuseRowKey}` : ""})
                    </dt>
                    <dd style={{ margin: "0.2rem 0 0.5rem" }}>
                      {tmplConfigId ? (
                        <code style={{ wordBreak: "break-all" }}>{tmplConfigId}</code>
                      ) : (
                        <span style={{ color: "#ffb86c" }}>
                          — add link in {cfgColLetters.tmpl} on the winner row
                        </span>
                      )}
                    </dd>
                    <dt style={{ opacity: 0.85 }}>
                      Destination ({cfgColLetters.tmpl} · {runKey})
                    </dt>
                    <dd style={{ margin: "0.2rem 0 0" }}>
                      {destConfigId ? (
                        <code style={{ wordBreak: "break-all" }}>{destConfigId}</code>
                      ) : (
                        <span style={{ color: "#ffb86c" }}>
                          — add link in {cfgColLetters.tmpl} on this target row
                        </span>
                      )}
                    </dd>
                  </dl>
                  <div className="actions" style={{ marginTop: "0.85rem" }}>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={
                        loading ||
                        Boolean(configCopyLoadingKeys[runKey]) ||
                        Boolean(run.error) ||
                        !tmplConfigId ||
                        !destConfigId
                      }
                      onClick={() => runCopyConfigTemplateFor(run, runKey)}
                    >
                      {configCopyLoadingKeys[runKey] ? "Working…" : "Copy template → destination & open"}
                    </button>
                  </div>
                  {copyRes ? (
                    <div className="msg ok" style={{ marginTop: "0.75rem" }}>
                      <strong>Done ({runKey}).</strong> Copied: {(copyRes.copied || []).join(", ") || "—"}
                      {(copyRes.skippedTabs || []).length ? (
                        <span className="sub" style={{ display: "block", marginTop: "0.35rem" }}>
                          Skipped: {copyRes.skippedTabs.map((s) => `${s.title} (${s.reason})`).join("; ")}
                        </span>
                      ) : null}
                      {copyRes.testLinks ? (
                        <span className="sub" style={{ display: "block", marginTop: "0.35rem" }}>
                          Test Links:{" "}
                          {copyRes.testLinks.ok
                            ? `updated B on row ${copyRes.testLinks.destinationRow} (from template row ${copyRes.testLinks.sourceRow})`
                            : copyRes.testLinks.reason}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          {(alignResult.linkErrors || []).length ? (
            <details style={{ marginTop: "0.75rem" }}>
              <summary>Link issues ({alignResult.linkErrors.length})</summary>
              <pre style={{ fontSize: "0.82rem" }}>{JSON.stringify(alignResult.linkErrors, null, 2)}</pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="msg error" role="alert">
          {error}
        </div>
      ) : null}

      <footer>
        Backend uses a Google service account with Sheets access. See <code>README.md</code> in{" "}
        <code>batch-tracker-ui</code> for setup. Sheets API:{" "}
        <a href="https://developers.google.com/sheets/api">Google Sheets API</a>.
      </footer>
    </>
  );
}
