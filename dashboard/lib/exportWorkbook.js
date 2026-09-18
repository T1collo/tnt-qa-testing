// Manual "export results" download: patches a COPY of the master workbook with results from
// every run this dashboard has ever recorded and drops it in exports/. The per-day automatic
// sheet lives in testSheets.js; both share the stamping logic in workbookResults.js.
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./paths');
const { buildLatestResultIndex, buildWorkbook } = require('./workbookResults');

const EXPORT_DIR = path.join(PROJECT_ROOT, 'exports');

async function exportToWorkbook() {
  const index = buildLatestResultIndex(); // no filter - every run, all time
  const { wb, matchedRows } = await buildWorkbook(index);

  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const filename = `TnT_QA_Test_Cases_export_${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`;
  const outPath = path.join(EXPORT_DIR, filename);
  await wb.xlsx.writeFile(outPath);

  return { outPath, filename, matchedRows, totalTracked: index.size };
}

module.exports = { exportToWorkbook, buildLatestResultIndex };
