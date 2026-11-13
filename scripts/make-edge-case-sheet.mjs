// Merges reports/edge-cases.json into the master workbook as an "Edge & Abnormal Cases"
// sheet, adding the per-case assessment (does the system match the documented rule, or
// vary from it) and severity, plus a Summary sheet covering both suites.
//
// Re-runnable: it rebuilds its own sheets and leaves the error-code sheet and its
// embedded evidence images untouched.
//
// Run: node scripts/make-edge-case-sheet.mjs
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const results = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'edge-cases.json'), 'utf8'));
const OUT = path.join(ROOT, 'docs', 'Sheet1_Error_Code_Tests_DocsVsSystem.xlsx');

// assessment: MATCH | VARIANCE | GAP | RISK | INFO ; severity: Critical|High|Medium|Low|Info
const A = {
  'EC-A01': ['MATCH', 'Medium', 'Blocked with 409, so the serial cannot be silently bound to a second lot. But the block comes from payload dedupe, not a lot rule: the hash key is EPC+bizStep, so LOT is not part of the identity. Consequence: a legitimate lot correction is impossible through re-submission and must go through a GS1 error declaration (§6.4). The error message says "duplicate", which will mislead a partner who genuinely mis-keyed a lot.'],
  'EC-A02': ['MATCH', 'Low', 'Whole document rejected with 409. Consistent with EC-A01 and with the §3.1.1.1 Lot Integrity Rule.'],
  'EC-A03': ['MATCH', 'Info', 'Exact replay returns 409 DUPLICATE_EVENT_ID as §6.3 requires. Idempotency holds.'],
  'EC-A04': ['MATCH', 'Info', 'Control case. Multiple serials under one lot in one event is accepted, confirming the rule constrains lots per event, not serials.'],
  'EC-A05': ['MATCH', 'Medium', 'Re-commissioning a shipped serial is blocked, but again by payload dedupe rather than a lifecycle rule. A serial can never be re-commissioned regardless of state, so the lifecycle check is never exercised.'],
  'EC-A06': ['GAP', 'High', 'A shipping event carrying a lot that contradicts the commissioning lot is ACCEPTED. The INVALID_LOT warning fires only because the lot is unregistered, not because it contradicts prior data. Contradictory master data on the same serial is not detected.'],
  'EC-A07': ['MATCH', 'Info', 'Both accepted, correctly. The same serial under two different GTINs is two distinct SGTINs, proving dedupe is not keyed on the bare serial number.'],

  'EC-B01': ['GAP', 'High', '§3.1.1 states every SGTIN commissioning event must include ILMD with lot number and expiration date. An event with no ilmd block at all is accepted with 202 and NO warning.'],
  'EC-B02': ['GAP', 'High', 'Empty ilmd object accepted silently, same as EC-B01.'],
  'EC-B03': ['GAP', 'High', 'Empty-string lot accepted AND the INVALID_LOT check does not fire. Supplying an empty lot is a way to bypass lot validation entirely.'],
  'EC-B04': ['GAP', 'High', 'Null lot accepted and INVALID_LOT bypassed, identical to EC-B03.'],
  'EC-B05': ['GAP', 'High', 'Expiry date is mandatory at commissioning per §3.1.1 but its absence is accepted with no warning. Expiry drives EXPIRING_SOON and EXPIRED_PRODUCT, so those rules are silently disabled for such serials.'],
  'EC-B06': ['INFO', 'Medium', 'Accepted. The guide requires countryOfOrigin only for foreign MAH products, and the sandbox has no MAH fixture to distinguish, so this cannot be conclusively tested here. Needs a foreign-MAH product fixture.'],
  'EC-B07': ['GAP', 'Medium', 'countryOfOrigin "ZZ9" is not a valid ISO 3166 code and is accepted unvalidated. This is a regulatory declaration field.'],
  'EC-B08': ['GAP', 'High', 'The guide states bizLocation is operationally mandatory on every event because it anchors regulatory jurisdiction. Omitting it is accepted with 202.'],
  'EC-B09': ['MATCH', 'Info', 'readPoint omitted is accepted, exactly as the guide allows.'],
  'EC-B10': ['INFO', 'Low', 'Accepted with no disposition. The lifecycle engine keys off disposition, so events without one are effectively invisible to state validation.'],
  'EC-B11': ['GAP', 'Medium', 'eventTimeZoneOffset is in the §3.1.1 mandatory field list but its absence is accepted.'],
  'EC-B12': ['MATCH', 'Info', 'Unknown vendor extension field accepted and ignored. Correct forward-compatible behaviour.'],
  'EC-B13': ['MATCH', 'Info', 'Empty epcList rejected with 400 MISSING_NEEDED_FIELDS.'],
  'EC-B14': ['MATCH', 'Info', 'Null epcList rejected identically to empty. Consistent.'],

  'EC-C01': ['MATCH', 'Info', 'Out-of-order submission accepted, exactly as §6.1.3 promises.'],
  'EC-C02': ['MATCH', 'Info', 'Identical eventTimes on distinct serials accepted, as required for a production run.'],
  'EC-C03': ['MATCH', 'Low', 'Accepted. A UTC eventTime with a declared local offset is valid EPCIS.'],
  'EC-C04': ['VARIANCE', 'Medium', 'eventTimeZoneOffset "+25:00" is outside the EPCIS -14:00..+14:00 range and is accepted with 202. No schema validation on this field.'],
  'EC-C05': ['INFO', 'Medium', 'A client-supplied recordTime one year in the past is accepted. EPCIS requires recordTime to be repository-assigned. Whether the client value is stored or overwritten cannot be confirmed without a repository query API - worth verifying, since a client-controlled audit timestamp would be a serious integrity issue.'],
  'EC-C06': ['MATCH', 'Info', 'Epoch integer eventTime rejected with 400 INVALID_EVENT_TIME.'],
  'EC-C07': ['MATCH', 'Info', 'Rejected at the 5-minute boundary. Measured server clock skew is about 1.3s, so client-side tests within ~2s of the boundary are not reliable; the 5-minute window itself is confirmed correct.'],

  'EC-D01': ['MATCH', 'Info', 'Empty eventList rejected with 400.'],
  'EC-D02': ['VARIANCE', 'Medium', '§6.2 documents 207 PARTIALLY_ACCEPTED ("some events accepted, others rejected with error details"). A document with one valid and one invalid event returns 400 and stores nothing. 207 was not reproducible in any scenario tested, so the documented status appears unreachable.'],
  'EC-D03': ['MATCH', 'Info', 'Valid event plus warning-level event: both stored, 202, warning returned. Correct.'],
  'EC-D04': ['MATCH', 'Info', '@context as a string accepted. Both JSON-LD forms supported.'],
  'EC-D05': ['MATCH', 'Info', 'text/plain rejected with 415 UNSUPPORTED_FORMAT exactly as §6.2 documents.'],
  'EC-D06': ['VARIANCE', 'Low', '§2.4 explicitly lists URN long-form CBV tokens as "Not allowed" in JSON-LD 2.0, yet urn:epcglobal:cbv:bizstep:commissioning is accepted. System is more lenient than the guide; either the guide or the validator should change.'],
  'EC-D07': ['RISK', 'High', 'An uppercase EPC URN is accepted AND creates a SECOND, separate identity - the duplicate check does not fire against the lower-case original. The same physical serial can therefore exist twice in the national registry under different casings. Contrast EC-D08, where whitespace IS normalised.'],
  'EC-D08': ['MATCH', 'Info', 'Whitespace-padded EPC is trimmed: a subsequent duplicate correctly returns 409, proving it resolves to the same identity.'],
  'EC-D09': ['INFO', 'Low', 'Unicode and emoji lot accepted. Round-trip fidelity cannot be confirmed without a repository read API.'],
  'EC-D10': ['VARIANCE', 'Medium', 'A 1000-character lot number is accepted. GS1 AI (10) caps batch/lot at 20 characters, so this cannot be represented on a physical barcode.'],
  'EC-D11': ['RISK', 'Medium', 'A document with bizStep declared twice is accepted and the LAST value silently wins - the event was stored as shipping, evidenced by the SHIPPING_WITHOUT_COMMISSIONING warning, despite commissioning being declared first. An ambiguous document should be rejected, not reinterpreted.'],

  'EC-E01': ['MATCH', 'Info', 'Class-level commissioning via quantityList with an LGTIN is accepted.'],
  'EC-E02': ['MATCH', 'Info', 'Zero quantity rejected with 400 INVALID_QUANTITY.'],
  'EC-E03': ['MATCH', 'Info', 'Negative quantity rejected with 400 INVALID_QUANTITY.'],
  'EC-E04': ['VARIANCE', 'High', '§3.3.3 requires dispensing at unit level with SGTINs. A class-level dispense using quantityList is ACCEPTED with 201 and the response confirms class_level handling. This defeats serial-level dispensing control.'],

  'EC-F01': ['VARIANCE', 'Medium', 'An SSCC aggregated into itself is accepted with 202; only PARENT_NOT_FOUND fires, which is incidental. A self-referential container is physically impossible and should be rejected outright.'],
  'EC-F02': ['MATCH', 'Info', 'Empty childEPCs rejected with 400.'],
  'EC-F03': ['MATCH', 'Low', 'Same child under two parents in one document is flagged CHILD_ALREADY_AGGREGATED. Detected, though only as an advisory warning.'],
  'EC-F04': ['GAP', 'Medium', 'The guide sets maximum hierarchy depth at 3. A fourth level (item -> case -> pallet -> container) is accepted with no depth warning.'],
  'EC-F05': ['MATCH', 'Info', 'Duplicate child in childEPCs rejected with 400 DUPLICATE_EPC_IN_EVENT, confirming the rule covers childEPCs as well as epcList.'],
  'EC-F06': ['MATCH', 'Info', 'Unpacking a never-aggregated child is flagged UNPACK_WITHOUT_AGGREGATION.'],
  'EC-F07': ['MATCH', 'Low', 'Aggregating a dispensed serial is flagged INVALID_DISPOSITION. Detected, advisory only.'],

  'EC-G01': ['MATCH', 'Info', 'Own endpoint accepted.'],
  'EC-G02': ['MATCH', 'Info', '403 FORBIDDEN. Role scoping enforced.'],
  'EC-G03': ['MATCH', 'Info', '403 FORBIDDEN. Role scoping enforced.'],
  'EC-G04': ['MATCH', 'Info', '403 FORBIDDEN. Role scoping enforced.'],
  'EC-G05': ['MATCH', 'Info', 'Own endpoint accepted.'],
  'EC-G06': ['MATCH', 'Info', '403 FORBIDDEN. Role scoping enforced.'],
  'EC-G07': ['MATCH', 'Info', '403 FORBIDDEN. Role scoping enforced.'],
  'EC-G08': ['MATCH', 'Info', '403 FORBIDDEN. Role scoping enforced.'],
  'EC-G09': ['MATCH', 'Info', 'Own endpoint accepted.'],
  'EC-G10': ['MATCH', 'Info', 'Manufacturer key refused at the dispense endpoint with 403.'],
  'EC-G11': ['MATCH', 'Info', '401 with a clear message and no detail leaked.'],
  'EC-G12': ['MATCH', 'Info', '401 for a junk key, identical response shape to no key.'],
  'EC-G13': ['GAP', 'Medium', 'A facility can submit a commissioning event on its own endpoint and it is accepted. Endpoint-level role scoping is enforced (EC-G02..G08) but event-type-per-role is not: only a manufacturer should commission product.'],
  'EC-G14': ['GAP', 'Medium', 'A distributor can likewise commission product. Same gap as EC-G13.'],

  'EC-H01': ['RISK', 'Critical', 'A serial that was NEVER COMMISSIONED is dispensed successfully with 201 and no warning whatsoever. Unknown - potentially counterfeit - stock can be dispensed to a patient and the platform records it as a clean dispense. This is the primary anti-counterfeit control and it does not fire on the synchronous path.'],
  'EC-H02': ['RISK', 'Critical', 'A serial already marked DESTROYED is dispensed successfully with 201 and no warning. Destroyed stock must never reach a patient.'],
  'EC-H03': ['MATCH', 'Low', 'Second shipping flagged INVALID_DISPOSITION. Detected, advisory only.'],
  'EC-H04': ['MATCH', 'Low', 'Second receipt flagged INVALID_DISPOSITION. Detected, advisory only.'],
  'EC-H05': ['GAP', 'Medium', 'Returning a serial after it has been dispensed is accepted with no return-specific or terminal-state warning. §4.2 defines return events but no rule prevents re-entry of dispensed product into the supply chain.'],
  'EC-H06': ['MATCH', 'High', 'The second dispense IS blocked - but with 409 DUPLICATE_EVENT_PAYLOAD from the dedupe layer, not SERIAL_ALREADY_DISPENSED from the lifecycle engine. The control works by accident of hashing on EPC+bizStep. A partner dispensing the same serial at a different facility sees a misleading "duplicate payload" error rather than "already dispensed to a patient".'],
  'EC-H07': ['MATCH', 'Low', 'Second destruction blocked by payload dedupe (409), same mechanism as EC-H06.'],
  'EC-H08': ['MATCH', 'Low', 'Marking a dispensed serial damaged is flagged INVALID_DISPOSITION.'],
  'EC-H09': ['MATCH', 'Low', 'Reporting a destroyed serial stolen is flagged SERIAL_ALREADY_DESTROYED.'],
  'EC-H10': ['MATCH', 'Info', 'Shipping from a location the serial never reached is flagged INVENTORY_SIGHTING_MISMATCH.'],
};

const FILL = {
  MATCH: 'FFD9EAD3', VARIANCE: 'FFFFF2CC', GAP: 'FFFCE5CD', RISK: 'FFF4CCCC', INFO: 'FFEFEFEF',
};
const SEV_FILL = {
  Critical: 'FFE06666', High: 'FFF6B26B', Medium: 'FFFFE599', Low: 'FFD0E0E3', Info: 'FFEFEFEF',
};

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(OUT);

// rebuild our own sheets so the script can be re-run; the error-code sheet and the
// Evidence sheet (with its 52 embedded screenshots) are left alone
for (const name of ['Edge & Abnormal Cases', 'Summary']) {
  const old = wb.getWorksheet(name);
  if (old) wb.removeWorksheet(old.id);
}

const ws = wb.addWorksheet('Edge & Abnormal Cases', {
  views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }],
});

const COLS = [
  ['Test Case ID', 13], ['Category', 24], ['Role', 14], ['Scenario', 46],
  ['Steps to Reproduce', 54], ['Documented Rule / Basis', 40], ['Expected Behaviour', 46],
  ['Actual HTTP', 12], ['Actual Codes Returned', 40], ['Assessment', 13], ['Severity', 11],
  ['Finding / Notes', 88],
];
ws.columns = COLS.map(([header, width]) => ({ header, width }));

const hdr = ws.getRow(1);
hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF434343' } };
hdr.alignment = { vertical: 'middle', wrapText: true };
hdr.height = 34;

let n = 0;
const tally = {};
const sevTally = {};

for (const r of results) {
  const [assessment, severity, note] = A[r.id] || ['INFO', 'Info', ''];
  tally[assessment] = (tally[assessment] || 0) + 1;
  sevTally[severity] = (sevTally[severity] || 0) + 1;

  const row = ws.addRow([
    r.id, r.cat, r.role, r.title, r.steps, r.rule, r.expect,
    String(r.status), r.codes.join(', ') || '(none)', assessment, severity, note,
  ]);
  row.alignment = { vertical: 'top', wrapText: true };
  row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[assessment] } };
  row.getCell(10).font = { bold: true };
  row.getCell(11).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SEV_FILL[severity] } };
  row.getCell(8).alignment = { vertical: 'top', horizontal: 'center' };
  if (assessment === 'RISK') row.getCell(4).font = { bold: true };
  n++;
}

ws.autoFilter = { from: 'A1', to: { row: 1, column: COLS.length } };

// ---- summary sheet, covering both suites in this workbook ----
const s = wb.addWorksheet('Summary');
s.columns = [{ width: 26 }, { width: 10 }, { width: 96 }];

s.addRow(['TnT conformance testing — results summary']).font = { bold: true, size: 15 };
s.addRow([`Executed ${new Date().toISOString().slice(0, 10)} against the live platform. All results are real responses, not projections.`]);
s.addRow([]);

s.addRow(['This workbook contains', '', '']).font = { bold: true };
s.addRow(['Error-code sheet', '52', 'Every error code in guide §6.1.1 / §6.1.2, with a Newman evidence screenshot per case on the Evidence sheet.']).getCell(3).alignment = { wrapText: true };
s.addRow(['Edge & Abnormal Cases', String(results.length), 'Unusual, abnormal and outside-the-happy-path scenarios across all three roles.']).getCell(3).alignment = { wrapText: true };
s.addRow(['Evidence', '52', 'Full request/response/assertion screenshots from the Newman run of the error-code suite.']).getCell(3).alignment = { wrapText: true };
s.addRow([]);

s.addRow(['Error-code suite (52 cases)', 'Count', '']).font = { bold: true };
for (const [k, v, m] of [
  ['PASS', 34, 'Behaves exactly as documented.'],
  ['DEVIATION', 8, 'Right code, wrong HTTP status or severity.'],
  ['GAP', 8, 'Documented error code is never emitted by the system.'],
  ['BLOCKED', 2, 'Needs a sandbox fixture (inactive SGLN, active recall) before it can be tested.'],
]) {
  const row = s.addRow([k, v, m]);
  row.getCell(1).font = { bold: true };
  row.getCell(3).alignment = { wrapText: true };
}
s.addRow([]);

s.addRow(['Edge & abnormal suite', 'Count', 'Meaning']).font = { bold: true };
const MEAN = {
  MATCH: 'System behaves as the onboarding guide documents, or as a reasonable implementation should.',
  VARIANCE: 'System behaviour differs from what the guide states.',
  GAP: 'The guide states a rule; the system does not enforce it.',
  RISK: 'Behaviour is unsafe or corrupts identity regardless of what the guide says.',
  INFO: 'Guide is silent, or the sandbox lacks the fixture needed to conclude. Product decision or further test needed.',
};
for (const k of ['RISK', 'GAP', 'VARIANCE', 'MATCH', 'INFO']) {
  if (!tally[k]) continue;
  const row = s.addRow([k, tally[k], MEAN[k]]);
  row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[k] } };
  row.getCell(1).font = { bold: true };
  row.getCell(3).alignment = { wrapText: true };
}
s.addRow([]);
s.addRow(['Severity', 'Count', '']).font = { bold: true };
for (const k of ['Critical', 'High', 'Medium', 'Low', 'Info']) {
  if (!sevTally[k]) continue;
  const row = s.addRow([k, sevTally[k], '']);
  row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SEV_FILL[k] } };
}
s.addRow([]);
s.addRow(['Root cause worth reading first', '', '']).font = { bold: true, size: 12 };
const rc = s.addRow(['', '', 'The synchronous dispense endpoint does not run the business-rule engine. A dispense of product that is simultaneously expired AND carries an unregistered lot returns a bare 201 with no warnings[] array at all. This single cause explains EC-H01 (never-commissioned serial dispensed), EC-H02 (destroyed serial dispensed), EC-E04 (class-level dispensing accepted) and the SERIAL_ALREADY_DISPENSED gap in the error-code suite. Dispensing is the last point of control before a patient receives the product.']);
rc.getCell(3).alignment = { wrapText: true };
rc.height = 76;
s.addRow([]);

s.addRow(['Critical & high-severity findings', '', '']).font = { bold: true };
s.addRow(['Case', 'Severity', 'Finding']).font = { bold: true };
for (const r of results) {
  const [assessment, severity, note] = A[r.id] || [];
  if (severity !== 'Critical' && severity !== 'High') continue;
  const row = s.addRow([r.id, severity, `[${assessment}] ${r.title} — ${note}`]);
  row.getCell(3).alignment = { wrapText: true };
  row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SEV_FILL[severity] } };
  row.getCell(1).font = { bold: true };
}

await wb.xlsx.writeFile(OUT);
console.log(`${n} cases written -> ${OUT}`);
console.log('assessment:', tally);
console.log('severity  :', sevTally);
