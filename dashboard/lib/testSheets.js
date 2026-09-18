// Writes the day's test sheet to Test-sheets/<YYYY-MM-DD>/ when a run finishes.
//
// One rolling workbook per calendar day: every completed run from that day is folded in and
// the file is rewritten, so the sheet is always the current picture of that day's testing
// rather than a pile of partial snapshots. Latest result per Test ID wins, matching the
// manual export's behaviour.
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./paths');
const { buildLatestResultIndex, buildWorkbook, runDateKey } = require('./workbookResults');

const TEST_SHEETS_DIR = path.join(PROJECT_ROOT, 'Test-sheets');

function dayFolder(dateKey) {
  return path.join(TEST_SHEETS_DIR, dateKey);
}

function sheetFilename(dateKey) {
  return `TnT_QA_Test_Sheet_${dateKey}.xlsx`;
}

// `dateKey` defaults to today. Returns where the sheet landed plus what went into it.
async function writeDailyTestSheet(dateKey = runDateKey(new Date().toISOString())) {
  // A run counts towards the day it finished on - that's when its results existed. Runs
  // still in flight have no finishedAt and are skipped rather than written half-complete.
  const index = buildLatestResultIndex(
    (summary) => summary.finishedAt && runDateKey(summary.finishedAt) === dateKey
  );

  const { wb, matchedRows } = await buildWorkbook(index);

  const folder = dayFolder(dateKey);
  fs.mkdirSync(folder, { recursive: true });
  const outPath = path.join(folder, sheetFilename(dateKey));

  // Write to a temp file in the same folder, then rename over the target. A rename is
  // atomic on the same volume, so a reader (or Excel) never catches a half-written file if
  // two runs finish close together.
  const tempPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  await wb.xlsx.writeFile(tempPath);
  fs.renameSync(tempPath, outPath);

  return {
    dateKey,
    outPath,
    folder,
    filename: sheetFilename(dateKey),
    matchedRows,
    testIdsCovered: index.size,
  };
}

module.exports = { writeDailyTestSheet, TEST_SHEETS_DIR, dayFolder, sheetFilename };
