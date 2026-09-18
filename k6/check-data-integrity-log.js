// Post-processes the console output of data-integrity-manufacturer-commission.js (redirected
// to a log file) to check for CROSS-REQUEST problems the in-script checks can't see on their
// own, since each k6 VU runs in an isolated JS runtime with no shared state: specifically,
// whether any acknowledged eventID was handed back for more than one request (a collision/
// caching bug), and whether every successfully-acknowledged request's ID is actually unique
// across the whole run.
//
// Usage: node k6/check-data-integrity-log.js path/to/run.log
const fs = require('fs');

const logPath = process.argv[2];
if (!logPath) {
  console.error('Usage: node check-data-integrity-log.js <log-file>');
  process.exit(1);
}

const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
const rows = [];
for (const line of lines) {
  const m = line.match(/INTEGRITY submitted=(\S+) status=(\d+) acked=(\S+)/);
  if (m) {
    rows.push({ submitted: m[1], status: Number(m[2]), acked: m[3] === 'NONE' ? [] : m[3].split('|') });
  }
}

console.log(`Parsed ${rows.length} INTEGRITY lines from ${logPath}`);

const succeeded = rows.filter((r) => r.status === 201 || r.status === 202);
const mismatched = succeeded.filter((r) => !(r.acked.length === 1 && r.acked[0] === r.submitted));

const ackCounts = new Map();
for (const r of succeeded) {
  for (const id of r.acked) {
    ackCounts.set(id, (ackCounts.get(id) || 0) + 1);
  }
}
const duplicateAcks = [...ackCounts.entries()].filter(([, count]) => count > 1);

console.log(`Total requests: ${rows.length}`);
console.log(`Successful (201/202): ${succeeded.length}`);
console.log(`Mismatched ack (wrong/missing/extra ID): ${mismatched.length}`);
console.log(`Duplicate acked IDs across the whole run: ${duplicateAcks.length}`);

if (mismatched.length > 0) {
  console.log('\nMismatched examples:');
  for (const r of mismatched.slice(0, 10)) console.log(' ', r);
}
if (duplicateAcks.length > 0) {
  console.log('\nDuplicate ack examples:');
  for (const [id, count] of duplicateAcks.slice(0, 10)) console.log(` ${id} acked ${count} times`);
}

const clean = mismatched.length === 0 && duplicateAcks.length === 0;
console.log(`\nResult: ${clean ? 'CLEAN - every request acked its own ID exactly once, no collisions' : 'ISSUES FOUND - see above'}`);
process.exit(clean ? 0 : 1);
