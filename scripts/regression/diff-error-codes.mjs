// Compares a Newman error-code regression run against the frozen 14 Sep baseline, per
// request: HTTP status plus the response's own error code. The baseline run fired every
// request, so each item in the subset has a counterpart to compare against.
//
// Run: node scripts/regression/diff-error-codes.mjs <baseline.json> <run.json>
import fs from 'node:fs';

const [basePath, runPath] = process.argv.slice(2);
const executions = (p) => {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (j.run || j).executions || [];
};

const responseCode = (exec) => {
  const stream = exec.response?.stream;
  if (!stream) return '-';
  try {
    const text = Buffer.from(stream.data ?? stream).toString('utf8');
    const body = JSON.parse(text);
    return body.code || body.category || (body.success ? 'accepted' : body.message || '-');
  } catch {
    return 'non-JSON';
  }
};
const failedAssertions = (exec) => (exec.assertions || []).filter((a) => a.error).length;

// Match by request name; a name can repeat (shared setup labels), so pair by occurrence.
const index = (list) => {
  const seen = new Map();
  return list.map((exec) => {
    const name = exec.item?.name ?? '?';
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return { key: `${name}#${n}`, name, exec };
  });
};

const baseline = new Map(index(executions(basePath)).map((e) => [e.key, e.exec]));
let changed = 0;
for (const { key, name, exec } of index(executions(runPath))) {
  const was = baseline.get(key);
  const now = `${exec.response?.code ?? 'ERR'} ${responseCode(exec)}`;
  const then = was ? `${was.response?.code ?? 'ERR'} ${responseCode(was)}` : 'NO BASELINE';
  const verdict = !was ? 'NEW' : then === now ? 'UNCHANGED' : 'CHANGED';
  if (verdict !== 'UNCHANGED') changed += 1;
  console.log(
    `${verdict.padEnd(9)} ${name.slice(0, 60).padEnd(60)} ${then.padEnd(34)} -> ${now}` +
      `   (failed assertions: ${was ? failedAssertions(was) : '-'} -> ${failedAssertions(exec)})`
  );
}
console.log(`\n${changed} changed`);
