// Manual "export results" download: patches a COPY of the master workbook with results from
// every run this dashboard has ever recorded and drops it in exports/. The per-day automatic
// sheet lives in testSheets.js; both share the stamping logic in workbookResults.js.
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./paths');
const { buildLatestResultIndex, buildWorkbook } = require('./workbookResults');
const { readRun } = require('./runStore');

const EXPORT_DIR = path.join(PROJECT_ROOT, 'exports');

// With `runId`, only that run's results are stamped (one run, nothing folded in from others);
// without it, every run ever recorded, latest result per Test ID and format.
async function exportToWorkbook({ runId = null } = {}) {
  const run = runId ? readRun(runId) : null;
  if (runId && !run) {
    const err = new Error(`Run ${runId} not found`);
    err.status = 404;
    throw err;
  }
  // A single run's export lists only the test data created while that run was going.
  const from = run ? Date.parse(run.startedAt) : null;
  const to = run ? Date.parse(run.finishedAt || new Date().toISOString()) : null;
  const dataLog = run ? (e) => Date.parse(e.timestamp) >= from && Date.parse(e.timestamp) <= to : null;
  const index = buildLatestResultIndex(runId ? (summary) => summary.id === runId : undefined);
  const { wb, matchedRows } = await buildWorkbook(index, { untouched: runId ? 'not-tested' : 'keep', dataLog });

  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = runId
    ? `TnT_QA_Test_Cases_${runId}_${stamp}.xlsx`
    : `TnT_QA_Test_Cases_export_${stamp}.xlsx`;
  const outPath = path.join(EXPORT_DIR, filename);
  await wb.xlsx.writeFile(outPath);

  return { outPath, filename, matchedRows, totalTracked: index.size };
}

module.exports = { exportToWorkbook, buildLatestResultIndex };
