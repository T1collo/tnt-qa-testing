// Builds the TnT Performance + Security QA workbook.
//
// Single source of truth is the two markdown checklists in docs/ - this parses their
// tables rather than keeping a second copy of the test cases, so the doc and the sheet
// can never drift apart. Actual results are merged in from the newest
// security/results/probe-*.json so a run's evidence lands in the sheet automatically.
//
// Run: node scripts/make-checklist-workbook.mjs
// Out: reports/TnT_Perf_Security_Checklist.xlsx
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- parse a markdown checklist -------------------------------------------------
// Rows look like: | TNT-SEC-AUTH-001 | Check text | Expected | ☐ | |
// Section headings look like: ## A. Partner API authentication
function parseChecklist(file) {
  const rows = [];
  let section = '';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h && !/^What to record|^Tooling|^Automated scanning|^Reporting format/.test(h[1])) {
      section = h[1].trim();
      continue;
    }
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    const [id, check, expected] = cells;
    if (!/^TNT-(PERF|SEC)-/.test(id)) continue;
    rows.push({ id, section, check, expected });
  }
  return rows;
}

const perf = parseChecklist(path.join(ROOT, 'docs', 'TnT-Performance-QA-Checklist.md'));
const sec = parseChecklist(path.join(ROOT, 'docs', 'TnT-Security-QA-Checklist.md'));

// --- merge in actual results from the newest probe run --------------------------
const actuals = new Map();
let runMeta = null;
const resultsDir = path.join(ROOT, 'security', 'results');
if (fs.existsSync(resultsDir)) {
  const newest = fs.readdirSync(resultsDir).filter((f) => f.startsWith('probe-')).sort().pop();
  if (newest) {
    const data = JSON.parse(fs.readFileSync(path.join(resultsDir, newest), 'utf8'));
    runMeta = {
      target: data.base || data.target || 'unknown',
      ranAt: (data.ranAt || '').slice(0, 19).replace('T', ' '),
      roles: (data.rolesTested || []).join(', '),
      file: newest,
    };
    for (const r of data.results) {
      actuals.set(r.id, { actual: r.actual, status: r.status, severity: r.severity, evidence: r.evidence });
    }
    // The probe runs the cross-role matrix as nine numbered cases; the checklist tracks
    // it as one. Roll them up so TNT-SEC-AUTHZ-001 reflects the whole matrix.
    const authz = data.results.filter((r) => /^TNT-SEC-AUTHZ-\d+$/.test(r.id));
    if (authz.length) {
      const offDiagonal = authz.filter((r) => /CANNOT/.test(r.title));
      const allBlocked = offDiagonal.every((r) => r.status === 'PASS');
      actuals.set('TNT-SEC-AUTHZ-001', {
        actual: JSON.stringify(data.matrix),
        status: allBlocked ? 'PASS' : 'FAIL',
        severity: allBlocked ? '-' : 'Critical',
        evidence: `matrix from ${newest}`,
      });
    }
    console.log(`merged actuals from ${newest} (${data.results.length} probe results)`);
  }
}

// --- workbook -------------------------------------------------------------------
const wb = new ExcelJS.Workbook();
wb.creator = 'TnT QA';
wb.created = new Date();

const HEADER_FILL = '1F4E78';
const SEVERITY_FILL = { Critical: 'C00000', High: 'E36C0A', Medium: 'BF8F00', Low: '2E75B6', '-': null };

function addSheet(name, rows, tabColor) {
  const ws = wb.addWorksheet(name, {
    properties: { tabColor: { argb: tabColor } },
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = [
    { header: 'ID', key: 'id', width: 22 },
    { header: 'Section', key: 'section', width: 34 },
    { header: 'Check', key: 'check', width: 62 },
    { header: 'Expected Result', key: 'expected', width: 30 },
    { header: 'Actual Result', key: 'actual', width: 34 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Severity', key: 'severity', width: 11 },
    { header: 'Evidence', key: 'evidence', width: 60 },
  ];

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;

  for (const r of rows) {
    const a = actuals.get(r.id);
    ws.addRow({
      id: r.id,
      section: r.section,
      check: r.check,
      expected: r.expected,
      actual: a ? a.actual : '',
      status: a ? a.status : 'NOT RUN',
      severity: a && a.severity !== '-' ? a.severity : '',
      evidence: a ? a.evidence : '',
    });
  }

  ws.eachRow((row, i) => {
    if (i === 1) return;
    row.alignment = { vertical: 'top', wrapText: true };
    const status = row.getCell('status').value;
    const sev = row.getCell('severity').value;

    if (status === 'PASS') {
      row.getCell('status').font = { bold: true, color: { argb: 'FF107C41' } };
    } else if (status === 'FAIL') {
      row.getCell('status').font = { bold: true, color: { argb: 'FFC00000' } };
      // Tint the whole row so failures are findable without filtering.
      row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } }; });
    } else {
      row.getCell('status').font = { color: { argb: 'FF808080' } };
    }

    const fill = SEVERITY_FILL[sev];
    if (fill) {
      row.getCell('severity').font = { bold: true, color: { argb: 'FFFFFFFF' } };
      row.getCell('severity').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${fill}` } };
    }
  });

  ws.autoFilter = { from: 'A1', to: { row: 1, column: 8 } };
  return ws;
}

addSheet('Performance', perf, 'FF2E75B6');
addSheet('Security', sec, 'FFC00000');

// --- summary --------------------------------------------------------------------
const all = [...perf, ...sec];
const counted = all.map((r) => actuals.get(r.id)).filter(Boolean);
const summary = wb.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF404040' } } });
summary.columns = [
  { header: 'Metric', key: 'k', width: 42 },
  { header: 'Value', key: 'v', width: 24 },
];
summary.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
summary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };

const bySeverity = counted.reduce((a, r) => (r.status === 'FAIL' ? { ...a, [r.severity]: (a[r.severity] || 0) + 1 } : a), {});
summary.addRows([
  { k: 'Generated', v: new Date().toISOString().slice(0, 19).replace('T', ' ') },
  { k: 'Environment the results came from', v: runMeta ? runMeta.target : 'no results merged' },
  { k: 'Test run timestamp (UTC)', v: runMeta ? runMeta.ranAt : '-' },
  { k: 'Partner roles exercised', v: runMeta ? runMeta.roles : '-' },
  { k: 'Source result file', v: runMeta ? runMeta.file : '-' },
  { k: '', v: '' },
  { k: 'Performance checks defined', v: perf.length },
  { k: 'Security checks defined', v: sec.length },
  { k: 'Total checks defined', v: all.length },
  { k: '', v: '' },
  { k: 'Executed (automated this run)', v: counted.length },
  { k: 'Passed', v: counted.filter((r) => r.status === 'PASS').length },
  { k: 'Failed', v: counted.filter((r) => r.status === 'FAIL').length },
  { k: 'Not yet run', v: all.length - counted.length },
  { k: '', v: '' },
  ...['Critical', 'High', 'Medium', 'Low'].map((s) => ({ k: `Failures - ${s}`, v: bySeverity[s] || 0 })),
]);
summary.eachRow((row, i) => { if (i > 1) row.getCell('k').font = { bold: /^(Total|Executed|Failures)/.test(String(row.getCell('k').value)) }; });

const out = path.join(ROOT, 'reports', 'TnT_Perf_Security_Checklist.xlsx');
fs.mkdirSync(path.dirname(out), { recursive: true });
await wb.xlsx.writeFile(out);

console.log(`\nPerformance checks: ${perf.length}`);
console.log(`Security checks:    ${sec.length}`);
console.log(`Total:              ${all.length}  (${counted.length} with recorded results)`);
console.log(`written: ${path.relative(ROOT, out).replace(/\\/g, '/')}`);
