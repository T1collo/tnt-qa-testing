// Imports runs recorded before the SQLite audit log existed (run_data/api-runs/*.json).
// Safe to re-run: a run already in the database is skipped.
//
//   cd dashboard && node scripts/audit-backfill.cjs
const fs = require('fs');
const path = require('path');

process.chdir(path.join(__dirname, '..')); // lib/paths resolves the project root from here
const audit = require('../lib/auditDb');
const { PROJECT_ROOT } = require('../lib/paths');

const RUN_DIR = path.join(PROJECT_ROOT, 'run_data', 'api-runs');
const db = audit.open();
if (!db) {
  console.error('SQLite is unavailable - needs Node 22.13 or newer.');
  process.exit(1);
}

let imported = 0;
let skipped = 0;
const files = fs.readdirSync(RUN_DIR).filter((f) => /^run_.*\.json$/.test(f));
for (const file of files) {
  const run = JSON.parse(fs.readFileSync(path.join(RUN_DIR, file), 'utf8'));
  if (db.prepare('SELECT 1 FROM runs WHERE id = ?').get(run.id)) {
    skipped += 1;
    continue;
  }
  audit.recordRunStart(run);
  for (const result of run.results || []) audit.recordResult(run.id, result);
  if (run.status !== 'running') {
    const total = run.results.length;
    const passed = run.results.filter((r) => r.ok).length;
    const skip = run.results.filter((r) => !r.ok && r.skipped).length;
    audit.recordRunFinish(run.id, {
      status: run.status,
      finishedAt: run.finishedAt,
      total,
      passed,
      failed: total - passed - skip,
      skipped: skip,
    });
  }
  // Backfilled rows are stamped with import time; the run's own times stay on the run.
  db.prepare("INSERT INTO run_logs (run_id, at, level, message) VALUES (?, ?, 'info', ?)")
    .run(run.id, new Date().toISOString(), `Imported from ${file}`);
  imported += 1;
}

// Imported rows are dated by the run, not by the import, and older portal batches (recorded
// before batches carried their product) get the product from the run's consignment.
db.exec(`
  UPDATE results SET recorded_at = (SELECT COALESCE(r.finished_at, r.started_at) FROM runs r WHERE r.id = results.run_id)
  WHERE run_id IN (SELECT run_id FROM run_logs WHERE message LIKE 'Imported from %');
  UPDATE run_logs SET at = (SELECT r.started_at FROM runs r WHERE r.id = run_logs.run_id)
  WHERE message LIKE 'Run started%' AND run_id IN (SELECT run_id FROM run_logs WHERE message LIKE 'Imported from %');
  UPDATE run_logs SET at = (SELECT COALESCE(r.finished_at, r.started_at) FROM runs r WHERE r.id = run_logs.run_id)
  WHERE message LIKE 'Run %' AND message NOT LIKE 'Run started%'
    AND run_id IN (SELECT run_id FROM run_logs WHERE message LIKE 'Imported from %');
`);
const unnamed = db.prepare('SELECT b.id, b.run_id FROM batches b WHERE b.product IS NULL ORDER BY b.id').all();
const position = new Map();
for (const b of unnamed) {
  const run = db.prepare('SELECT consignment FROM runs WHERE id = ?').get(b.run_id);
  const products = JSON.parse(run?.consignment || '{}').products || [];
  const i = position.get(b.run_id) || 0;
  position.set(b.run_id, i + 1);
  if (products[i]) {
    db.prepare('UPDATE batches SET product = ?, gtin = ? WHERE id = ?').run(products[i].brand, products[i].gtin, b.id);
  }
}

console.log(`Imported ${imported} run(s), ${skipped} already present. Database: ${audit.DB_PATH}`);
console.log(JSON.stringify(audit.auditSummary(), null, 2));
