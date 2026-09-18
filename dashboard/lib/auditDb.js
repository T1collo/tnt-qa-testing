// Local SQLite audit log: every run (API suite, end-to-end journey, Playwright browser suite)
// and every result, passed or failed, with the request, response and each platform warning.
//
// Uses Node's built-in node:sqlite (Node 22.13+), so there is nothing to install or compile.
// The database lives at run_data/audit.sqlite, which is git-ignored with the rest of run_data.
// The JSON run files remain the working store; this is the queryable, append-only record.
//
// Never stored: API keys. Header values named like a key are masked before insert, and
// request bodies never carry them.
const path = require('path');
const fs = require('fs');
const { PROJECT_ROOT } = require('./paths');

const DB_PATH = path.join(PROJECT_ROOT, 'run_data', 'audit.sqlite');
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,            -- api | e2e | ui
  role           TEXT,
  document_mode  TEXT,
  base_url       TEXT,
  status         TEXT NOT NULL,            -- running | complete | error | stopped
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  total          INTEGER NOT NULL DEFAULT 0,
  passed         INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  skipped        INTEGER NOT NULL DEFAULT 0,
  consignment    TEXT,                     -- JSON
  error          TEXT
);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);

CREATE TABLE IF NOT EXISTS results (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  step_key       TEXT,
  test_id        TEXT,
  title          TEXT,
  role           TEXT,
  phase          TEXT,
  outcome        TEXT NOT NULL,            -- pass | fail | skipped
  variant        TEXT,                     -- JSON-LD | XML | chromium | Portal UI
  method         TEXT,
  url            TEXT,
  http_status    INTEGER,
  duration_ms    INTEGER,
  event_id       TEXT,
  error          TEXT,
  request_headers TEXT,                    -- JSON, keys masked
  request_body   TEXT,
  response_body  TEXT,
  document_path  TEXT,
  recorded_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS results_run ON results(run_id, seq);
CREATE INDEX IF NOT EXISTS results_test ON results(test_id);
CREATE INDEX IF NOT EXISTS results_outcome ON results(outcome);

CREATE TABLE IF NOT EXISTS warnings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  result_id      INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  run_id         TEXT NOT NULL,
  kind           TEXT NOT NULL,            -- warning | error | violation
  code           TEXT,
  field          TEXT,
  severity       TEXT,
  message        TEXT
);
CREATE INDEX IF NOT EXISTS warnings_code ON warnings(code);
CREATE INDEX IF NOT EXISTS warnings_run ON warnings(run_id);
CREATE INDEX IF NOT EXISTS warnings_result ON warnings(result_id, code);
CREATE INDEX IF NOT EXISTS results_recorded ON results(recorded_at);

CREATE TABLE IF NOT EXISTS batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  product        TEXT,
  gtin           TEXT,
  batch_no       TEXT,
  expiry         TEXT,
  portal_batch_id INTEGER,
  ok             INTEGER NOT NULL,
  error          TEXT,
  screenshot     TEXT,
  recorded_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at             TEXT NOT NULL,
  level          TEXT NOT NULL,            -- info | error | output
  message        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_logs_run ON run_logs(run_id, id);
`;

const state = globalThis.__tntAuditDbV2 || (globalThis.__tntAuditDbV2 = { db: null, failed: null });

function open() {
  if (state.db || state.failed) return state.db;
  try {
    // Loaded at runtime: the bundler cannot resolve node:sqlite, and a Node without it only
    // loses auditing, not the dashboard.
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite) throw new Error('node:sqlite is not available in this Node version (needs 22.13+)');
    const { DatabaseSync } = sqlite;
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    state.db = db;
  } catch (err) {
    state.failed = err;
    console.error('[audit] SQLite unavailable, runs will not be audited:', err.message);
  }
  return state.db;
}

// Auditing must never break a run: every write is best-effort and logged on failure.
function safely(label, fn) {
  const db = open();
  if (!db) return undefined;
  try {
    return fn(db);
  } catch (err) {
    console.error(`[audit] ${label} failed:`, err.message);
    return undefined;
  }
}

const now = () => new Date().toISOString();
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

const SECRET_HEADER = /key|token|auth|secret|password/i;
function maskHeaders(headers) {
  if (!headers) return null;
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SECRET_HEADER.test(k) ? '***' : v;
  return JSON.stringify(out);
}

function kindOf(run) {
  if (run.kind) return run.kind;
  if (run.role === 'end-to-end') return 'e2e';
  return 'api';
}

function recordRunStart(run) {
  safely('recordRunStart', (db) => {
    db.prepare(
      `INSERT OR IGNORE INTO runs (id, kind, role, document_mode, base_url, status, started_at, consignment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(run.id, kindOf(run), run.role ?? null, run.documentMode ?? null, run.baseUrl ?? null,
      run.status || 'running', run.startedAt || now(), json(run.consignment));
    db.prepare(`INSERT INTO run_logs (run_id, at, level, message) VALUES (?, ?, 'info', ?)`)
      .run(run.id, now(), `Run started (${kindOf(run)}${run.role ? `, ${run.role}` : ''}) against ${run.baseUrl ?? 'default environment'}`);
  });
}

function updateRunConsignment(runId, consignment) {
  safely('updateRunConsignment', (db) => {
    db.prepare('UPDATE runs SET consignment = ? WHERE id = ?').run(json(consignment), runId);
  });
}

// Pulls warnings/errors/violations out of a platform response, whatever shape it came in.
function platformIssues(responseBody) {
  let parsed;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const issues = [];
  for (const [key, kind] of [['warnings', 'warning'], ['errors', 'error'], ['violations', 'violation']]) {
    for (const w of Array.isArray(parsed[key]) ? parsed[key] : []) {
      issues.push({ kind, code: w.code ?? null, field: w.field ?? null, severity: w.severity ?? null, message: w.message ?? null });
    }
  }
  // A rejection with only a top-level code still counts.
  if (!issues.length && parsed.code && parsed.success !== true) {
    issues.push({ kind: 'error', code: parsed.code, field: null, severity: 'error', message: parsed.message ?? null });
  }
  return issues;
}

function recordResult(runId, result) {
  safely('recordResult', (db) => {
    const seq = db.prepare('SELECT COUNT(DISTINCT seq) AS n FROM results WHERE run_id = ?').get(runId).n + 1;
    const outcome = result.ok ? 'pass' : result.skipped ? 'skipped' : 'fail';
    const variants = result.variants?.length ? result.variants : [{}];
    const insert = db.prepare(
      `INSERT INTO results (run_id, seq, step_key, test_id, title, role, phase, outcome, variant, method, url,
         http_status, duration_ms, event_id, error, request_headers, request_body, response_body, document_path, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertIssue = db.prepare(
      'INSERT INTO warnings (result_id, run_id, kind, code, field, severity, message) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    db.exec('BEGIN');
    try {
      for (const v of variants) {
        // Each variant (JSON-LD / XML) is its own row, so its own pass/fail is kept.
        const variantOutcome = result.skipped ? 'skipped' : v.ok === undefined ? outcome : v.ok ? 'pass' : 'fail';
        const { lastInsertRowid } = insert.run(
          runId, seq, result.stepKey ?? null, result.testId ?? null, result.eventType ?? null,
          result.role ?? null, result.phase ?? null, variantOutcome, v.variant ?? null, v.method ?? null,
          v.url ?? null, v.status ?? null, v.durationMs ?? null, result.eventId ?? null,
          v.error ?? result.error ?? null, maskHeaders(v.requestHeaders), v.requestBody ?? null,
          v.responseBody ?? null, v.documentPath ?? null, now()
        );
        for (const i of platformIssues(v.responseBody)) {
          insertIssue.run(lastInsertRowid, runId, i.kind, i.code, i.field, i.severity, i.message);
        }
      }
      for (const b of result.batches || []) {
        db.prepare(
          `INSERT INTO batches (run_id, product, gtin, batch_no, expiry, portal_batch_id, ok, error, screenshot, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(runId, b.product ?? null, b.gtin ?? null, b.batchNo ?? null, b.expiry ?? null, b.batchId ?? null,
          b.ok ? 1 : 0, b.error ?? null, b.screenshot ?? null, now());
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
}

function recordLog(runId, level, message) {
  safely('recordLog', (db) => {
    db.prepare('INSERT INTO run_logs (run_id, at, level, message) VALUES (?, ?, ?, ?)').run(runId, now(), level, String(message));
  });
}

function recordRunFinish(runId, { status, finishedAt, total, passed, failed, skipped, error }) {
  safely('recordRunFinish', (db) => {
    db.prepare(
      `UPDATE runs SET status = ?, finished_at = ?, total = ?, passed = ?, failed = ?, skipped = ?, error = COALESCE(?, error)
       WHERE id = ?`
    ).run(status, finishedAt || now(), total ?? 0, passed ?? 0, failed ?? 0, skipped ?? 0, error ?? null, runId);
    db.prepare(`INSERT INTO run_logs (run_id, at, level, message) VALUES (?, ?, ?, ?)`).run(
      runId, now(), status === 'complete' ? 'info' : 'error',
      `Run ${status}: ${passed ?? 0} passed, ${failed ?? 0} failed, ${skipped ?? 0} skipped${error ? ` — ${error}` : ''}`
    );
  });
}

// ---- Reading, for the Audit page ----

function listAuditRuns({ kind, status, from, to, limit = 100 } = {}) {
  return (
    safely('listAuditRuns', (db) => {
      const where = [];
      const args = [];
      if (kind) { where.push('kind = ?'); args.push(kind); }
      if (status) { where.push('status = ?'); args.push(status); }
      if (from) { where.push('started_at >= ?'); args.push(from); }
      if (to) { where.push('started_at < ?'); args.push(to); }
      const sql = `SELECT r.id, r.kind, r.role, r.document_mode, r.base_url, r.status, r.started_at, r.finished_at,
                          r.total, r.passed, r.failed, r.skipped, r.error,
                          (SELECT COUNT(*) FROM warnings w WHERE w.run_id = r.id) AS issue_count
                   FROM runs r ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY started_at DESC LIMIT ?`;
      return db.prepare(sql).all(...args, Math.min(Number(limit) || 100, 500));
    }) || []
  );
}

function searchResults({ runId, outcome, testId, code, q, limit = 200 } = {}) {
  return (
    safely('searchResults', (db) => {
      const where = [];
      const args = [];
      if (runId) { where.push('r.run_id = ?'); args.push(runId); }
      if (outcome) { where.push('r.outcome = ?'); args.push(outcome); }
      if (testId) { where.push('r.test_id LIKE ?'); args.push(`%${testId}%`); }
      if (code) { where.push('EXISTS (SELECT 1 FROM warnings w WHERE w.result_id = r.id AND w.code = ?)'); args.push(code); }
      if (q) {
        where.push('(r.title LIKE ? OR r.error LIKE ? OR r.response_body LIKE ? OR r.event_id LIKE ?)');
        args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }
      const sql = `SELECT r.id, r.run_id, r.seq, r.step_key, r.test_id, r.title, r.role, r.outcome, r.variant,
                          r.method, r.url, r.http_status, r.duration_ms, r.event_id, r.error, r.recorded_at,
                          (SELECT group_concat(DISTINCT w.code) FROM warnings w WHERE w.result_id = r.id) AS codes
                   FROM results r ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY r.recorded_at DESC, r.id DESC LIMIT ?`;
      return db.prepare(sql).all(...args, Math.min(Number(limit) || 200, 1000));
    }) || []
  );
}

// The events a request carried, from its stored body or, for large journey documents, the
// saved document file. Handles EPCIS JSON-LD and 1.2 XML.
const XML_EVENT = /<(ObjectEvent|AggregationEvent|TransactionEvent|TransformationEvent)\b[\s\S]*?<\/\1>/g;

function xmlValues(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1].trim());
}

function eventsFromBody(body) {
  if (!body) return [];
  try {
    const doc = JSON.parse(body);
    return (doc.epcisBody?.eventList || []).map((e) => ({
      eventID: e.eventID ?? null,
      type: e.type ?? null,
      bizStep: e.bizStep ?? null,
      parentID: e.parentID ?? null,
      epcList: e.epcList || [],
      childEPCs: e.childEPCs || [],
    }));
  } catch {
    return (body.match(XML_EVENT) || []).map((block) => ({
      eventID: xmlValues(block, 'eventID')[0] ?? null,
      type: block.match(/^<(\w+)/)[1],
      bizStep: xmlValues(block, 'bizStep')[0] ?? null,
      parentID: xmlValues(block, 'parentID')[0] ?? null,
      epcList: xmlValues(xmlValues(block, 'epcList').join(''), 'epc'),
      childEPCs: xmlValues(xmlValues(block, 'childEPCs').join(''), 'epc'),
    }));
  }
}

function returnedEventIds(responseBody) {
  try {
    return JSON.parse(responseBody).event_ids || [];
  } catch {
    return [];
  }
}

function resultDetail(id) {
  return (
    safely('resultDetail', (db) => {
      const row = db.prepare('SELECT * FROM results WHERE id = ?').get(id);
      if (!row) return null;
      row.issues = db.prepare('SELECT kind, code, field, severity, message FROM warnings WHERE result_id = ?').all(id);
      let body = row.request_body;
      if (!body && row.document_path) {
        try {
          body = fs.readFileSync(row.document_path, 'utf8');
        } catch {
          body = null;
        }
      }
      row.events = eventsFromBody(body);
      row.returned_event_ids = returnedEventIds(row.response_body);
      return row;
    }) ?? null
  );
}

function runAudit(runId) {
  return (
    safely('runAudit', (db) => {
      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
      if (!run) return null;
      run.logs = db.prepare('SELECT at, level, message FROM run_logs WHERE run_id = ? ORDER BY id').all(runId);
      run.batches = db.prepare('SELECT * FROM batches WHERE run_id = ? ORDER BY id').all(runId);
      run.issueCodes = db
        .prepare('SELECT code, kind, COUNT(*) AS n FROM warnings WHERE run_id = ? GROUP BY code, kind ORDER BY n DESC')
        .all(runId);
      return run;
    }) ?? null
  );
}

function auditSummary() {
  return (
    safely('auditSummary', (db) => ({
      dbPath: DB_PATH,
      runs: db.prepare('SELECT kind, status, COUNT(*) AS n FROM runs GROUP BY kind, status').all(),
      results: db.prepare('SELECT outcome, COUNT(*) AS n FROM results GROUP BY outcome').all(),
      topCodes: db
        .prepare('SELECT code, kind, COUNT(*) AS n FROM warnings WHERE code IS NOT NULL GROUP BY code, kind ORDER BY n DESC LIMIT 15')
        .all(),
    })) ?? { dbPath: DB_PATH, unavailable: state.failed?.message || 'unavailable', runs: [], results: [], topCodes: [] }
  );
}

module.exports = {
  DB_PATH,
  open,
  platformIssues,
  recordRunStart,
  updateRunConsignment,
  recordResult,
  recordLog,
  recordRunFinish,
  listAuditRuns,
  searchResults,
  resultDetail,
  runAudit,
  auditSummary,
};
