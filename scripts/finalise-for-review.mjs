// Final pass to make the workbook fit to circulate:
//   1. purges orphaned image data left behind by repeated evidence embeds
//   2. downgrades the two aggregation rows whose evidence does not support the claim
//   3. rewrites the Summary in plain language, with scope and caveats, and puts it first
//   4. labels the full-resolution evidence links as project-folder-only
//
// Run: node scripts/finalise-for-review.mjs
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const BOOK = path.join(ROOT, 'docs', 'Sheet1_Error_Code_Tests_DocsVsSystem.xlsx');
const EVID = path.join(ROOT, 'reports', 'newman', 'evidence');

const FILL = {
  MATCH: 'FFD9EAD3', PASS: 'FFD9EAD3',
  VARIANCE: 'FFFFF2CC', DEVIATION: 'FFFFF2CC',
  GAP: 'FFFCE5CD', RISK: 'FFF4CCCC',
  INFO: 'FFEFEFEF', INCONCLUSIVE: 'FFD9D9D9', BLOCKED: 'FFD9D9D9',
};
const SEV_FILL = { Critical: 'FFE06666', High: 'FFF6B26B', Medium: 'FFFFE599', Low: 'FFD0E0E3', Info: 'FFEFEFEF' };

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(BOOK);

const ec = wb.worksheets.find((w) => w.name.startsWith('Sheet1_Error_Code'));
const edge = wb.getWorksheet('Edge & Abnormal Cases');

// ---- 1. corrections to the two aggregation rows --------------------------------------
const CORRECTIONS = {
  'EC-F04': {
    assessment: 'INCONCLUSIVE', severity: 'Info',
    plain: 'Not proven either way - needs retesting. We built a four-level stack (pack inside case, case on pallet, pallet in container) when the guide allows only three, and the system accepted it. But every packing step in this test environment comes back saying it cannot find the container, which means the containers were never really registered. So the system probably never saw a three-level stack in the first place, and accepting a fourth step does not prove it failed to check. This needs testing again in an environment where containers register properly.',
    tech: 'INCONCLUSIVE. A 4-level aggregation was accepted (202), but PARENT_NOT_FOUND fires on every aggregation in this environment ("Parent SSCC has no active case_package_history row"), so a valid 3-level hierarchy was probably never established. Acceptance of the 4th level does not demonstrate the §3 depth limit is unenforced. Retest requires container SSCCs that register correctly.',
  },
  'EC-F01': {
    assessment: 'INCONCLUSIVE', severity: 'Info',
    plain: 'Not proven either way - needs retesting. We told the system a container was packed inside itself, which is impossible, and it was accepted. But the only warning raised was that the container could not be found, so the system may never have processed the relationship at all. Same test-environment limitation as the four-level stack test.',
    tech: 'INCONCLUSIVE. Self-referential aggregation (parentID present in childEPCs) accepted with 202, but the only warning was PARENT_NOT_FOUND, so the relationship may never have been evaluated. Same environment limitation as EC-F04. Retest required.',
  },
};

for (const [id, fix] of Object.entries(CORRECTIONS)) {
  let found = false;
  edge.eachRow((row, i) => {
    if (i === 1 || String(row.getCell(1).value || '').trim() !== id) return;
    row.getCell(10).value = fix.assessment;
    row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[fix.assessment] } };
    row.getCell(11).value = fix.severity;
    row.getCell(11).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SEV_FILL[fix.severity] } };
    row.getCell(12).value = fix.plain;
    row.getCell(13).value = fix.tech;
    for (const c of [12, 13]) row.getCell(c).alignment = { vertical: 'top', wrapText: true };
    found = true;
  });
  console.log(`${id}: ${found ? 'corrected to INCONCLUSIVE' : 'NOT FOUND'}`);
}

// ---- 2. purge orphaned media and re-embed the evidence images -------------------------
const before = wb.model.media.length;
const oldEv = wb.getWorksheet('Evidence');
if (oldEv) wb.removeWorksheet(oldEv.id);
wb.media.length = 0;

const ev = wb.addWorksheet('Evidence');
ev.getColumn(1).width = 150;
let row = 1;
ev.getCell(`A${row}`).value = 'Evidence — screenshots of each error-code test as it ran';
ev.getCell(`A${row}`).font = { bold: true, size: 16 };
row += 1;
ev.getCell(`A${row}`).value = 'Each image shows the exact request sent, the exact response received, and whether the checks passed. API keys are redacted. Captured from the Newman run of the Postman collection.';
ev.getCell(`A${row}`).font = { size: 11, color: { argb: 'FF555555' } };
row += 3;

const manifest = JSON.parse(fs.readFileSync(path.join(EVID, 'manifest.json'), 'utf8'));
const pngSize = (f) => { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
const IMG_W = 950;
const anchors = {};
let embedded = 0;

for (const m of manifest) {
  const file = path.join(EVID, `${m.id}_compact.png`);
  if (!fs.existsSync(file)) continue;
  anchors[m.id] = row;
  const head = ev.getCell(`A${row}`);
  head.value = `${m.id} — ${m.name.replace(/^TC-S1-\d{3} · /, '')}`;
  head.font = { bold: true, size: 13 };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: m.failed ? FILL.RISK : FILL.PASS } };
  ev.getRow(row).height = 22;
  row += 2;
  const { w, h } = pngSize(file);
  const drawH = Math.round((IMG_W / w) * h);
  ev.addImage(wb.addImage({ filename: file, extension: 'png' }), {
    tl: { col: 0, row: row - 1 }, ext: { width: IMG_W, height: drawH },
  });
  row += Math.ceil(drawH / 20) + 3;
  embedded++;
}
console.log(`media: ${before} -> ${wb.model.media.length} (${embedded} images re-embedded)`);

// relink the case rows, labelled so nobody expects the link to work off this machine
ec.getCell(1, 16).value = 'Evidence';
ec.getCell(1, 16).font = { bold: true };
ec.getColumn(16).width = 30;
let linked = 0;
ec.eachRow((r, i) => {
  if (i === 1) return;
  const id = String(r.getCell(1).value || '').trim();
  if (!anchors[id]) return;
  const c = r.getCell(16);
  c.value = { text: `See screenshot →`, hyperlink: `#Evidence!A${anchors[id]}` };
  c.font = { color: { argb: 'FF0563C1' }, underline: true };
  c.alignment = { vertical: 'top' };
  linked++;
});
console.log(`relinked ${linked} case rows`);

// ---- 3. plain-language summary, with scope and caveats --------------------------------
const oldSum = wb.getWorksheet('Summary');
if (oldSum) wb.removeWorksheet(oldSum.id);
const s = wb.addWorksheet('Summary');
s.columns = [{ width: 30 }, { width: 9 }, { width: 104 }];

const H = (t, size = 13) => { const r = s.addRow([t]); r.getCell(1).font = { bold: true, size }; return r; };
const P = (t) => { const r = s.addRow(['', '', t]); r.getCell(3).alignment = { wrapText: true }; return r; };
const KV = (k, v, t, fill) => {
  const r = s.addRow([k, v, t]);
  r.getCell(3).alignment = { wrapText: true };
  r.getCell(1).font = { bold: true };
  if (fill) r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  return r;
};

H('Track & Trace platform — test results', 16);
s.addRow(['', '', `Tested 2026-09-14 against the demo environment (tnt-demo.apeiro-digital.com). 126 tests in total.`])
  .getCell(3).alignment = { wrapText: true };
s.addRow([]);

H('Read this first');
P('Every reply from this environment is marked "sandbox". These results describe the demo system. Production has not been tested and may behave differently.');
P('Two problems are serious enough to act on before anything else. Both are in the dispensing step — the last check before medicine reaches a patient.');
s.addRow([]);

H('The two serious ones');
KV('Unknown packs dispensed', '', 'A pack the system has never seen before was dispensed successfully, with no warning. This is how a counterfeit or stolen pack would reach a patient.', SEV_FILL.Critical);
KV('Destroyed packs dispensed', '', 'A pack already recorded as destroyed was dispensed successfully, with no warning.', SEV_FILL.Critical);
P('Both point at the same thing: the safety checks that run everywhere else do not appear to run when dispensing. A dispense of expired product with an unrecognised batch was also accepted without a single warning.');
s.addRow([]);

H('What is in this workbook');
KV('Error codes (52 tests)', '52', 'Checks each error the technical guide promises. Does the system actually return it?');
KV('Edge & abnormal cases (74 tests)', '74', 'Unusual situations and mistakes, across manufacturer, distributor and pharmacy/hospital.');
KV('Evidence', '52', 'A screenshot of each error-code test showing exactly what was sent and what came back.');
s.addRow([]);

H('Results at a glance');
s.addRow(['Error codes', 'Count', '']).font = { bold: true };
for (const [k, v, t] of [
  ['Working', 34, 'Behaves exactly as the guide says.'],
  ['Different', 8, 'Right error, but wrong status number or wrong severity.'],
  ['Missing', 8, 'The guide names an error the system never actually returns.'],
  ['Not testable', 2, 'Needs test data that does not exist in this environment.'],
]) KV(k, v, t, FILL[{ Working: 'PASS', Different: 'DEVIATION', Missing: 'GAP', 'Not testable': 'BLOCKED' }[k]]);

s.addRow([]);
s.addRow(['Edge & abnormal', 'Count', '']).font = { bold: true };
const counts = {};
edge.eachRow((r, i) => { if (i === 1) return; const a = r.getCell(10).value; counts[a] = (counts[a] || 0) + 1; });
const EDGE_MEAN = {
  MATCH: 'Behaves sensibly, or exactly as the guide says.',
  GAP: 'The guide states a rule and the system does not enforce it.',
  VARIANCE: 'The system does something different from what the guide says.',
  RISK: 'Unsafe or corrupts data, regardless of what the guide says.',
  INFO: 'Guide is silent, or this environment lacked the data to decide. Needs a product decision.',
  INCONCLUSIVE: 'The test could not prove it either way. Needs retesting in a better environment.',
};
for (const k of ['RISK', 'GAP', 'VARIANCE', 'MATCH', 'INFO', 'INCONCLUSIVE']) {
  if (counts[k]) KV(k === 'MATCH' ? 'Working' : k === 'RISK' ? 'Unsafe' : k, counts[k], EDGE_MEAN[k], FILL[k]);
}
s.addRow([]);

H('What this testing could NOT establish');
P('Demo environment only. Production was not tested.');
P('No location code in this environment is registered, so almost every reply carries an "unknown location" warning. That is missing test data, not a fault in the platform — please do not read it as 126 failures.');
P('Container and pallet codes do not register either, so anything involving packing into cases or pallets could not be tested properly. Two rows are marked "inconclusive" for that reason.');
P('We only ever saw the immediate reply to each request. We did not query the system afterwards to confirm what was actually saved, so "the event was stored" is taken from the reply, not independently checked.');
P('Two error codes could not be triggered at all because the environment has no switched-off location and no product under recall.');
s.addRow([]);

H('How to read the two test sheets');
P('Start with the "What this means (plain English)" column — it gives the verdict in ordinary language. "Actual HTTP" and "Actual Codes Returned" show exactly what the system replied. "Technical detail" at the far right is for the developers.');
P('On the error-code sheet, section 6.1.1 rows are meant to be hard blocks (refused outright) and section 6.1.2 rows are soft flags (accepted but warned about). Three rows are marked where the system applies the wrong one of the two.');

// ---- 4. tab order: Summary first, Evidence last ---------------------------------------
const ORDER = { Summary: 0 };
ORDER[ec.name] = 1;
ORDER['Edge & Abnormal Cases'] = 2;
ORDER.Evidence = 3;
for (const w of wb.worksheets) if (ORDER[w.name] !== undefined) w.orderNo = ORDER[w.name];

await wb.xlsx.writeFile(BOOK);
console.log(`\nsaved -> ${BOOK} (${(fs.statSync(BOOK).size / 1e6).toFixed(1)} MB)`);
