// Shared machinery for stamping run results into a COPY of
// TnT_QA_Test_Cases_Re-Revised_Master.xlsx. Used by both the manual export (exports/) and
// the automatic per-day test sheet (Test-sheets/<date>/), so the two can never drift into
// producing differently-shaped workbooks.
//
// Only rows whose Test ID column matches something actually run get Actual Result/STATUS/
// COMMENTS overwritten; every other row (the ~600 covering UI flows and edge cases this
// repo doesn't automate) is left exactly as it was. The source file is never mutated.
const path = require('path');
const ExcelJS = require('exceljs');
const { PROJECT_ROOT } = require('./paths');
const { listRuns, readRun } = require('./runStore');

const WORKBOOK_PATH = path.join(PROJECT_ROOT, 'TnT_QA_Test_Cases_Re-Revised_Master.xlsx');

const COLS = { testId: 1, actualResult: 7, status: 8, comments: 9 };

const PASS_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
const PASS_FONT = { color: { argb: 'FF006100' } };
const FAIL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
const FAIL_FONT = { color: { argb: 'FF9C0006' } };

// The local calendar day a run belongs to, as YYYY-MM-DD. Deliberately local rather than
// UTC: an 8pm run in GMT+3 is already "tomorrow" in UTC, and would file itself under a date
// nobody was working on. en-CA is the terse way to get ISO-ordered local date parts.
function runDateKey(isoTimestamp) {
  return new Date(isoTimestamp).toLocaleDateString('en-CA');
}

// Folds run results into one Test ID -> {result, run} map. Runs are read oldest-first so a
// later run's result for the same Test ID (a re-run, or another role covering a shared
// workbook row) naturally overwrites an earlier one - the output always reflects the most
// recently known outcome, not a stale first-ever result.
// `filter(summary)` optionally narrows which runs are folded in.
function buildLatestResultIndex(filter) {
  const summaries = [...listRuns()].reverse(); // listRuns() is newest-first; we want oldest-first
  const index = new Map();
  for (const summary of summaries) {
    if (filter && !filter(summary)) continue;
    const run = readRun(summary.id);
    if (!run) continue;
    for (const result of run.results) {
      // A skipped step was never sent, so it has no outcome - and letting it into the
      // latest-wins index would hide an earlier real result for the same Test ID.
      if (result.skipped) continue;
      index.set(result.testId, { result, run });
    }
  }
  return index;
}

function summarizeActualResult(result) {
  const parts = (result.variants || []).map((v) => {
    if (v.error) return `${v.variant}: network error (${v.error})`;
    return `${v.variant}: HTTP ${v.status}`;
  });
  if (parts.length === 0 && result.error) return result.error;
  return parts.join('; ') || 'no response captured';
}

// Reads a fresh copy of the master workbook and stamps `index` into it.
async function buildWorkbook(index) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WORKBOOK_PATH); // fresh read every time - never mutate the source

  let matchedRows = 0;
  wb.eachSheet((sheet) => {
    for (let r = 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const testId = row.getCell(COLS.testId).value;
      if (typeof testId !== 'string' || !index.has(testId)) continue;

      const { result, run } = index.get(testId);
      matchedRows += 1;

      const statusCell = row.getCell(COLS.status);
      row.getCell(COLS.actualResult).value = summarizeActualResult(result);
      statusCell.value = result.ok ? 'PASS' : 'FAIL';
      statusCell.fill = result.ok ? PASS_FILL : FAIL_FILL;
      statusCell.font = { ...statusCell.font, ...(result.ok ? PASS_FONT : FAIL_FONT) };
      row.getCell(COLS.comments).value =
        `Automated via QA Dashboard - run ${run.id} (${run.role}) at ${run.finishedAt || run.startedAt}.`;
    }
  });

  return { wb, matchedRows };
}

module.exports = { buildLatestResultIndex, buildWorkbook, runDateKey, WORKBOOK_PATH };
