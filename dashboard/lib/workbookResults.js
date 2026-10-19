// Shared machinery for stamping run results into a COPY of
// TnT_QA_Test_Cases_Re-Revised_Master.xlsx. Used by both the manual export (exports/) and
// the automatic per-day test sheet (Test-sheets/<date>/), so the two can never drift into
// producing differently-shaped workbooks.
//
// Rows whose Test ID matches something actually run get Actual Result/STATUS/COMMENTS from
// that run. Every other test row is then completed (completeTestRows) so the output never has
// an empty STATUS or Actual Result: each row ends as PASS, FAIL or NOT TESTED. The source file
// is never mutated.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { PROJECT_ROOT } = require('./paths');
const { listRuns, readRun } = require('./runStore');
const { CASE_DECISIONS } = require('./caseDecisions');
const { reasonForResult, reasonFromApiResponse, actualFromTestError } = require('./failureReason');

const WORKBOOK_PATH = path.join(PROJECT_ROOT, 'TnT_QA_Test_Cases_Re-Revised_Master.xlsx');
// Everything the tests created (tests/helpers/datalog.js), listed for reuse and cleanup.
const ENTITY_LOG_PATH = path.join(PROJECT_ROOT, 'run_data', 'created-entities.json');

// The master's standard layout. Sheets differ (Partner portal has no Field column), so the
// real positions are read from each table's own header row; these are the fallback.
const COLS = { testId: 1, description: 2, steps: 3, data: 4, field: 5, expected: 6, actualResult: 7, status: 8, comments: 9 };
const HEADER_KEYS = {
  'description': 'description',
  'test steps': 'steps',
  'test data': 'data',
  'field': 'field',
  'expected result': 'expected',
  'actual result': 'actualResult',
  'status': 'status',
  'comments': 'comments',
};

// Column positions from a "Test ID | Description | ..." header row, or null if it is not one.
function headerColumns(row) {
  if (String(row.getCell(1).text).trim().toLowerCase() !== 'test id') return null;
  const cols = { testId: 1 };
  row.eachCell((cell, c) => {
    const key = HEADER_KEYS[String(cell.text).trim().toLowerCase()];
    if (key) cols[key] = c;
  });
  // Some tables leave the "Actual Result" header cell blank; the column just left of STATUS
  // is then the actual result, as everywhere else in the workbook - unless it is taken.
  if (!cols.actualResult && cols.status > 1 && !Object.values(cols).includes(cols.status - 1)) {
    cols.actualResult = cols.status - 1;
  }
  return cols;
}

const PASS_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
const PASS_FONT = { color: { argb: 'FF006100' } };
const FAIL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
const FAIL_FONT = { color: { argb: 'FF9C0006' } };
// Excel's own "Neutral" yellow, matching its Good (green) / Bad (red) pair above.
const NOT_TESTED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' } };
const NOT_TESTED_FONT = { color: { argb: 'FF9C5700' } };

// The only verdicts the output carries. Anything else the master holds is mapped onto them,
// and the original wording is kept in COMMENTS so nothing is silently lost.
const STATUS_MAP = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  'FAIL / PENDING': 'FAIL',
  'NOT TESTED': 'NOT TESTED',
  BLOCKED: 'NOT TESTED',
  'N/A': 'NOT TESTED',
  PENDING: 'NOT TESTED',
  'NEEDS CONFIRMATION': 'NOT TESTED',
};

// A test case row: an ID-shaped first cell (AUTH-001, TL-1596-FAC-TC01, ED-MFG-01-DNO, and the
// per-format "<id> · XML" rows) with a description beside it. Section titles, header rows,
// blank spacers and the Intro / Test Data Log sheets do not match.
const TEST_ID_SHAPE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/;

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
//
// Latest-wins applies per format as well: the end-to-end journey sends JSON-LD only, so a
// journey run after a per-role run must replace that run's JSON-LD outcome without wiping
// its XML one. Each entry therefore carries the newest variant of each format, and `result`
// is rebuilt from them (ok only when every format's latest outcome passed).
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
      const entry = index.get(result.testId) || { byFormat: new Map() };
      entry.latest = { result, run };
      for (const v of result.variants || []) entry.byFormat.set(v.variant, { variant: v, run });
      index.set(result.testId, entry);
    }
  }
  for (const entry of index.values()) {
    const { result, run } = entry.latest;
    const formats = [...entry.byFormat.values()];
    entry.run = run;
    entry.formats = formats;
    entry.result = formats.length
      ? { ...result, variants: formats.map((f) => f.variant), ok: formats.every((f) => f.variant.ok) }
      : result;
  }
  return index;
}

function summarizeActualResult(result) {
  // Actual Result is the exact outcome observed - what the test saw or the platform answered.
  // Why a failure happened goes to COMMENTS (see failureComment), never in here.
  const parts = (result.variants || []).map((v) => {
    if (v.method === 'UI') {
      if (v.actual) return v.actual;
      return v.ok ? 'Passed in the browser' : actualFromTestError(v.errorDetail || v.error);
    }
    if (v.error && !v.status) return `${v.variant}: network error (${v.error})`;
    return `${v.variant}: ${describeResponse(v)}`;
  });
  if (parts.length === 0 && result.error) return result.error;
  return parts.join('; ') || 'no response captured';
}

// COMMENTS for a stamped row: on a failure the plain-English reason comes first, then where
// the result came from. Recomputed from the variants shown, which may come from several runs.
function failureComment(result, ok, stamp, extra = '') {
  const source = `Automated via QA Dashboard - ${stamp}.${extra}`;
  if (ok) return source;
  // Recomputed at export time so older runs pick up the current plain-English wording; a
  // reason the test wrote itself is kept on its variant and still wins.
  const why = reasonForResult({ ...result, reason: undefined });
  return `Failed because: ${why} | ${source}`;
}

// What the platform said, in one line: the error code and message, or "accepted" plus any
// warning codes. Falls back to the raw text when the body is not JSON.
function describeResponse(variant) {
  if (variant.error) return `network error (${variant.error})`;
  let body = null;
  try {
    body = JSON.parse(variant.responseBody || '');
  } catch {
    return `HTTP ${variant.status}${variant.responseBody ? ` - ${String(variant.responseBody).slice(0, 200)}` : ''}`;
  }
  if (body?.code) return `HTTP ${variant.status} ${body.code} - ${body.message || ''}`.trim();
  const warnings = (body?.warnings || []).map((w) => w.code).filter(Boolean);
  const unique = [...new Set(warnings)];
  return `HTTP ${variant.status} accepted${unique.length ? ` (warnings: ${unique.join(', ')})` : ''}`;
}

function eventIdsOf(variant) {
  const ids = new Set();
  for (const m of String(variant.requestBody || '').matchAll(/urn:uuid:[0-9A-Za-z-]+/g)) ids.add(m[0]);
  return [...ids];
}

const FORMAT_LABEL = { 'JSON-LD': 'EPCIS 2.0 JSON-LD', XML: 'EPCIS 1.2 XML' };

// Writes the verdict and colours the whole test row by it - green PASS, red FAIL, yellow
// NOT TESTED - across every column of its table; the STATUS cell also takes the matching
// text colour.
function paintRow(row, cols, status) {
  const [fill, font] =
    status === 'PASS' ? [PASS_FILL, PASS_FONT] : status === 'FAIL' ? [FAIL_FILL, FAIL_FONT] : [NOT_TESTED_FILL, NOT_TESTED_FONT];
  const lastCol = Math.max(COLS.comments, ...Object.values(cols));
  // Cells in the master share style objects, and ExcelJS's \`cell.fill = x\` writes into the
  // shared one - painting one row would repaint every row sharing it. A fresh style object
  // per cell keeps each row's colour its own.
  for (let c = 1; c <= lastCol; c += 1) {
    const cell = row.getCell(c);
    cell.style = { ...cell.style, fill };
  }
  const statusCell = row.getCell(cols.status);
  statusCell.value = status;
  statusCell.style = { ...statusCell.style, font: { ...statusCell.style.font, ...font } };
}

// Finishes every test row the run did not stamp, so STATUS and Actual Result are never empty.
// `untouched`: 'keep' keeps the master's recorded verdicts (all-runs export, day sheet);
// 'not-tested' marks every row outside the run NOT TESTED (single-run export), because an old
// manual PASS is not a result of the run being exported.
function completeTestRows(sheet, isStamped, untouched) {
  let cols = COLS;
  let completed = 0;
  sheet.eachRow((row) => {
    cols = headerColumns(row) || cols;
    const id = String(row.getCell(COLS.testId).text).trim();
    if (!TEST_ID_SHAPE.test(id) || !String(row.getCell(cols.description || 2).text).trim()) return;
    if (isStamped(id) || !cols.status || !cols.actualResult) return;

    const statusCell = row.getCell(cols.status);
    const actualCell = row.getCell(cols.actualResult);
    const commentCell = cols.comments ? row.getCell(cols.comments) : null;
    const note = (text) => {
      if (!commentCell) return;
      const existing = String(commentCell.text).trim();
      commentCell.value = existing ? `${existing} | ${text}` : text;
    };

    // A recorded decision (a case deliberately not automated) states its reason everywhere.
    const decision = CASE_DECISIONS[id];
    if (decision) {
      paintRow(row, cols, decision.status);
      actualCell.value = decision.actual;
      note(decision.decision);
      completed += 1;
      return;
    }

    if (untouched === 'not-tested') {
      paintRow(row, cols, 'NOT TESTED');
      actualCell.value = 'Not tested - not part of this run.';
      completed += 1;
      return;
    }

    const original = String(statusCell.text).trim();
    const normalised = original ? STATUS_MAP[original.toUpperCase()] || 'NOT TESTED' : 'NOT TESTED';
    if (original && normalised !== original.toUpperCase()) note(`Status normalised from "${original}".`);
    paintRow(row, cols, normalised);

    if (!String(actualCell.text).trim()) {
      actualCell.value = original && normalised !== 'NOT TESTED'
        ? `Recorded as ${normalised} in the master test plan; no actual-result text was captured.`
        : original
          ? `Not tested - recorded as "${original}" in the master test plan.`
          : 'Not tested - no automated or recorded result for this case.';
    }
    // Every FAIL row says why in its comment, including failures carried over from the plan.
    if (normalised === 'FAIL' && commentCell && !/Failed because:/.test(String(commentCell.text))) {
      const existing = String(commentCell.text).trim();
      const actual = String(actualCell.text).trim();
      const why = existing || (actual && !/^Recorded as /.test(actual)
        ? actual
        : 'the master test plan marks this case as failed but records no reason');
      commentCell.value = `Failed because: ${why} | Carried over from the master test plan - not re-run by automation.`;
    }
    completed += 1;
  });
  return completed;
}

// Appends the entities tests created (users, batches, shipments, syncs...) to the "Test Data
// Log" sheet, in its own columns, so whoever cleans up the environment has the full list.
// `include(entry)` narrows which log entries belong in this workbook.
function appendTestDataLog(wb, include) {
  const sheet = wb.getWorksheet('Test Data Log');
  if (!sheet) return 0;
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(ENTITY_LOG_PATH, 'utf-8'));
  } catch {
    return 0;
  }
  const wanted = entries.filter((e) => !include || include(e));
  const template = sheet.getRow(2);
  for (const e of wanted) {
    const known = new Set(['timestamp', 'type', 'identifier', 'id', 'sscc', 'relatedTo', 'createdBy', 'testId', 'cleanup', 'environment', 'notes']);
    const extra = Object.entries(e)
      .filter(([k]) => !known.has(k))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? (v.length > 5 ? `${v.slice(0, 5).join(', ')} (+${v.length - 5} more)` : v.join(', ')) : typeof v === 'object' ? JSON.stringify(v) : v}`);
    const notes = [
      e.environment && `Environment: ${e.environment}`,
      e.cleanup && `Cleanup: ${e.cleanup}`,
      e.notes,
      ...extra,
    ].filter(Boolean).join(' | ');
    const row = sheet.addRow([e.timestamp, e.type, e.identifier, e.id ?? '', e.sscc ?? '', e.relatedTo ?? '', e.createdBy ?? '', e.testId ?? '', notes]);
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      cell.style = { ...template.getCell(c).style };
    });
  }
  return wanted.length;
}

// Automated cases the master plan does not list yet (e.g. the partner auth / RBAC /
// registration suite) would otherwise vanish from the export. They are added as their own
// section, in the master's layout: PARTNER-* cases at the end of the Partner portal sheet,
// anything else on an "Additional Automated Tests" sheet.
const UNLISTED_HOMES = [
  { match: /^PARTNER-/, sheet: 'Partner portal', title: 'Partner access, RBAC & registration (automated - not in the master plan)' },
  { match: /^SMOKE-/, sheet: 'Auth & Access Control', title: 'Page inventory - each role opens its pages (automated - not in the master plan)' },
  { match: /./, sheet: 'Additional Automated Tests', title: 'Automated cases not in the master plan' },
];
const HEADER_LABELS = ['Test ID', 'Description', 'Test Steps', 'Test Data', 'Field', 'Expected Result', 'Actual Result', 'STATUS', 'COMMENTS'];

function appendUnlistedResults(wb, index, listed) {
  // Only real test IDs: setup steps (e.g. the partner sign-in) and tests without a workbook ID
  // fall back to their spec path and are not test cases.
  const unlisted = [...index.keys()].filter((id) => !listed.has(id) && TEST_ID_SHAPE.test(id));
  if (!unlisted.length) return 0;
  // Styles borrowed from a standard sheet so the new sections look like the rest.
  const ref = wb.getWorksheet('Manufacturer - API (EPCIS)');
  const sectionStyle = ref ? { ...ref.getRow(1).getCell(1).style } : {};
  const headerStyle = ref ? { ...ref.getRow(2).getCell(1).style } : {};
  const bodyStyle = ref ? { ...ref.getRow(3).getCell(2).style } : {};
  const stampOf = (rn) => `run ${rn.id} (${rn.role}) at ${rn.finishedAt || rn.startedAt}`;
  let added = 0;

  for (const home of UNLISTED_HOMES) {
    const ids = unlisted.filter((id) => home.match.test(id) && !UNLISTED_HOMES.slice(0, UNLISTED_HOMES.indexOf(home)).some((h) => h.match.test(id)));
    if (!ids.length) continue;
    const sheet = wb.getWorksheet(home.sheet) || wb.addWorksheet(home.sheet);
    if (sheet.rowCount > 0) sheet.addRow([]);
    const section = sheet.addRow([home.title]);
    for (let c = 1; c <= HEADER_LABELS.length; c += 1) section.getCell(c).style = { ...sectionStyle };
    const header = sheet.addRow(HEADER_LABELS);
    header.eachCell((cell) => {
      cell.style = { ...headerStyle };
    });
    const cols = headerColumns(header);
    for (const id of ids.sort()) {
      const { result, run } = index.get(id);
      const first = result.variants?.[0] || {};
      const row = sheet.addRow([
        id,
        result.eventType || id,
        (result.path || []).join(' > '),
        '',
        '',
        first.expected || '',
        summarizeActualResult(result),
        '',
        failureComment(result, result.ok, stampOf(run), ' Not yet in the master test plan.'),
      ]);
      for (let c = 1; c <= HEADER_LABELS.length; c += 1) row.getCell(c).style = { ...bodyStyle };
      paintRow(row, cols, result.ok ? 'PASS' : 'FAIL');
      added += 1;
    }
    if (!sheet.columns?.[0]?.width) sheet.columns = [16, 34, 34, 20, 16, 40, 48, 12, 40].map((width) => ({ width }));
  }
  return added;
}

// Reads a fresh copy of the master workbook and stamps `index` into it. Each matched Test ID
// row keeps the overall verdict (PASS only when every format passed), and gets one row per
// format beneath it - "<Test ID> · JSON-LD", "<Test ID> · XML" - each checked on its own.
async function buildWorkbook(index, { untouched = 'keep', dataLog = null } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WORKBOOK_PATH); // fresh read every time - never mutate the source

  let matchedRows = 0;
  let formatRows = 0;
  let completedRows = 0;
  const listed = new Set();
  wb.eachSheet((sheet) => {
    const matches = [];
    let cols = COLS;
    for (let r = 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      cols = headerColumns(row) || cols;
      const testId = row.getCell(COLS.testId).value;
      if (typeof testId === 'string' && index.has(testId)) {
        matches.push({ r, cols });
        listed.add(testId);
      }
    }
    // Bottom-up, so inserting rows never shifts a match that has not been handled yet.
    for (const { r, cols: C } of matches.reverse()) {
      const put = (target, key, value) => {
        if (C[key]) target.getCell(C[key]).value = value;
      };
      const row = sheet.getRow(r);
      const testId = row.getCell(COLS.testId).value;
      const { result, run, formats } = index.get(testId);
      const stampOf = (rn) => `run ${rn.id} (${rn.role}) at ${rn.finishedAt || rn.startedAt}`;
      matchedRows += 1;

      const hasFormats = formats.some((f) => FORMAT_LABEL[f.variant.variant]);
      put(row, 'actualResult', summarizeActualResult(result));
      if (C.status) paintRow(row, C, result.ok ? 'PASS' : 'FAIL');
      put(row, 'comments', failureComment(result, result.ok, stampOf(run), hasFormats ? ' Per-format results in the rows below.' : ''));

      const perFormat = formats.filter((f) => FORMAT_LABEL[f.variant.variant]);
      perFormat.forEach(({ variant: v, run: fromRun }, i) => {
        const stamp = stampOf(fromRun);
        const ids = eventIdsOf(v);
        // 'i' copies the parent row's formatting, so the new rows sit inside the table's grid.
        const added = sheet.insertRow(r + 1 + i, [], 'i');
        added.getCell(COLS.testId).value = `${testId} · ${v.variant}`;
        put(added, 'description', `${result.eventType || testId} submitted as ${FORMAT_LABEL[v.variant]}`);
        put(added, 'steps', `${v.method || 'POST'} ${v.url || ''}`.trim());
        put(added, 'data', ids.length ? `eventID: ${ids.join(', ')}` : '');
        put(added, 'field', 'HTTP status, response code');
        put(added, 'expected', `Accepted (HTTP 2xx) in ${FORMAT_LABEL[v.variant]}`);
        put(added, 'actualResult', describeResponse(v) + (v.durationMs != null ? ` (${v.durationMs} ms)` : ''));
        if (C.status) paintRow(added, C, v.ok ? 'PASS' : 'FAIL');
        put(added, 'comments', v.ok ? `Automated via QA Dashboard - ${stamp}.` : `Failed because: ${reasonFromApiResponse(v)} | Automated via QA Dashboard - ${stamp}.`);
        formatRows += 1;
      });
    }

    // Rows stamped above (a run's Test IDs and their per-format rows) are already complete.
    const isStamped = (id) => index.has(id) || / · (JSON-LD|XML)$/.test(id);
    completedRows += completeTestRows(sheet, isStamped, untouched);
  });

  const unlistedRows = appendUnlistedResults(wb, index, listed);
  const loggedEntities = appendTestDataLog(wb, dataLog);
  return { wb, matchedRows, formatRows, completedRows, unlistedRows, loggedEntities };
}

module.exports = { buildLatestResultIndex, buildWorkbook, runDateKey, WORKBOOK_PATH };
