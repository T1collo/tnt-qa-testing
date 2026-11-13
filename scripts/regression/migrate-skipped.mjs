// One-off: mark journey steps that were never sent (no token supplied for their role) as
// skipped in runs stored before the `skipped` flag existed, and recompute the index counts.
// The match is deliberately narrow: no HTTP status at all AND the exact runner reason.
//
// Run: node scripts/regression/migrate-skipped.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('run_data/api-runs');
const APPLY = process.argv.includes('--apply');
const NOT_SENT = /^no (manufacturer|distributor|facility) token supplied$/;

const indexPath = path.join(DIR, 'index.json');
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
if (APPLY) fs.copyFileSync(indexPath, `${indexPath}.bak-${Date.now()}`);

let touchedRuns = 0;
for (const entry of index) {
  const file = path.join(DIR, `${entry.id}.json`);
  if (!fs.existsSync(file)) continue;
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = 0;
  for (const r of run.results || []) {
    const neverSent = (r.variants || []).every((v) => v.status === null || v.status === undefined);
    if (!r.ok && !r.skipped && neverSent && NOT_SENT.test(r.error || '')) {
      r.skipped = true;
      changed += 1;
    }
  }
  if (!changed) continue;
  touchedRuns += 1;

  const total = run.results.length;
  const passed = run.results.filter((r) => r.ok).length;
  const skipped = run.results.filter((r) => !r.ok && r.skipped).length;
  console.log(`${entry.id}  ${changed} marked skipped  ->  passed ${passed}, failed ${total - passed - skipped}, skipped ${skipped}`);

  if (APPLY) {
    fs.writeFileSync(file, JSON.stringify(run, null, 2));
    Object.assign(entry, { passed, failed: total - passed - skipped, skipped });
  }
}
if (APPLY) fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
console.log(`\n${touchedRuns} run(s) ${APPLY ? 'migrated' : 'would change (dry run - pass --apply)'}`);
