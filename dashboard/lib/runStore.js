// Persists API-suite runs as flat JSON files, mirroring the existing convention in
// tests/helpers/datalog.js (run_data/created-entities.json). No database needed at this
// scale (a few dozen requests per run, infrequent runs).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROJECT_ROOT } = require('./paths');
const { formatEpcis } = require('./epcisFormat');
const audit = require('./auditDb');

const RUN_DIR = path.join(PROJECT_ROOT, 'run_data', 'api-runs');
const INDEX_PATH = path.join(RUN_DIR, 'index.json');

function ensureDir() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
}

function newRunId() {
  return `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function writeIndex(index) {
  ensureDir();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
}

function runPath(runId) {
  return path.join(RUN_DIR, `${runId}.json`);
}

function createRun({
  role,
  eventTypes,
  baseUrl,
  documentMode = null,
  consignment = null,
  health = null,
  id = null,
}) {
  const runId = id || newRunId();
  const run = {
    id: runId,
    role,
    eventTypes: eventTypes || null,
    baseUrl,
    documentMode,
    // Host reachability at run start — source of truth for /health history.
    health: health || null,
    // Every identifier this run minted, recorded before anything is sent so a batch can
    // be traced back to its serials, lot, cases and pallet without re-deriving them.
    consignment,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    results: [],
  };
  ensureDir();
  fs.writeFileSync(runPath(runId), JSON.stringify(run, null, 2), 'utf-8');

  // Index the run immediately, while it is still running. Previously a run only appeared
  // here once finished, so nothing could discover an in-flight run to follow it live.
  const index = readIndex();
  index.unshift({
    id: run.id,
    role: run.role,
    documentMode: run.documentMode,
    baseUrl: run.baseUrl,
    health: run.health,
    startedAt: run.startedAt,
    finishedAt: null,
    status: 'running',
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  });
  writeIndex(index.slice(0, 200));
  audit.recordRunStart(run);
  return run;
}

// Which start route a stored run belongs to, so a re-run can only go back through the same one.
function runKind(run) {
  if (run.role === 'end-to-end') return 'e2e';
  if (run.role === 'ui') return 'ui';
  return 'role';
}

const MAX_KEPT_ATTEMPTS = 10;

// Re-runs an existing run under the same id instead of creating a new one. The previous
// attempt (results, timings, status) is kept under `attempts`, newest last; the run's config
// is refreshed from `fields` (the operator may have changed environment or selection) and it
// goes back to running. Returns null when the run does not exist or is a different kind.
function restartRun(runId, kind, fields = {}) {
  const run = readRun(runId);
  if (!run || runKind(run) !== kind) return null;
  const previous = {
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    baseUrl: run.baseUrl,
    results: run.results,
  };
  const attempts = [...(run.attempts || []), previous].slice(-MAX_KEPT_ATTEMPTS);
  const restarted = {
    ...run,
    ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
    id: run.id,
    role: run.role,
    attempt: (run.attempt || 1) + 1,
    attempts,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    results: [],
  };
  fs.writeFileSync(runPath(runId), JSON.stringify(restarted, null, 2), 'utf-8');

  // Move the run to the top of the history as running again.
  const index = readIndex().filter((entry) => entry.id !== runId);
  index.unshift({
    id: restarted.id,
    role: restarted.role,
    documentMode: restarted.documentMode,
    baseUrl: restarted.baseUrl,
    health: restarted.health,
    startedAt: restarted.startedAt,
    finishedAt: null,
    status: 'running',
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    attempt: restarted.attempt,
  });
  writeIndex(index.slice(0, 200));
  audit.recordRunRestart(restarted, restarted.attempt);
  return restarted;
}

function appendResult(runId, result) {
  const run = readRun(runId);
  if (!run) return;
  run.results.push(result);
  fs.writeFileSync(runPath(runId), JSON.stringify(run, null, 2), 'utf-8');
  audit.recordResult(runId, result);
}

// Bulk-replace results (Playwright finishes with its own list rather than streaming into
// the store one-by-one). Does not re-audit individual results — finishRun covers the run.
function setResults(runId, results) {
  const run = readRun(runId);
  if (!run) return;
  run.results = Array.isArray(results) ? results : [];
  fs.writeFileSync(runPath(runId), JSON.stringify(run, null, 2), 'utf-8');
}

function finishRun(runId, { status = 'complete', error = null } = {}) {
  const run = readRun(runId);
  if (!run) return null;
  run.status = status;
  run.finishedAt = new Date().toISOString();
  fs.writeFileSync(runPath(runId), JSON.stringify(run, null, 2), 'utf-8');

  const total = run.results.length;
  const passed = run.results.filter((r) => r.ok).length;
  const skipped = run.results.filter((r) => !r.ok && r.skipped).length;
  const summary = {
    id: run.id,
    role: run.role,
    documentMode: run.documentMode ?? null,
    baseUrl: run.baseUrl ?? null,
    health: run.health ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    total,
    passed,
    failed: total - passed - skipped,
    skipped,
    attempt: run.attempt || 1,
  };

  // Update the entry createRun() already added rather than adding a second one for the
  // same run - otherwise every run would appear twice in the history.
  const index = readIndex();
  const at = index.findIndex((entry) => entry.id === run.id);
  if (at >= 0) index[at] = summary;
  else index.unshift(summary);
  writeIndex(index.slice(0, 200)); // keep history bounded
  audit.recordRunFinish(runId, { ...summary, error });
  return run;
}

// Every document a run sent, saved next to the run as pretty-printed JSON, one file per
// request. Kept out of the run record itself: a 50,000-serial document is megabytes, and the
// run record is rewritten after every step.
function documentsDir(runId) {
  return path.join(RUN_DIR, `${runId}-documents`);
}

function saveDocument(runId, name, body) {
  const dir = documentsDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const isXml = String(body).trimStart().startsWith('<');
  const file = path.join(dir, `${name}.${isXml ? 'xml' : 'json'}`);
  if (fs.existsSync(file)) return file; // a combined document is shared by several steps
  let text = body;
  try {
    text = formatEpcis(JSON.parse(body));
  } catch {
    // not JSON (e.g. XML) - stored as sent
  }
  fs.writeFileSync(file, text, 'utf-8');
  return file;
}

// Replaces the consignment recorded at start, e.g. once the portal has assigned real lots.
function updateConsignment(runId, patch) {
  const run = readRun(runId);
  if (!run) return;
  run.consignment = { ...(run.consignment || {}), ...patch };
  fs.writeFileSync(runPath(runId), JSON.stringify(run, null, 2), 'utf-8');
  audit.updateRunConsignment(runId, run.consignment);
}

function readRun(runId) {
  try {
    return JSON.parse(fs.readFileSync(runPath(runId), 'utf-8'));
  } catch {
    return null;
  }
}

function listRuns() {
  return readIndex();
}

module.exports = {
  createRun,
  restartRun,
  appendResult,
  setResults,
  finishRun,
  readRun,
  listRuns,
  saveDocument,
  updateConsignment,
  documentsDir,
};
