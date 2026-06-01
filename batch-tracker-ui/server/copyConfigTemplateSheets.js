/**
 * Copy batch “config link” workbook tabs into a destination spreadsheet.
 * Full tab clone (preserves formatting / hyperlinks) for four config sheets;
 * Test Links: only the B cell on the row whose A column matches
 * “Main Assessment Config Link - Testing”.
 */

const TABS_FULL_COPY = [
  "Mock Assessment Config",
  "Main Assessment Config",
  "Mock Interview Config",
  "Main Interview Config",
];

const TEST_LINKS_TAB = "Test Links";

/** Column A label in Test Links (normalized contains all tokens). */
const MAIN_ASSESSMENT_TESTING_TOKENS = ["main", "assessment", "config", "link", "testing"];

function escapeSheetTitle(title) {
  return String(title).replace(/'/g, "''");
}

function normalizeCellLabel(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rowMatchesMainAssessmentTestingColumnA(label) {
  const n = normalizeCellLabel(label);
  if (!n) return false;
  return MAIN_ASSESSMENT_TESTING_TOKENS.every((t) => n.includes(t));
}

async function getSheetMetaByTitle(sheetsApi, spreadsheetId) {
  const { data } = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const byTitle = new Map();
  for (const sh of data.sheets || []) {
    const t = sh.properties?.title;
    const id = sh.properties?.sheetId;
    if (t != null && id != null) byTitle.set(t, id);
  }
  return byTitle;
}

async function getSheetIdByTitle(sheetsApi, spreadsheetId, title) {
  const m = await getSheetMetaByTitle(sheetsApi, spreadsheetId);
  return m.get(title) ?? null;
}

/** Rename a tab (used to free a canonical title before copyTo, or to fix "Copy of …" names). */
async function updateSheetTitle(sheetsApi, spreadsheetId, sheetId, newTitle) {
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId, title: newTitle },
            fields: "title",
          },
        },
      ],
    },
  });
}

/**
 * Find 1-based row index where column A matches the Main Assessment … Testing label.
 */
async function findTestLinksRow1Based(sheetsApi, spreadsheetId, maxRows = 80) {
  const safe = escapeSheetTitle(TEST_LINKS_TAB);
  const { data } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `'${safe}'!A1:A${maxRows}`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const rows = data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]?.[0];
    if (rowMatchesMainAssessmentTestingColumnA(a)) return i + 1;
  }
  return null;
}

/**
 * Read cell B at row (formula if present, else value).
 */
async function getCellBFormulaOrValue(sheetsApi, spreadsheetId, row1Based) {
  const safe = escapeSheetTitle(TEST_LINKS_TAB);
  const a1 = `'${safe}'!B${row1Based}:B${row1Based}`;
  const { data } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: a1,
    valueRenderOption: "FORMULA",
  });
  const v = data.values?.[0]?.[0];
  if (v != null && String(v).startsWith("=")) return String(v);
  const { data: data2 } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: a1,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const v2 = data2.values?.[0]?.[0];
  return v2 == null ? "" : String(v2);
}

/**
 * @param {import("googleapis").sheets_v4.Sheets} sheetsApi
 * @param {string} sourceSpreadsheetId
 * @param {string} destinationSpreadsheetId
 */
export async function copyConfigTemplateSheets(sheetsApi, sourceSpreadsheetId, destinationSpreadsheetId) {
  const sourceId = String(sourceSpreadsheetId || "").trim();
  const destId = String(destinationSpreadsheetId || "").trim();
  if (!sourceId || !destId) {
    throw new Error("sourceSpreadsheetId and destinationSpreadsheetId are required.");
  }
  if (sourceId === destId) {
    throw new Error("Source and destination must be different spreadsheets.");
  }

  const sourceMeta = await getSheetMetaByTitle(sheetsApi, sourceId);

  const copied = [];
  const skippedTabs = [];

  /**
   * Replace each config tab without leaving "Copy of …" names:
   * if the destination already has that title, rename it to a temp title so
   * copyTo can create a sheet with the canonical name, then delete the old tab.
   * If the tab is missing, copyTo alone creates it with the source tab name.
   */
  for (const title of TABS_FULL_COPY) {
    const srcSheetId = sourceMeta.get(title);
    if (srcSheetId == null) {
      skippedTabs.push({ title, reason: "missing on source" });
      continue;
    }

    const destMetaNow = await getSheetMetaByTitle(sheetsApi, destId);
    const oldDestSheetId = destMetaNow.get(title) ?? null;

    if (oldDestSheetId != null) {
      const tmpTitle = `__tmp_bt_${oldDestSheetId}_${Date.now()}`.slice(0, 100);
      await updateSheetTitle(sheetsApi, destId, oldDestSheetId, tmpTitle);
    }

    let newProps;
    try {
      const { data } = await sheetsApi.spreadsheets.sheets.copyTo({
        spreadsheetId: sourceId,
        sheetId: srcSheetId,
        destinationSpreadsheetId: destId,
      });
      newProps = data;
    } catch (err) {
      if (oldDestSheetId != null) {
        try {
          await updateSheetTitle(sheetsApi, destId, oldDestSheetId, title);
        } catch {
          /* best-effort restore tab title */
        }
      }
      throw err;
    }

    const newSheetId = newProps?.sheetId;
    if (newSheetId == null) {
      if (oldDestSheetId != null) {
        try {
          await updateSheetTitle(sheetsApi, destId, oldDestSheetId, title);
        } catch {
          /* best-effort restore */
        }
      }
      skippedTabs.push({ title, reason: "copyTo returned no sheetId" });
      continue;
    }

    if (oldDestSheetId != null) {
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: destId,
        requestBody: { requests: [{ deleteSheet: { sheetId: oldDestSheetId } }] },
      });
    }

    if (newProps.title !== title) {
      await updateSheetTitle(sheetsApi, destId, newSheetId, title);
    }

    copied.push(title);
  }

  const destTestLinksId = (await getSheetMetaByTitle(sheetsApi, destId)).get(TEST_LINKS_TAB);
  if (destTestLinksId == null) {
    return {
      copied,
      skippedTabs,
      testLinks: {
        ok: false,
        reason: `Destination has no tab named "${TEST_LINKS_TAB}". Create it (with the usual A-column labels), then run again.`,
      },
    };
  }

  const srcTestId = sourceMeta.get(TEST_LINKS_TAB);
  if (srcTestId == null) {
    return {
      copied,
      skippedTabs,
      testLinks: { ok: false, reason: `Source has no tab "${TEST_LINKS_TAB}".` },
    };
  }

  const srcRow = await findTestLinksRow1Based(sheetsApi, sourceId);
  const dstRow = await findTestLinksRow1Based(sheetsApi, destId);
  if (!srcRow) {
    return {
      copied,
      skippedTabs,
      testLinks: {
        ok: false,
        reason: `Could not find row in source "${TEST_LINKS_TAB}" whose column A matches Main Assessment Config Link — Testing.`,
      },
    };
  }
  if (!dstRow) {
    return {
      copied,
      skippedTabs,
      testLinks: {
        ok: false,
        reason: `Could not find matching row in destination "${TEST_LINKS_TAB}" (column A). Add a row labeled like the source (Main Assessment Config Link — Testing), then retry.`,
      },
    };
  }

  const bValue = await getCellBFormulaOrValue(sheetsApi, sourceId, srcRow);
  const safe = escapeSheetTitle(TEST_LINKS_TAB);
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: destId,
    range: `'${safe}'!B${dstRow}:B${dstRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[bValue]] },
  });

  return {
    copied,
    skippedTabs,
    testLinks: {
      ok: true,
      sourceRow: srcRow,
      destinationRow: dstRow,
      pastedPreview: bValue.length > 120 ? `${bValue.slice(0, 120)}…` : bValue,
    },
  };
}
