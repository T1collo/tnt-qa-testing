// Full run detail for the Dashboard/Logs tabs. Failed results are enriched with the
// workbook's own Description/Test Steps/Expected Result so Logs can show a plain-English
// explanation next to the raw request/response, instead of just the raw HTTP output.
const { readRun } = require('./runStore');
const { getRow } = require('./workbookLookup');

async function runDetail(id) {
  const run = readRun(id);
  if (!run) return null;
  const results = await Promise.all(
    run.results.map(async (r) => ({
      ...r,
      workbook: r.ok ? null : await getRow(r.testId),
    }))
  );
  return { ...run, results };
}

module.exports = { runDetail };
