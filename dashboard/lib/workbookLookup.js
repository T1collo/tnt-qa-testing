// Reads TnT_QA_Test_Cases_Re-Revised_Master.xlsx (read-only, never mutated here) and builds
// a Test ID -> row-content lookup, so the Logs tab can show the workbook's own plain-English
// Description/Test Steps/Expected Result for a failing test instead of just raw HTTP output.
// Cached for the life of the server process - this file doesn't change while the app runs.
const path = require('path');
const ExcelJS = require('exceljs');
const { PROJECT_ROOT } = require('./paths');

const WORKBOOK_PATH = path.join(PROJECT_ROOT, 'TnT_QA_Test_Cases_Re-Revised_Master.xlsx');

const COLS = {
  testId: 1,
  description: 2,
  testSteps: 3,
  testData: 4,
  field: 5,
  expectedResult: 6,
};

// Kept on globalThis so dev-server module reloads do not re-read the workbook each time.
const cache = globalThis.__tntWorkbookLookup || (globalThis.__tntWorkbookLookup = { promise: null });

async function loadLookup() {
  if (!cache.promise) {
    cache.promise = (async () => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(WORKBOOK_PATH);
      const map = new Map();
      wb.eachSheet((sheet) => {
        for (let r = 1; r <= sheet.rowCount; r++) {
          const row = sheet.getRow(r);
          const testId = row.getCell(COLS.testId).value;
          if (typeof testId !== 'string' || !testId.trim() || testId === 'Test ID') continue;
          if (map.has(testId)) continue; // first occurrence wins (rows can be merged/duplicated in the source)
          map.set(testId, {
            testId,
            sheetName: sheet.name,
            rowNumber: r,
            description: row.getCell(COLS.description).value ?? null,
            testSteps: row.getCell(COLS.testSteps).value ?? null,
            testData: row.getCell(COLS.testData).value ?? null,
            field: row.getCell(COLS.field).value ?? null,
            expectedResult: row.getCell(COLS.expectedResult).value ?? null,
          });
        }
      });
      return map;
    })();
  }
  return cache.promise;
}

async function getRow(testId) {
  const map = await loadLookup();
  return map.get(testId) || null;
}

module.exports = { loadLookup, getRow, WORKBOOK_PATH };
