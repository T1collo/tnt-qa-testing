// Generates a fresh test pack for the Manufacturer portal's Bulk CSV import (Production >
// Batches > "Bulk CSV") and the async processing behind it.
//
// Every earlier CSV in "../CSV-bulk import tests" has already been ingested, so re-uploading one
// only proves the duplicate check. This mints new serials, SSCCs and timestamps on every run, so
// the files can be regenerated whenever a clean upload is needed.
//
// Two importer behaviours shape the data (see bulk_import_demo_NOTES.md):
//   - event IDs are derived from row content, so every row gets its own Event_Timestamp
//   - anything more than 5 minutes ahead of server time is rejected, so all times are in the past
//
// Run:  node scripts/csv/make-bulk-csv.mjs [--gtin 6161102974997] [--gln 0614141000012]
//                                          [--large-rows 5000] [--target-mb 10] [--out <dir>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.join(import.meta.dirname, '..', '..');
const CSV_DIR = path.join(ROOT, '..', 'CSV-bulk import tests');
const TEMPLATE = path.join(CSV_DIR, 'epcis-event-csv-template (2).csv');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => {
    if (a.startsWith('--')) pairs.push([a.slice(2), all[i + 1]]);
    return pairs;
  }, [])
);

const GTIN = args.gtin || '6161102974997';
const GLN = args.gln || '0614141000012';
const LARGE_ROWS = Number(args['large-rows'] || 5000);
// "10 MB" is ambiguous (10,000,000 vs 10,485,760 bytes), so the boundary files sit outside
// both readings: "under" is below the decimal one, "over" is above the binary one.
const TARGET_MB = Number(args['target-mb'] || 10);
const UNDER_BYTES = TARGET_MB * 1_000_000 - 50_000;
const OVER_BYTES = TARGET_MB * 1024 * 1024 + 150_000;
const SERIAL_LIMIT = 50_000;

const now = new Date();
const ymd = now.toISOString().slice(0, 10);
const OUT = args.out || path.join(CSV_DIR, ymd);

// --- template header ----------------------------------------------------------------------------
const HEADER = fs.readFileSync(TEMPLATE, 'utf8').replace(/^﻿/, '').split(/\r?\n/)[0];
const COLS = HEADER.split(',');
if (COLS.length !== 27) throw new Error(`template header has ${COLS.length} columns, expected 27`);
const col = Object.fromEntries(COLS.map((c, i) => [c, i]));

// --- run identity -------------------------------------------------------------------------------
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RUN = Array.from(crypto.randomBytes(3), (b) => ALNUM[b % ALNUM.length]).join('');
const MMDD = ymd.slice(5, 7) + ymd.slice(8, 10);
const SSCC_RUN = String(crypto.randomInt(100, 1000));
const LOT_MFG = `${ymd.slice(0, 8)}01`;
const LOT_EXP = `${Number(ymd.slice(0, 4)) + 2}-${ymd.slice(5, 7)}-01`;
const PERMIT = `PPB/IMP/${ymd.slice(0, 4)}/${String(crypto.randomInt(1000, 10000)).padStart(6, '0')}`;

// GS1 mod-10 check digit, weights 3,1,3... from the right of the body.
function checkDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return String((10 - (sum % 10)) % 10);
}
const validGs1 = (code) => checkDigit(code.slice(0, -1)) === code.slice(-1);

// Per-file counters keep serials and SSCCs unique across the whole pack.
function minter(fileCode) {
  let s = 0;
  let c = 0;
  return {
    serial: () => `Q${MMDD}${RUN}${fileCode}${String(++s).padStart(6, '0')}`,
    // extension 0 + company prefix 6164003 + 9-digit serial reference + check digit
    sscc: () => {
      const body = `06164003${SSCC_RUN}${fileCode.slice(-1)}${String(++c).padStart(5, '0')}`;
      return body + checkDigit(body);
    },
    lot: `BATCH-${ymd.replaceAll('-', '')}-${RUN}${fileCode}`,
  };
}

// Local Nairobi time (+03:00), which is how the template writes Event_Timestamp.
const nairobi = (ms) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 19);

// A clock that hands out one-second-apart timestamps ending an hour before now.
function clock(rowCount) {
  let t = now.getTime() - (rowCount + 3600) * 1000;
  return () => nairobi((t += 1000));
}

function row(fields) {
  const r = new Array(27).fill('');
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in col)) throw new Error(`unknown column ${k}`);
    r[col[k]] = v;
  }
  return r;
}

const commission = (m, ts, serial, extra = {}) => row({
  Event_Type: 'COMMISSIONING', Identifier_Type: 'SGTIN', GTIN, Unit_ID: serial,
  Packaging_Level: 'Item', Event_Timestamp: ts, Event_TimeZone_Offset: '+03:00',
  BizLocation_GLN: GLN, Lot_Batch_Number: m.lot, Lot_Manufacturing_Date: LOT_MFG,
  Lot_Expiry_Date: LOT_EXP, Manufacturing_Origin: 'IMPORT', Country_of_Origin: 'Germany',
  Import_Sales_Permit_Ref: PERMIT, ...extra,
});

const aggItem = (ts, serial, parent, extra = {}) => row({
  Event_Type: 'AGGREGATION', Identifier_Type: 'SGTIN', GTIN, Unit_ID: serial, Parent_ID: parent,
  Packaging_Level: 'Item', Event_Timestamp: ts, Event_TimeZone_Offset: '+03:00',
  BizLocation_GLN: GLN, ...extra,
});

const aggCase = (ts, sscc, parent, extra = {}) => row({
  Event_Type: 'AGGREGATION', Identifier_Type: 'SSCC', Unit_ID: sscc, Parent_ID: parent,
  Packaging_Level: 'Case', Event_Timestamp: ts, Event_TimeZone_Offset: '+03:00',
  BizLocation_GLN: GLN, ...extra,
});

const ship = (ts, sscc, ref, extra = {}) => row({
  Event_Type: 'SHIPPING', Identifier_Type: 'SSCC', Unit_ID: sscc, Packaging_Level: 'Package',
  Event_Timestamp: ts, Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN,
  Import_Sales_Permit_Ref: PERMIT,
  Sender_Owner_GLN: '4012345000009', Sender_Owner_Name: 'Bayer AG',
  Sender_Custodian_GLN: '4012345000009', Sender_Location_Name: 'Bayer Leverkusen DC',
  Receiver_Owner_GLN: '0614142000011', Receiver_Owner_Name: 'KEMSA',
  Receiver_Custodian_GLN: '0614142000011', Receiver_Location_Name: 'KEMSA Embakasi Warehouse',
  LSP_GLN: '0614143000010', LSP_Name: 'DHL Supply Chain Kenya',
  Transaction_Type: 'desadv', Transaction_Reference: ref, ...extra,
});

// Full hierarchy: items -> cases of 10 -> pallets of 10 cases -> one SHIPPING per pallet.
function hierarchy(fileCode, items, perCase = 10, casesPerPallet = 10) {
  const m = minter(fileCode);
  const cases = Math.ceil(items / perCase);
  const pallets = Math.ceil(cases / casesPerPallet);
  const tick = clock(2 * items + cases + pallets);
  const serials = Array.from({ length: items }, m.serial);
  const caseIds = Array.from({ length: cases }, m.sscc);
  const palletIds = Array.from({ length: pallets }, m.sscc);
  const rows = [
    ...serials.map((s) => commission(m, tick(), s)),
    ...serials.map((s, i) => aggItem(tick(), s, caseIds[Math.floor(i / perCase)])),
    ...caseIds.map((c, i) => aggCase(tick(), c, palletIds[Math.floor(i / casesPerPallet)])),
    ...palletIds.map((p, i) => ship(tick(), p, `INV-${RUN}${fileCode}-P${String(i + 1).padStart(4, '0')}`)),
  ];
  return { rows, serials, caseIds, palletIds, lot: m.lot, epcs: items + cases + pallets };
}

const toCsv = (rows, header = HEADER) => [header, ...rows.map((r) => r.join(','))].join('\n') + '\n';

// Grows the item count until the file lands on the requested side of `limit`.
function sizedHierarchy(fileCode, limit, side) {
  const bytes = (n) => Buffer.byteLength(toCsv(hierarchy(fileCode, n).rows));
  const perItem = bytes(1000) / 1000;
  let n = Math.floor(limit / perItem);
  while (side === 'under' ? bytes(n) >= limit : bytes(n) <= limit) n += side === 'under' ? -50 : 50;
  return hierarchy(fileCode, n);
}

// --- build the pack -----------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const files = {};
const notes = [];
const write = (name, content) => {
  fs.writeFileSync(path.join(OUT, name), content);
  files[name] = content;
};

// 01 valid small: 80 items, 8 cases, 1 pallet, 1 shipment
const v = hierarchy('01', 80);
write('01_valid_small.csv', toCsv(v.rows));
notes.push(['01_valid_small.csv', `${v.rows.length} rows: 80 COMMISSIONING, 80 item AGGREGATION into 8 cases, 8 case AGGREGATION into 1 pallet, 1 SHIPPING of the pallet`,
  `All rows accepted. One async submission that ends Completed with ${v.rows.length} accepted, 0 rejected. Serials ${v.serials[0]} … ${v.serials.at(-1)}; cases ${v.caseIds[0]} … ${v.caseIds.at(-1)}; pallet ${v.palletIds[0]}; lot ${v.lot}.`]);

// 02 invalid rows: a fresh copy of the 26 cases in bulk_import_demo_NOTES.md
{
  const m = minter('02');
  const tick = clock(60);
  const s = Array.from({ length: 17 }, m.serial);
  const sscc = m.sscc();
  const neverUsed = m.sscc();
  const badCheck = sscc.slice(0, -1) + String((Number(sscc.at(-1)) + 1) % 10);
  const firstTs = tick();
  const future = `${Number(ymd.slice(0, 4)) + 1}-01-01T08:15:00`;
  const cases = [
    [commission(m, firstTs, s[0], { GTIN: GTIN.slice(0, -1) + String((Number(GTIN.at(-1)) + 1) % 10) }), s[0], `GTIN check digit is invalid (${GTIN.slice(0, -1)}${(Number(GTIN.at(-1)) + 1) % 10}, correct is ${GTIN})`],
    [commission(m, tick(), ''), '(empty)', 'Unit_ID (serial) is empty on a COMMISSIONING row'],
    [commission(m, tick(), s[2], { Event_Type: '' }), s[2], 'Event_Type is empty'],
    [commission(m, tick(), s[3], { Event_Type: 'COMISSIONING' }), s[3], 'Event_Type misspelled as COMISSIONING'],
    [commission(m, tick(), s[4], { Lot_Expiry_Date: `${ymd.slice(0, 4)}-01-01` }), s[4], `Lot_Expiry_Date ${ymd.slice(0, 4)}-01-01 is before Lot_Manufacturing_Date ${LOT_MFG}`],
    [commission(m, tick(), s[5], { Lot_Batch_Number: '' }), s[5], 'Lot_Batch_Number missing on a COMMISSIONING row'],
    [commission(m, tick(), s[6], { Event_Timestamp: `${ymd.slice(0, 4)}-13-45T99:00:00` }), s[6], 'Event_Timestamp is not a real date/time (month 13, hour 99)'],
    [commission(m, tick(), s[7], { Event_TimeZone_Offset: '+25:00' }), s[7], 'Event_TimeZone_Offset out of range (+25:00)'],
    [commission(m, tick(), s[8], { Event_Timestamp: `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)} 08:15` }), s[8], 'Event_Timestamp in the wrong format (DD/MM/YYYY HH:MM)'],
    [commission(m, tick(), s[9]), s[9], `Duplicate serial ${s[9]}, commissioned twice (occurrence 1 of 2)`],
    [commission(m, tick(), s[9]), s[9], `Duplicate serial ${s[9]}, commissioned twice (occurrence 2 of 2)`],
    [commission(m, tick(), s[10], { GTIN: '' }), s[10], 'GTIN is empty on an SGTIN COMMISSIONING row'],
    [commission(m, tick(), sscc), sscc, 'Identifier_Type is SGTIN but Unit_ID is an 18-digit SSCC'],
    [commission(m, tick(), s[12], { Packaging_Level: 'Pallet' }), s[12], 'Packaging_Level "Pallet" is not a template value (Item / Case / Package)'],
    [commission(m, tick(), s[13], { BizLocation_GLN: GLN.slice(0, 7) }), s[13], `BizLocation_GLN is not 13 digits (${GLN.slice(0, 7)})`],
    [commission(m, tick(), s[14], { Lot_Expiry_Date: '2025-01-01' }), s[14], 'Lot_Expiry_Date already in the past (2025-01-01)'],
    [commission(m, tick(), s[15], { Event_Timestamp: future }), s[15], `Event_Timestamp is in the future (${future}); importer allows at most 5 minutes ahead`],
    [commission(m, tick(), s[16], { Lot_Manufacturing_Date: `${Number(ymd.slice(0, 4)) + 1}-06-01` }), s[16], `Lot_Manufacturing_Date is in the future (${Number(ymd.slice(0, 4)) + 1}-06-01)`],
    [aggItem(tick(), `Q${MMDD}${RUN}02999999`, sscc), `Q${MMDD}${RUN}02999999`, 'AGGREGATION of a serial that is never commissioned in this file'],
    [aggItem(tick(), s[0], ''), s[0], 'AGGREGATION with an empty Parent_ID'],
    [aggItem(tick(), s[5], badCheck), s[5], `AGGREGATION parent SSCC has an invalid check digit (${badCheck})`],
    [aggItem(nairobi(now.getTime() - 2 * 86400_000), s[2], sscc), s[2], 'AGGREGATION timestamp is two days before the item was commissioned'],
    [aggCase(tick(), sscc, sscc), sscc, 'AGGREGATION where Unit_ID equals Parent_ID (self-aggregation)'],
    [ship(tick(), sscc, `INV-${RUN}02-NEG`, { Receiver_Owner_GLN: '', Receiver_Custodian_GLN: '', LSP_GLN: '', LSP_Name: '' }), sscc, 'SHIPPING row with no Receiver_Owner_GLN and no Receiver_Custodian_GLN'],
    [ship(tick(), neverUsed, `INV-${RUN}02-NEG`), neverUsed, 'SHIPPING of an SSCC that was never commissioned or aggregated'],
    [ship(tick(), sscc, `INV-${RUN}02-NEG`, { Transaction_Type: 'invoice_xyz' }), sscc, 'SHIPPING with an unrecognised Transaction_Type ("invoice_xyz")'],
  ];
  write('02_invalid_rows.csv', toCsv(cases.map((c) => c[0])));
  notes.push(['02_invalid_rows.csv', `${cases.length} rows, every one deliberately broken`,
    'Every row rejected with its own line-numbered error; nothing imported. Line-by-line table below.']);
  notes.invalidTable = cases.map((c, i) => `| ${i + 2} | ${c[1]} | ${c[2]} |`);
}

// 03 mixed partial: 10 items + 10 aggregations into one case, with 5 broken rows mixed in
{
  const m = minter('03');
  const tick = clock(40);
  const sscc = m.sscc();
  const serials = Array.from({ length: 10 }, m.serial);
  const good = [
    ...serials.map((s) => commission(m, tick(), s)),
    ...serials.map((s) => aggItem(tick(), s, sscc)),
  ];
  const bad = [
    [commission(m, tick(), m.serial(), { GTIN: GTIN.slice(0, -1) + String((Number(GTIN.at(-1)) + 1) % 10) }), 'GTIN check digit invalid'],
    [commission(m, tick(), ''), 'Unit_ID empty'],
    [commission(m, tick(), m.serial(), { Event_Timestamp: `${Number(ymd.slice(0, 4)) + 1}-01-01T08:00:00` }), 'Event_Timestamp in the future'],
    [commission(m, tick(), m.serial(), { Event_TimeZone_Offset: '+25:00' }), 'Event_TimeZone_Offset +25:00'],
    [commission(m, tick(), m.serial(), { BizLocation_GLN: GLN.slice(0, 7) }), 'BizLocation_GLN only 7 digits'],
  ];
  // Broken rows land after data rows 3, 7, 11, 15 and 19 of the good set.
  const rows = [];
  const badLines = [];
  good.forEach((r, i) => {
    rows.push(r);
    if ([2, 6, 10, 14, 18].includes(i)) {
      const [b, why] = bad[badLines.length];
      rows.push(b);
      badLines.push(`line ${rows.length + 1} (${why})`);
    }
  });
  write('03_mixed_partial.csv', toCsv(rows));
  notes.push(['03_mixed_partial.csv', `${rows.length} rows: 20 valid (10 COMMISSIONING + 10 AGGREGATION into case ${sscc}) and 5 broken`,
    `Expected PARTIALLY_ACCEPTED: 20 accepted, 5 rejected at ${badLines.join(', ')}. If the whole file is rejected instead, record that; it tells us whether the import is all-or-nothing.`]);
}

write('04_empty.csv', '');
notes.push(['04_empty.csv', '0 bytes', 'Clean validation error. No async submission is created.']);

write('05_header_only.csv', HEADER + '\n');
notes.push(['05_header_only.csv', 'Header row only', 'Clean "no data rows" error. No async submission is created.']);

{
  const m = minter('06');
  const tick = clock(12);
  const sscc = m.sscc();
  const serials = Array.from({ length: 5 }, m.serial);
  const rows = [...serials.map((s) => commission(m, tick(), s)), ...serials.map((s) => aggItem(tick(), s, sscc))];
  write('06_bom_utf8.csv', '﻿' + toCsv(rows));
  notes.push(['06_bom_utf8.csv', '10 valid rows; file starts with a UTF-8 BOM (EF BB BF)',
    'All 10 accepted. If it fails with "Event_Type missing" or "unknown column", the BOM is not stripped from the header (a finding).']);
}

{
  const m = minter('07');
  const tick = clock(12);
  const rows = Array.from({ length: 10 }, () => commission(m, tick(), m.serial()).join(','));
  rows[4] += ',EXTRA';
  write('07_wrong_column_count.csv', [HEADER, ...rows].join('\n') + '\n');
  notes.push(['07_wrong_column_count.csv', '10 COMMISSIONING rows; line 6 has 28 fields instead of 27',
    'Only line 6 rejected; 9 accepted. A whole-file parse abort hides every other row (a finding).']);
}

{
  const m = minter('08');
  const tick = clock(12);
  const swap = (arr) => {
    const a = [...arr];
    [a[col.Lot_Manufacturing_Date], a[col.Lot_Expiry_Date]] = [a[col.Lot_Expiry_Date], a[col.Lot_Manufacturing_Date]];
    return a;
  };
  const header = swap(COLS).join(',');
  const rows = Array.from({ length: 10 }, () => swap(commission(m, tick(), m.serial())));
  write('08_reordered_header.csv', toCsv(rows, header));
  notes.push(['08_reordered_header.csv', '10 COMMISSIONING rows; Lot_Manufacturing_Date and Lot_Expiry_Date columns swapped in BOTH header and data',
    `Mapped by name: all 10 accepted with expiry ${LOT_EXP}. Clear header-order error: acceptable. Rejected as "expiry before manufacture" or stored with expiry ${LOT_MFG}: the importer maps by position and ignores the header (a finding).`]);
}

write('09_valid_small_REUPLOAD.csv', files['01_valid_small.csv']);
notes.push(['09_valid_small_REUPLOAD.csv', 'Byte-identical copy of 01. Upload only AFTER 01 has finished processing',
  `All ${v.rows.length} rows rejected or flagged as duplicates, so the duplicate check works across imports, not just within one file. Accepted again = a finding.`]);

const itemsFor = (rows) => Math.round(rows / 2.11);
const big = hierarchy('10', itemsFor(LARGE_ROWS));
write('10_large_5k.csv', toCsv(big.rows));
notes.push(['10_large_5k.csv', `${big.rows.length} rows, ${big.epcs} EPCs (same hierarchy as 01, scaled up)`,
  'All accepted. Record upload-to-Completed time on the Async submissions page; the portal stays usable while it processes.']);

const under = sizedHierarchy('11', UNDER_BYTES, 'under');
write('11_large_under_10MB.csv', toCsv(under.rows));
const over = sizedHierarchy('12', OVER_BYTES, 'over');
write('12_large_over_10MB.csv', toCsv(over.rows));

// --- self-check ---------------------------------------------------------------------------------
const problems = [];
const sizeOf = (n) => Buffer.byteLength(files[n]);
for (const [name, content] of Object.entries(files)) {
  if (['04_empty.csv', '07_wrong_column_count.csv'].includes(name)) continue;
  const lines = content.replace(/^﻿/, '').trimEnd().split('\n');
  lines.forEach((l, i) => {
    if (l.split(',').length !== 27) problems.push(`${name} line ${i + 1}: ${l.split(',').length} columns`);
  });
}
const validNames = ['01_valid_small.csv', '03_mixed_partial.csv', '06_bom_utf8.csv', '07_wrong_column_count.csv',
  '08_reordered_header.csv', '10_large_5k.csv', '11_large_under_10MB.csv', '12_large_over_10MB.csv'];
const seen = new Map();
const nowLocal = nairobi(now.getTime());
for (const name of validNames) {
  const lines = files[name].replace(/^﻿/, '').trimEnd().split('\n').slice(1);
  for (const [i, l] of lines.entries()) {
    const f = l.split(',');
    if (name === '03_mixed_partial.csv' && (!f[col.Unit_ID] || f[col.Event_TimeZone_Offset] !== '+03:00' ||
      f[col.BizLocation_GLN] !== GLN || f[col.Event_Timestamp] > nowLocal || (f[col.GTIN] && f[col.GTIN] !== GTIN))) continue;
    if (f[col.Event_Timestamp] > nowLocal) problems.push(`${name} line ${i + 2}: future timestamp`);
    for (const c of ['BizLocation_GLN', 'Sender_Owner_GLN', 'Sender_Custodian_GLN', 'Receiver_Owner_GLN', 'Receiver_Custodian_GLN', 'LSP_GLN']) {
      if (/^\d{13}$/.test(f[col[c]]) && !validGs1(f[col[c]])) problems.push(`${name} line ${i + 2}: bad ${c} check digit ${f[col[c]]}`);
    }
    for (const id of [f[col.Unit_ID], f[col.Parent_ID]]) {
      if (/^\d{18}$/.test(id) && !validGs1(id)) problems.push(`${name} line ${i + 2}: bad SSCC check digit ${id}`);
    }
    if (f[col.Event_Type] === 'COMMISSIONING') {
      const key = f[col.Unit_ID];
      if (seen.has(key)) problems.push(`serial ${key} in ${name} also in ${seen.get(key)}`);
      seen.set(key, name);
    }
  }
}
if (!validGs1(GTIN)) problems.push(`GTIN ${GTIN} has a bad check digit`);
if (sizeOf('11_large_under_10MB.csv') >= UNDER_BYTES) problems.push('11 is not under the limit');
if (sizeOf('12_large_over_10MB.csv') <= OVER_BYTES) problems.push('12 is not over the limit');
for (const [n, h] of [['11', under], ['12', over]]) {
  if (h.epcs >= SERIAL_LIMIT) problems.push(`${n} has ${h.epcs} EPCs, which also breaches the 50,000 serial limit`);
}

const mb = (n) => (sizeOf(n) / 1_000_000).toFixed(2);
notes.push(['11_large_under_10MB.csv', `${under.rows.length} rows, ${under.epcs} EPCs, ${sizeOf('11_large_under_10MB.csv').toLocaleString()} bytes (${mb('11_large_under_10MB.csv')} MB)`,
  'Below 10 MB under both the decimal and the binary reading. Accepted and processed async. Record time to Completed. Rejected for size = the limit is lower than §6.1.1 documents (a finding).']);
notes.push(['12_large_over_10MB.csv', `${over.rows.length} rows, ${over.epcs} EPCs, ${sizeOf('12_large_over_10MB.csv').toLocaleString()} bytes (${mb('12_large_over_10MB.csv')} MB)`,
  'Above 10 MB under both readings, and still under 50,000 EPCs, so only the size rule applies. Expected: a clear MESSAGE_SIZE_EXCEEDED / 413 or portal size error. A timeout, a silent partial import, or full acceptance is a finding.']);

const md = `# Bulk CSV + async submission test pack (${ymd})

Generated by \`qa-testing-suite/scripts/csv/make-bulk-csv.mjs\` for **tnt-demo**, Manufacturer portal >
Production > Batches > **Bulk CSV**. Re-run the script for a clean pack; every run mints new serials.

| | |
|---|---|
| Run code | \`${RUN}\` (serials start \`Q${MMDD}${RUN}\`) |
| GTIN | ${GTIN} |
| BizLocation GLN | ${GLN} |
| Lot dates | made ${LOT_MFG}, expires ${LOT_EXP} |
| Permit | ${PERMIT} |
| Timestamps | Nairobi time (+03:00), one second apart, ending 1 h before ${nowLocal} |

Line numbers match a text editor: line 1 is the header, so the first data row is line 2.

## Files, in upload order

| File | Contents | Expected |
|---|---|---|
${notes.map(([f, c, e]) => `| \`${f}\` | ${c} | ${e} |`).join('\n')}

## 02_invalid_rows.csv, line by line

| CSV line | Unit_ID | Expected failure |
|---|---|---|
${notes.invalidTable.join('\n')}

## What to check on every upload (Async submissions page)

1. The upload returns straight away with a submission or reference ID, and the UI does not block.
2. The status moves through its states (queued, processing, completed or failed). Note the timestamps of each.
3. Rows in the file = accepted + rejected. Rejections carry the CSV line number and match this file.
4. Warnings (UNKNOWN_SGLN, INVALID_LOT, ...) appear per row and are not dropped.
5. For 01: spot-check 3 serials in the serial and event views (commissioned, then packed, then shipped) and the pallet → case → item hierarchy.
6. Upload 01-style (after the first pass) and 10 at the same time: the two submissions keep separate statuses and counts.

Known caveat: on tnt-demo, serial lookup for 13-digit-GTIN products can return UNKNOWN_SGTIN (an existing bug).
If 01's serials show that in lookup but the import itself completed, log it against that bug, not the CSV import.
`;
fs.writeFileSync(path.join(OUT, 'NOTES.md'), md);

console.log(`Wrote ${Object.keys(files).length} CSVs + NOTES.md to ${OUT}  (run ${RUN})`);
for (const n of Object.keys(files)) {
  const lines = files[n] ? files[n].trimEnd().split('\n').length - 1 : 0;
  console.log(`  ${n.padEnd(30)} ${String(lines).padStart(6)} rows  ${String(sizeOf(n).toLocaleString()).padStart(12)} bytes`);
}
if (problems.length) {
  console.error(`\nSELF-CHECK FAILED (${problems.length}):\n  ${problems.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
console.log('\nSelf-check passed: 27 columns, unique serials, valid SSCC check digits, no future timestamps, size boundaries hold.');
