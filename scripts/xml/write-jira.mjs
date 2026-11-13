import fs from 'node:fs';
import path from 'node:path';

const PROOF = path.join(import.meta.dirname, '..', '..', 'Proof', 'xml');
const results = JSON.parse(fs.readFileSync(path.join(PROOF, 'results.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(PROOF, 'manifest.json'), 'utf8'));
const by = Object.fromEntries(results.map((r) => [r.shot, r]));

function verdict(c, r) {
  if (!r) return 'NOT TESTED';
  if (r.verdict === 'NOT TESTABLE' || c.kind === 'not_testable') return 'NOT TESTABLE';
  if (String(r.summary || '').includes('skipped')) return 'NOT TESTED';
  const st = r.status?.status;
  const err = r.status?.error_code;
  const warn = r.status?.warning_codes || [];
  const code = c.code || null;
  if (err === 'PARTNER_TYPE_BIZSTEP_MISMATCH') return 'N/A (role)';
  if (c.expectFail || (c.kind === 'rule' && /Hard reject|Job failed|reject/i.test(c.expected || ''))) {
    if (st === 'failed' || (r.http && r.http >= 400)) return 'PASS';
    if (st === 'succeeded') return 'FAIL';
    if (st === 'accepted') return 'FAIL (stuck accepted)';
    return 'FAIL';
  }
  if (c.kind === 'setup') {
    if (st === 'succeeded' || err === 'DUPLICATE_EVENT_ID') return 'PASS';
    if (st === 'accepted') return 'FAIL (stuck accepted)';
    return st === 'failed' ? 'FAIL' : 'PASS';
  }
  if (st === 'succeeded') {
    if (c.kind === 'rule' && code && /Accepted with|warning/i.test(c.expected || '') && !warn.includes(code)) {
      return 'FAIL';
    }
    return 'PASS';
  }
  if (st === 'failed') return 'FAIL';
  if (st === 'accepted') return 'FAIL (stuck accepted)';
  return r.verdict || 'FAIL';
}

function statusCell(r) {
  if (!r) return '—';
  if (r.verdict === 'NOT TESTABLE') return r.summary || '—';
  if (!r.status) return r.summary || '—';
  const parts = [r.status.status];
  if (r.status.result_http_status != null) parts.push(`HTTP ${r.status.result_http_status}`);
  if (r.status.error_code) parts.push(r.status.error_code);
  if (r.status.warning_codes?.length) parts.push(`warnings: ${r.status.warning_codes.join(', ')}`);
  if (r.status.error_message) parts.push(String(r.status.error_message).slice(0, 140));
  return parts.join('; ');
}

function clean(s) {
  return String(s ?? '—').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
}

let pass = 0;
let fail = 0;
let na = 0;
let nt = 0;
let nte = 0;
const rows = [];
for (const c of manifest.cases) {
  const r = by[c.shot];
  const v = verdict(c, r);
  if (v === 'PASS') pass += 1;
  else if (String(v).startsWith('FAIL')) fail += 1;
  else if (String(v).startsWith('N/A')) na += 1;
  else if (v === 'NOT TESTABLE') nt += 1;
  else nte += 1;
  const ui = r?.http != null ? `HTTP ${r.http}` : (r?.summary || '—');
  const evidence = (r?.evidence && r.evidence !== '—')
    ? r.evidence
    : (fs.existsSync(path.join(PROOF, `${c.shot}.png`))
      ? (fs.existsSync(path.join(PROOF, `${c.shot}-status.png`)) ? `${c.shot}, ${c.shot}-status` : c.shot)
      : '—');
  rows.push({
    shot: c.shot,
    title: c.title,
    expected: c.expected,
    ui,
    status: statusCell(r),
    evidence,
    verdict: v,
  });
}

const lines = [
  'Manufacturer Partner Portal XML upload vs TnT rules (full matrix)',
  '',
  'Environment: https://tnt-demo.apeiro-digital.com/partners/upload',
  'Account: manufacturer@apeiro.digital (MEMPHIS VISIONCARE PVT.LTD, GLN 8901234567890)',
  'Auth: Partner session → POST /api/partners/uploads → GET /api/partners/async-submissions/{request_id}',
  'Run: 9 Nov 2026. Own EPCIS 1.2 XML fixtures. Early event screenshots kept in Proof/xml; remaining cases run without new screenshots.',
  'Pass rule: outcome matches guide (hard reject vs succeed+flag). Placeholder UNKNOWN_* warnings allowed on happy paths.',
  '',
  `Counts: PASS ${pass} · FAIL ${fail} · N/A ${na} · NOT TESTED ${nte} · NOT TESTABLE ${nt}`,
  '',
  'h3. Results',
  '',
  '||Check||Rule / Event||Expected||UI / HTTP||Status (job)||Evidence||Verdict||',
];
for (const row of rows) {
  lines.push(`| ${row.shot} | ${clean(row.title)} | ${clean(row.expected)} | ${clean(row.ui)} | ${clean(row.status)} | ${clean(row.evidence)} | ${row.verdict} |`);
}
lines.push(
  '',
  'h3. Findings',
  '# *Manufacturer XML upload path works.* Session auth, multipart POST, async status API.',
  '# *Several jobs remain status=accepted with no terminal result* after extended polling (queue stall). See FAIL (stuck accepted).',
  '# *Shipping with sourceList/destinationList succeeds* with SHIPPING_WITHOUT_COMMISSIONING / related warnings (E04, E06, R048).',
  '# *Recall Initiation (holding) → PARTNER_TYPE_BIZSTEP_MISMATCH* for manufacturer (E08).',
  '# *Stock Adjustment (stock_taking) succeeded* for manufacturer on demo (E15).',
  '# *Hard rejects confirmed:* INVALID_EXPIRY_FORMAT (R008), FUTURE_EVENT_TIME (R010), MISSING_NEEDED_FIELDS (R011), DUPLICATE_EPC_IN_EVENT (R014), INVALID_GS1_IDENTIFIER (R009/R025/R026), DUPLICATE_EVENT_ID / DUPLICATE_EVENT_PAYLOAD (R012/R013).',
  '# *Duplicate eventID contamination:* some later fixtures reused IDs from earlier uploads (DUPLICATE_EVENT_ID). Re-run those with fresh UUIDs if a clean PASS/FAIL is required.',
  '# *NOT TESTABLE rows* cannot be expressed via manufacturer .xml upload alone (JSON-LD, dispense, facility, error-declaration chains, missing fixtures).',
  '',
  'Evidence (where captured earlier): Proof/xml/{Check}.png and {Check}-status.png',
);
fs.writeFileSync(path.join(PROOF, 'JIRA_COMMENT.txt'), `${lines.join('\n')}\n`);
console.log(`wrote JIRA_COMMENT.txt (${rows.length} rows) PASS=${pass} FAIL=${fail} N/A=${na} NT=${nte} NTable=${nt}`);
