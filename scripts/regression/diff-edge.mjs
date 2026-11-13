// Compares an edge-case regression run against the frozen baseline, case by case.
//
// The verdict is decided on HTTP status + behavioural codes only. The master-data family
// (unregistered GLN/serial/lot, no PPB approval) is reported separately: those codes move
// whenever the platform's registries change, and letting them into the verdict would turn
// every master-data edit into a wall of false regressions.
//
// Run: node scripts/regression/diff-edge.mjs <baseline.json> <run.json> [<run2.json>]
import fs from 'node:fs';

export const MASTER_DATA_CODES = new Set([
  'UNKNOWN_SGLN',
  'UNKNOWN_SGTIN',
  'INVALID_LOT',
  'NO_REGULATORY_APPROVAL',
]);

const [baselinePath, runPath, rerunPath] = process.argv.slice(2);
const load = (p) => (p ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
const baseline = new Map(load(baselinePath).map((c) => [c.id, c]));
const run = load(runPath);
const rerun = rerunPath ? new Map(load(rerunPath).map((c) => [c.id, c])) : null;

const split = (codes = []) => ({
  behaviour: [...new Set(codes.filter((c) => !MASTER_DATA_CODES.has(c)))].sort(),
  masterData: [...new Set(codes.filter((c) => MASTER_DATA_CODES.has(c)))].sort(),
});
const sig = (c) => `${c.status} [${split(c.codes).behaviour.join(',') || '-'}]`;

const rows = run.map((now) => {
  const was = baseline.get(now.id);
  if (!was) return { id: now.id, verdict: 'NEW', now: sig(now), title: now.title };

  let verdict = sig(was) === sig(now) ? 'UNCHANGED' : 'CHANGED';
  // A change is only reported if it reproduces - otherwise it is noise from a single call.
  if (verdict === 'CHANGED' && rerun) {
    const again = rerun.get(now.id);
    if (again && sig(again) !== sig(now)) verdict = 'FLAKY';
  }

  const a = split(was.codes).masterData;
  const b = split(now.codes).masterData;
  return {
    id: now.id,
    verdict,
    was: sig(was),
    now: sig(now),
    masterDataAdded: b.filter((x) => !a.includes(x)),
    masterDataRemoved: a.filter((x) => !b.includes(x)),
    title: now.title,
  };
});

const tally = rows.reduce((t, r) => ({ ...t, [r.verdict]: (t[r.verdict] || 0) + 1 }), {});
console.log(`verdicts: ${JSON.stringify(tally)}\n`);
for (const r of rows) {
  const md = [
    r.masterDataAdded?.length ? `+${r.masterDataAdded.join('+')}` : '',
    r.masterDataRemoved?.length ? `-${r.masterDataRemoved.join('-')}` : '',
  ].filter(Boolean).join(' ');
  console.log(
    `${r.verdict.padEnd(9)} ${r.id.padEnd(7)} ${String(r.was ?? '').padEnd(34)} -> ${String(r.now).padEnd(34)} ${md}`
  );
}

const outArg = process.argv.find((a) => a.startsWith('--out='));
if (outArg) fs.writeFileSync(outArg.slice(6), JSON.stringify(rows, null, 2));
