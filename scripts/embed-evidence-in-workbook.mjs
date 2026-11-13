// Embeds the Newman evidence screenshots into the error-code workbook.
//
// Excel caps row height at 409pt (~546px), so a legible request card cannot fit inside a
// single case row. Instead each screenshot goes on a dedicated "Evidence" sheet where it
// can span as many rows as it needs, and every case row on Sheet1 gets an internal
// hyperlink jumping straight to its block.
//
// Run after capture-newman-evidence.mjs:  node scripts/embed-evidence-in-workbook.mjs
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const BOOK = path.join(ROOT, 'docs', 'Sheet1_Error_Code_Tests_DocsVsSystem.xlsx');
const EVID = path.join(ROOT, 'reports', 'newman', 'evidence');

const manifest = JSON.parse(fs.readFileSync(path.join(EVID, 'manifest.json'), 'utf8'));
const byId = Object.fromEntries(manifest.map((m) => [m.id, m]));

const IMG_W = 950;             // rendered width on the Evidence sheet
const ROW_PX = 20;             // a default-height row is ~20px
const pngSize = (file) => {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(BOOK);
const sheet = wb.worksheets[0];

// rebuild the Evidence sheet from scratch so the script is re-runnable
const existing = wb.getWorksheet('Evidence');
if (existing) wb.removeWorksheet(existing.id);
const ev = wb.addWorksheet('Evidence');
ev.getColumn(1).width = 150;

const anchors = {};
let row = 1;

ev.getCell(`A${row}`).value = 'Newman evidence — TnT error-code conformance';
ev.getCell(`A${row}`).font = { bold: true, size: 16 };
row += 1;
ev.getCell(`A${row}`).value = `Captured ${new Date().toISOString().slice(0, 10)} against the live platform. Each image is the request card from the Newman HTML report (reports/newman/error-codes.html): request, response, and the assertions for that case.`;
ev.getCell(`A${row}`).font = { size: 11, color: { argb: 'FF555555' } };
row += 3;

const FILL = { pass: 'FFD9EAD3', fail: 'FFF4CCCC' };
let embedded = 0;
let missing = [];

for (const m of manifest) {
  const file = path.join(EVID, `${m.id}_compact.png`);
  if (!fs.existsSync(file)) { missing.push(m.id); continue; }

  anchors[m.id] = row;

  const head = ev.getCell(`A${row}`);
  head.value = `${m.id} — ${m.name.replace(/^TC-S1-\d{3} · /, '')}`;
  head.font = { bold: true, size: 13 };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: m.failed ? FILL.fail : FILL.pass } };
  ev.getRow(row).height = 22;
  row += 1;

  const link = ev.getCell(`A${row}`);
  link.value = { text: `full-resolution screenshot → ${m.id}.png`, hyperlink: `../reports/newman/evidence/${m.id}.png` };
  link.font = { color: { argb: 'FF0563C1' }, underline: true, size: 10 };
  row += 1;

  const { w, h } = pngSize(file);
  const drawH = Math.round((IMG_W / w) * h);
  const imageId = wb.addImage({ filename: file, extension: 'png' });
  ev.addImage(imageId, {
    tl: { col: 0, row: row - 1 },
    ext: { width: IMG_W, height: drawH },
  });

  row += Math.ceil(drawH / ROW_PX) + 3;
  embedded++;
}

// link every case row on Sheet1 to its evidence block
const COL = 16;
sheet.getCell(1, COL).value = 'Evidence (Newman)';
sheet.getCell(1, COL).font = { bold: true };
sheet.getColumn(COL).width = 26;

let linked = 0;
sheet.eachRow((r, i) => {
  if (i === 1) return;
  const id = String(r.getCell(1).value || '').trim();
  const anchor = anchors[id];
  if (!anchor) return;
  const c = r.getCell(COL);
  c.value = { text: `${id} screenshot →`, hyperlink: `#Evidence!A${anchor}` };
  c.font = { color: { argb: 'FF0563C1' }, underline: true };
  c.alignment = { vertical: 'top' };
  const m = byId[id];
  if (m) {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: m.failed ? FILL.fail : FILL.pass } };
  }
  linked++;
});

await wb.xlsx.writeFile(BOOK);
const size = (fs.statSync(BOOK).size / 1024 / 1024).toFixed(1);
console.log(`embedded ${embedded} screenshots on the Evidence sheet`);
console.log(`linked ${linked} case rows on ${sheet.name}`);
if (missing.length) console.log(`missing images: ${missing.join(', ')}`);
console.log(`workbook now ${size} MB -> ${BOOK}`);
