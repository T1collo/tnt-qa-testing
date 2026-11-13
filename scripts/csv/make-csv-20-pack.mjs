// Generates the 20-test CSV pack for the L4 CSV upload vs L5 rules ticket (Manufacturer >
// Batches > Bulk CSV). Each file packs one theme with one problem per row, so 20 uploads cover
// the rules. File names start with the test number used in the Jira comment (CSV-01 ... CSV-19).
//
// Values follow the portal's own template on tnt-demo: Test Manufacturer GLN 6164003000000,
// Telmicos GTIN 6161102974997, origin DOMESTIC/KE. The importer validates the whole file and
// imports nothing if any row fails, and a package can only be shipped in the file that built it,
// so every journey (commission > case > package > ship) sits inside one file.
//
// Run:  node scripts/csv/make-csv-20-pack.mjs [--out <dir>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => {
    if (a.startsWith('--')) pairs.push([a.slice(2), all[i + 1]]);
    return pairs;
  }, [])
);
const OUT = args.out || 'C:\\Users\\Collins\\Desktop\\uploads\\csv-20';

const COLS = ['Event_Type', 'Identifier_Type', 'GTIN', 'Unit_ID', 'Parent_ID', 'Packaging_Level', 'Event_Timestamp',
  'Event_TimeZone_Offset', 'BizLocation_GLN', 'Lot_Batch_Number', 'Lot_Manufacturing_Date', 'Lot_Expiry_Date',
  'Manufacturing_Origin', 'Country_of_Origin', 'Import_Sales_Permit_Ref', 'Sender_Owner_GLN', 'Sender_Owner_Name',
  'Sender_Custodian_GLN', 'Sender_Location_Name', 'Receiver_Owner_GLN', 'Receiver_Owner_Name', 'Receiver_Custodian_GLN',
  'Receiver_Location_Name', 'LSP_GLN', 'LSP_Name', 'Transaction_Type', 'Transaction_Reference'];
const HEADER = COLS.join(',');
const col = Object.fromEntries(COLS.map((c, i) => [c, i]));

const GTIN = '6161102974997';
const GLN = '6164003000000';
const OTHER_GTIN = '04057598013642'; // Xarelto, another manufacturer's product
const KEMSA_GLN = '0614142000011';
const LSP_GLN = '0614143000010';

const now = new Date();
const ymd = now.toISOString().slice(0, 10);
const YEAR = Number(ymd.slice(0, 4));
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RUN = Array.from(crypto.randomBytes(3), (b) => ALNUM[b % ALNUM.length]).join('');
const SSCC_RUN = String(crypto.randomInt(10, 100));
const LOT_MFG = `${ymd.slice(0, 8)}01`;
const LOT_EXP = `${YEAR + 2}-${ymd.slice(5, 7)}-01`;
const dayOffset = (d) => new Date(now.getTime() + d * 86400_000).toISOString().slice(0, 10);

function checkDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}
const gs1 = (body) => body + checkDigit(body);
const breakCheck = (code) => code.slice(0, -1) + String((Number(code.at(-1)) + 1) % 10);
const UNKNOWN_GTIN = gs1('616199999999');
const UNKNOWN_GLN = gs1('999999900000');
const SECOND_GLN = gs1('616400300001');

// Nairobi local time, one minute per row, ending an hour before now.
const nairobi = (ms) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 19);
let clockMs;
const tick = () => nairobi((clockMs += 60_000));

const quote = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const line = (r) => r.map(quote).join(',');

function file(no) {
  const code = String(no).padStart(2, '0');
  let s = 0;
  let c = 0;
  clockMs = now.getTime() - 20 * 3600_000 + no * 45 * 60_000; // later tests come later in time
  const f = {
    rows: [],
    lot: `L${RUN}${code}A`,
    serial: () => `S${RUN}${code}${String(++s).padStart(5, '0')}`,
    sscc: () => gs1(`06164003${SSCC_RUN}${code}${String(++c).padStart(5, '0')}`),
    add(fields) {
      const r = new Array(COLS.length).fill('');
      for (const [k, v] of Object.entries(fields)) {
        if (!(k in col)) throw new Error(`unknown column ${k}`);
        r[col[k]] = v;
      }
      f.rows.push(r);
      return f.rows.length + 1; // CSV line number
    },
    commission(serial = f.serial(), extra = {}) {
      f.add({
        Event_Type: 'COMMISSIONING', Identifier_Type: 'SGTIN', GTIN, Unit_ID: serial, Packaging_Level: 'Item',
        Event_Timestamp: tick(), Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN, Lot_Batch_Number: f.lot,
        Lot_Manufacturing_Date: LOT_MFG, Lot_Expiry_Date: LOT_EXP, Manufacturing_Origin: 'DOMESTIC', Country_of_Origin: 'KE', ...extra,
      });
      return serial;
    },
    pack(serial, kase, extra = {}) {
      f.add({
        Event_Type: 'AGGREGATION', Identifier_Type: 'SGTIN', GTIN, Unit_ID: serial, Parent_ID: kase, Packaging_Level: 'Item',
        Event_Timestamp: tick(), Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN, ...extra,
      });
    },
    box(kase, pkg, extra = {}) {
      f.add({
        Event_Type: 'AGGREGATION', Identifier_Type: 'SSCC', Unit_ID: kase, Parent_ID: pkg, Packaging_Level: 'Case',
        Event_Timestamp: tick(), Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN, ...extra,
      });
    },
    ship(pkg, extra = {}) {
      f.add({
        Event_Type: 'SHIPPING', Identifier_Type: 'SSCC', Unit_ID: pkg, Packaging_Level: 'Package',
        Event_Timestamp: tick(), Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN,
        Sender_Owner_GLN: GLN, Sender_Owner_Name: 'Test Manufacturer', Sender_Custodian_GLN: GLN, Sender_Location_Name: 'Test Manufacturer Plant',
        Receiver_Owner_GLN: KEMSA_GLN, Receiver_Owner_Name: 'KEMSA', Receiver_Custodian_GLN: KEMSA_GLN, Receiver_Location_Name: 'KEMSA Embakasi Warehouse',
        LSP_GLN, LSP_Name: 'DHL Supply Chain Kenya', Transaction_Type: 'desadv', Transaction_Reference: `INV-${RUN}${code}-${f.rows.length + 1}`, ...extra,
      });
    },
    // items > one case > one package; returns the SSCCs and serials
    package(items = 2, extra = {}) {
      const kase = f.sscc();
      const pkg = f.sscc();
      const serials = Array.from({ length: items }, () => f.commission(f.serial(), extra));
      serials.forEach((sn) => f.pack(sn, kase));
      f.box(kase, pkg);
      return { kase, pkg, serials };
    },
  };
  return f;
}

const files = [];
const out = (name, f, raw) => files.push({ name, content: raw ?? `${[HEADER, ...f.rows.map(line)].join('\n')}\n` });
const kept = {};

// 1 Valid full journey: 2 lots, items > 2 cases > 1 package > shipped
{
  const f = file(1);
  const kA = f.sscc();
  const kB = f.sscc();
  const pkg = f.sscc();
  const a = [f.commission(), f.commission(), f.commission()];
  const b = Array.from({ length: 3 }, () => f.commission(f.serial(), { Lot_Batch_Number: `L${RUN}01B` }));
  a.forEach((sn) => f.pack(sn, kA));
  b.forEach((sn) => f.pack(sn, kB));
  f.box(kA, pkg);
  f.box(kB, pkg);
  f.ship(pkg);
  kept.t1 = { serial: a[0], kase: kA, pkg };
  out('CSV-01_valid_full_journey.csv', f);
  out('CSV-07_reupload_of_CSV-01.csv', f);
}

// 2 Commissioning errors, one per row after a valid first row
{
  const f = file(2);
  f.commission();
  const bad = [
    { Lot_Batch_Number: '' }, { Lot_Expiry_Date: '' }, { Lot_Expiry_Date: `01/06/${YEAR + 2}` }, { Lot_Expiry_Date: `${YEAR + 2}-02-30` },
    { Manufacturing_Origin: 'IMPORT', Country_of_Origin: '', Import_Sales_Permit_Ref: 'PPB/IMP/QA/001' },
    { Manufacturing_Origin: 'IMPORT', Country_of_Origin: 'DE', Import_Sales_Permit_Ref: 'PPB/IMP/QA/002', Sender_Owner_GLN: '' },
    { BizLocation_GLN: '' }, { GTIN: breakCheck(GTIN) }, { GTIN: GTIN.slice(0, 11) }, { GTIN: '' },
    { Unit_ID: '' }, { Unit_ID: `S${RUN}02`.padEnd(21, 'X') }, { Unit_ID: `S#${RUN}02` },
    { Lot_Batch_Number: `L${RUN}02`.padEnd(21, 'X') }, { Lot_Batch_Number: `L#${RUN}02` },
    { Event_Type: '' }, { Event_Type: 'COMISSIONING' }, { Event_Type: 'commissioning' },
    { Event_Timestamp: `${YEAR + 1}-01-01T08:00:00` }, { Event_Timestamp: `01/06/${YEAR} 08:00` },
    { Event_TimeZone_Offset: '+0300' }, { Event_TimeZone_Offset: '' },
    { BizLocation_GLN: breakCheck(GLN) }, { BizLocation_GLN: GLN.slice(0, 7) },
  ];
  for (const extra of bad) f.commission(f.serial(), extra);
  out('CSV-02_commissioning_errors.csv', f);
}

// 3 Commissioning values the guide flags (accepted with a warning)
{
  const f = file(3);
  f.commission(f.serial(), { Lot_Expiry_Date: '2025-01-01', Lot_Batch_Number: `L${RUN}03P` });
  f.commission(f.serial(), { Lot_Expiry_Date: dayOffset(30), Lot_Batch_Number: `L${RUN}03S` });
  f.commission(f.serial(), { Event_Timestamp: nairobi(now.getTime() - 10 * 86400_000) });
  f.commission(f.serial(), { GTIN: UNKNOWN_GTIN });
  f.commission(f.serial(), { BizLocation_GLN: UNKNOWN_GLN });
  out('CSV-03_commissioning_flags.csv', f);
}

// 4 Values that must not be blocked: columns L5 has no field for, and GS1 boundary values
{
  const f = file(4);
  f.commission(f.serial(), { Manufacturing_Origin: 'IMPORT', Country_of_Origin: 'DE', Import_Sales_Permit_Ref: '' });
  f.commission(f.serial(), { Manufacturing_Origin: 'SPACE' });
  f.commission(f.serial(), { Manufacturing_Origin: '' });
  f.commission(f.serial(), { Packaging_Level: 'Pallet' });
  f.commission(f.serial(), { Lot_Manufacturing_Date: `${YEAR + 1}-06-01`, Lot_Batch_Number: `L${RUN}04F` });
  f.commission(gs1(`06164003${SSCC_RUN}0499999`));
  f.commission(`S${RUN}04`.padEnd(20, 'A'), { Lot_Batch_Number: `L${RUN}04`.padEnd(20, 'B') });
  for (const ch of ['-', '_', '.', '/']) f.commission(`S${RUN}04${ch}${ch.charCodeAt(0)}`);
  f.commission(f.serial(), { GTIN: GTIN.padStart(14, '0') });
  f.commission(f.serial(), { Event_TimeZone_Offset: '-05:00' });
  out('CSV-04_values_that_must_pass.csv', f);
}

// 5 Packing errors, one per row, after valid commissioning
{
  const f = file(5);
  const items = Array.from({ length: 8 }, () => f.commission());
  const k1 = f.sscc();
  const k2 = f.sscc();
  const p1 = f.sscc();
  const p2 = f.sscc();
  f.pack(items[0], k1);
  f.pack(f.serial(), k1); // never commissioned
  f.box(k1, p1);
  f.box(p1, k1); // cyclic
  f.box(k2, k2); // own parent
  f.box(p1, p2); // fourth level
  f.add({ Event_Type: 'AGGREGATION', Identifier_Type: 'SSCC', GTIN, Unit_ID: f.sscc(), Parent_ID: items[1], Packaging_Level: 'Case', Event_Timestamp: tick(), Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN }); // SSCC under an item
  f.pack(items[2], k1, { BizLocation_GLN: SECOND_GLN }); // different location
  f.pack(items[3], k1, { Event_Timestamp: nairobi(now.getTime() - 3 * 86400_000) }); // before commissioning
  f.box(f.sscc(), p2); // empty case
  f.pack(items[4], ''); // parent blank
  f.pack(items[5], breakCheck(f.sscc())); // parent check digit
  f.pack(items[6], f.sscc().slice(0, 17)); // 17 digits
  f.pack(items[7], `${f.sscc()}0`); // 19 digits
  f.pack(items[7], 'CASE-MAN001-1'); // portal label
  f.pack(items[6], k1, { GTIN: OTHER_GTIN }); // wrong GTIN on the child
  out('CSV-05_packing_errors.csv', f);
}

// 6 Duplicates
{
  const f = file(6);
  const s1 = f.commission();
  f.commission(s1); // commissioned twice
  const s2 = f.commission();
  const s3 = f.commission();
  const k1 = f.sscc();
  const k2 = f.sscc();
  f.pack(s2, k1);
  f.pack(s2, k2); // child packed twice
  f.box(k1, f.sscc());
  f.box(k1, f.sscc()); // case boxed twice
  f.pack(s3, k2);
  f.rows.push([...f.rows.at(-1)]); // same item twice in one event (identical row)
  f.commission(kept.t1.serial); // a CSV-01 serial again
  out('CSV-06_duplicates.csv', f);
}

// 8 Valid shipping variants
{
  const f = file(8);
  const a = f.package();
  const b = f.package();
  const c = f.package();
  const ref = `INV-${RUN}08-SHARED`;
  f.ship(a.pkg, { Transaction_Reference: ref, Sender_Custodian_GLN: LSP_GLN, Receiver_Custodian_GLN: gs1('061414200002') });
  f.ship(b.pkg, { Transaction_Reference: ref });
  f.ship(c.pkg, { Receiver_Custodian_GLN: '', Sender_Location_Name: '', Receiver_Location_Name: '', LSP_GLN: '', LSP_Name: '' });
  kept.t8 = a;
  out('CSV-08_valid_shipping.csv', f);
}

// 9 Shipping errors, each on its own package built in the same file
{
  const f = file(9);
  const p = Array.from({ length: 8 }, () => f.package(1));
  f.ship(p[0].pkg, { Transaction_Type: '', Transaction_Reference: '' });
  f.ship(p[1].pkg, { Transaction_Reference: '' });
  f.ship(p[2].pkg, { Sender_Owner_GLN: '', Sender_Owner_Name: '', Sender_Custodian_GLN: '' });
  f.ship(p[3].pkg, { Receiver_Owner_GLN: '', Receiver_Owner_Name: '', Receiver_Custodian_GLN: '' });
  f.ship(p[4].pkg, { Receiver_Owner_GLN: UNKNOWN_GLN, Receiver_Custodian_GLN: UNKNOWN_GLN });
  f.ship(p[5].pkg, { Receiver_Owner_GLN: '0614142000013', Receiver_Custodian_GLN: '0614142000013' });
  f.ship(p[6].pkg, { Transaction_Type: 'invoice_xyz' });
  f.ship(f.sscc()); // unknown SSCC
  f.ship(breakCheck(p[7].pkg)); // SSCC check digit
  f.ship(p[7].pkg, { Event_Timestamp: nairobi(now.getTime() - 3 * 86400_000) }); // before packing
  out('CSV-09_shipping_errors.csv', f);
}

// 10 After shipping: act on the CSV-08 package from another file
{
  const f = file(10);
  f.ship(kept.t8.pkg); // ship again
  const newCase = f.sscc();
  const sn = f.commission();
  f.pack(sn, newCase);
  f.box(newCase, kept.t8.pkg); // add a case to the shipped package
  f.pack(kept.t8.serials[0], f.sscc()); // repack an item in transit
  out('CSV-10_after_shipping.csv', f);
}

// 11 Destroyed items: 11a commissions them, the portal destroys them, 11b packs them
{
  const f = file(11);
  kept.t11 = [f.commission(), f.commission()];
  out('CSV-11a_commission_for_destruction.csv', f);
  const g = file(11);
  g.rows = [];
  const kase = g.sscc();
  kept.t11.forEach((sn) => g.pack(sn, kase));
  out('CSV-11b_pack_destroyed_items.csv', g);
}

// 12 Partial failure and resubmission: 100 rows, row 51 (line 52) bad, then fixed
{
  const f = file(12);
  for (let i = 0; i < 100; i++) f.commission(f.serial(), i === 50 ? { Event_Timestamp: `${YEAR + 1}-01-01T08:00:00` } : {});
  out('CSV-12a_100_rows_one_bad.csv', f);
  f.rows[50][col.Event_Timestamp] = nairobi(Date.parse(`${f.rows[49][col.Event_Timestamp]}+03:00`) + 30_000);
  out('CSV-12b_100_rows_fixed.csv', f);
}

// 13 Identity: another partner's GLN, another manufacturer's GTIN, a PPB inspection row
{
  const f = file(13);
  f.commission();
  f.commission(f.serial(), { BizLocation_GLN: KEMSA_GLN });
  f.commission(f.serial(), { GTIN: OTHER_GTIN });
  const { pkg } = f.package(1);
  f.add({ Event_Type: 'INSPECTING', Identifier_Type: 'SSCC', Unit_ID: pkg, Packaging_Level: 'Package', Event_Timestamp: tick(), Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN });
  out('CSV-13_identity.csv', f);
  const g = file(13);
  g.lot = `L${RUN}13V`;
  g.serial = (() => { let n = 0; return () => `V${RUN}13${String(++n).padStart(5, '0')}`; })();
  g.commission();
  g.commission();
  out('CSV-13_valid_for_session_checks.csv', g);
}

// 14 Batch loophole: blank and placeholder serials
{
  const f = file(14);
  f.commission('');
  f.commission('');
  for (const sn of ['0', 'NA', 'DUMMY']) f.commission(sn, { Lot_Batch_Number: `L${RUN}14${sn.slice(0, 2)}` });
  out('CSV-14_batch_loophole.csv', f);
}

// 15 Excel-saved file: a valid journey as Excel rewrites it
{
  const f = file(15);
  const { pkg } = f.package(2);
  f.ship(pkg);
  const sci = (n) => Number(n).toExponential(4).replace(/\.?0+e/, 'e').replace('e+', 'E+');
  const dmy = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : d);
  for (const r of f.rows) {
    if (r[col.GTIN]) r[col.GTIN] = sci(r[col.GTIN]);
    for (const c of ['BizLocation_GLN', 'Receiver_Owner_GLN', 'Receiver_Custodian_GLN', 'LSP_GLN']) r[col[c]] = r[col[c]].replace(/^0/, '');
    for (const c of ['Unit_ID', 'Parent_ID']) if (/^\d{18}$/.test(r[col[c]])) r[col[c]] = sci(r[col[c]]);
    r[col.Lot_Manufacturing_Date] = dmy(r[col.Lot_Manufacturing_Date]);
    r[col.Lot_Expiry_Date] = dmy(r[col.Lot_Expiry_Date]);
  }
  out('CSV-15_excel_saved.csv', f);
}

// 16 Broken rows: 28 fields, 26 fields, blank lines, a quoted comma
{
  const f = file(16);
  f.commission();
  f.commission();
  f.commission();
  f.commission(f.serial(), { Manufacturing_Origin: 'IMPORT', Country_of_Origin: 'Korea, Republic of', Import_Sales_Permit_Ref: 'PPB/IMP/QA/016' });
  const l = f.rows.map(line);
  out('CSV-16_broken_rows.csv', null, `${HEADER}\n${l[0]}\n${l[1]},EXTRA\n\n${l[2].replace(/,[^,]*$/, '')}\n${l[3]}\n\n`);
}

// 17 and 18: row and serial limits (portal: 500 rows, 2 MB; guide: 50,000 serials, 10 MB)
for (const [name, n] of [['CSV-17a_500_rows.csv', 500], ['CSV-17b_50000_serials.csv', 50000], ['CSV-18a_501_rows.csv', 501], ['CSV-18b_50001_serials.csv', 50001]]) {
  const f = file(name.startsWith('CSV-17') ? 17 : 18);
  f.lot = `L${RUN}${name.slice(4, 7).replace('_', '')}`;
  const ts = tick();
  let k = 0;
  f.serial = () => `S${RUN}${name.slice(4, 7).replace('_', '')}${String(++k).padStart(6, '0')}`;
  for (let i = 0; i < n; i++) f.add({
    Event_Type: 'COMMISSIONING', Identifier_Type: 'SGTIN', GTIN, Unit_ID: f.serial(), Packaging_Level: 'Item', Event_Timestamp: ts,
    Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN, Lot_Batch_Number: f.lot, Lot_Manufacturing_Date: LOT_MFG,
    Lot_Expiry_Date: LOT_EXP, Manufacturing_Origin: 'DOMESTIC', Country_of_Origin: 'KE',
  });
  out(name, f);
}

// 19 Injection
{
  const f = file(19);
  for (const v of ['=1+1', '+1+1', '@SUM(1)', '=HYPERLINK("http://example.com")', '<img src=x onerror=alert(1)>']) {
    f.commission(f.serial(), { Manufacturing_Origin: 'IMPORT', Country_of_Origin: v, Import_Sales_Permit_Ref: 'PPB/IMP/QA/019' });
  }
  out('CSV-19_injection.csv', f);
}

// 20d: two small valid files for the simultaneous-upload check
for (const part of ['1', '2']) {
  const f = file(20);
  f.lot = `L${RUN}20${part}`;
  let k = 0;
  f.serial = () => `S${RUN}20${part}${String(++k).padStart(4, '0')}`;
  for (let i = 0; i < 5; i++) f.commission();
  out(`CSV-20d-${part}_simultaneous_upload.csv`, f);
}

fs.mkdirSync(OUT, { recursive: true });
for (const n of fs.readdirSync(OUT).filter((x) => x.startsWith('CSV-'))) fs.unlinkSync(path.join(OUT, n));
for (const { name, content } of files) fs.writeFileSync(path.join(OUT, name), content);
console.log(`Wrote ${files.length} files to ${OUT} (run ${RUN})`);
for (const { name, content } of files) console.log(`  ${name.padEnd(42)} ${String(content.split('\n').filter(Boolean).length - 1).padStart(6)} rows ${String(Buffer.byteLength(content)).padStart(10)} bytes`);
