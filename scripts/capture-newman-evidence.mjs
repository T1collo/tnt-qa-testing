// Screenshots each request card out of the Newman htmlextra report, one PNG per test case
// (plus its setup requests), so every case in the error-code sheet has attachable evidence.
//
// Run after a newman run:  node scripts/capture-newman-evidence.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const REPORT = path.join(ROOT, 'reports', 'newman', 'error-codes.html');
const OUTDIR = path.join(ROOT, 'reports', 'newman', 'evidence');

if (!fs.existsSync(REPORT)) {
  console.error(`No report at ${REPORT} — run newman first.`);
  process.exit(1);
}
fs.mkdirSync(OUTDIR, { recursive: true });
for (const f of fs.readdirSync(OUTDIR)) fs.unlinkSync(path.join(OUTDIR, f));

const MAX_H = 3800; // tall cards (1.2 MB pad, 50001 serials) are cropped rather than dropped

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 3900 }, deviceScaleFactor: 2 });
await page.goto(`file://${REPORT.replace(/\\/g, '/')}`, { waitUntil: 'domcontentloaded' });

// the run summary, captured while its tab is still the active one
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUTDIR, '_00-summary.png'), fullPage: true });

// the request cards live in the "Requests" tab pane, which starts inactive and therefore
// display:none — activate it before anything can be measured or screenshotted
await page.evaluate(() => {
  for (const p of document.querySelectorAll('.tab-pane')) p.classList.remove('show', 'active');
  const req = document.querySelector('#pills-requests');
  if (req) req.classList.add('show', 'active');
});
await page.waitForTimeout(500);

// expand folders, then every request block; then force any still-collapsed panel open,
// since a collapsed card has no bounding box and cannot be screenshotted
await page.click('#openAll').catch(() => {});
await page.waitForTimeout(800);
await page.click('#openAllRequests').catch(() => {});
await page.waitForTimeout(1500);
await page.evaluate(() => {
  for (const el of document.querySelectorAll('.collapse')) el.classList.add('show');
  for (const a of document.querySelectorAll('a.collapsed')) a.classList.remove('collapsed');
});
await page.waitForTimeout(800);

const cards = await page.$$('div.card.iteration-0');
console.log(`found ${cards.length} request cards`);

const manifest = [];
let pendingSetups = [];
let cropped = 0;

for (const card of cards) {
  const header = await card.$('.card-header a');
  if (!header) continue;
  const rawName = (await header.innerText()).replace(/\s+/g, ' ').trim();
  const name = rawName.replace(/^Iteration:\s*\d+\s*-\s*/, '');
  const failed = await card.$('.card-header.bg-danger') !== null
    || (await card.evaluate((el) => el.querySelector('.card-header')?.className || '')).includes('bg-danger');

  const isSetup = name.includes('↳ setup');
  const tc = name.match(/TC-S1-\d{3}/)?.[0];

  if (isSetup) { pendingSetups.push(card); continue; }
  if (!tc) continue;

  // setups belonging to this case are written first, in order
  let n = 0;
  for (const s of pendingSetups) {
    n++;
    await shoot(s, path.join(OUTDIR, `${tc}_setup${n}.png`));
  }
  pendingSetups = [];

  const file = path.join(OUTDIR, `${tc}.png`);
  const h = await shoot(card, file);
  manifest.push({ id: tc, name, failed, setups: n, file: path.basename(file), croppedAt: h });
  console.log(`${tc}${n ? ` (+${n} setup)` : ''}${h ? ' [cropped]' : ''}`);
}

async function shoot(el, file) {
  await el.evaluate((n) => n.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await page.waitForTimeout(60);
  const box = await el.boundingBox();
  if (!box) return null;
  if (box.height <= MAX_H) {
    await el.screenshot({ path: file });
    return null;
  }
  cropped++;
  await page.screenshot({
    path: file,
    clip: { x: box.x, y: Math.max(0, box.y), width: box.width, height: MAX_H },
  });
  return MAX_H;
}

// ---- second pass: a compact variant sized to sit inside an Excel row ----------------
// Header/description tables are hidden and oversized bodies clamped so the essentials
// (request, response, assertions) stay legible when scaled down. The full-card PNG
// captured above keeps every section.
await page.evaluate(() => {
  const HIDE = ['REQUEST DESCRIPTION', 'TEST PASS PERCENTAGE', 'REQUEST HEADERS', 'RESPONSE HEADERS'];
  for (const h of document.querySelectorAll('h5.card-title')) {
    if (!HIDE.includes(h.innerText.trim().toUpperCase())) continue;
    // hide only the card that owns this title — hiding the whole column would also
    // take out REQUEST/RESPONSE INFORMATION, which carry the endpoint and status code
    const block = h.closest('.card');
    if (block) block.style.display = 'none';
  }
  const style = document.createElement('style');
  style.textContent = 'pre { max-height: 360px; overflow: hidden !important; }';
  document.head.appendChild(style);
});
await page.waitForTimeout(600);

let compactCount = 0;
for (const card of cards) {
  const header = await card.$('.card-header a');
  if (!header) continue;
  const name = (await header.innerText()).replace(/\s+/g, ' ').trim();
  if (name.includes('↳ setup')) continue;
  const tc = name.match(/TC-S1-\d{3}/)?.[0];
  if (!tc) continue;
  await shoot(card, path.join(OUTDIR, `${tc}_compact.png`));
  compactCount++;
}
console.log(`${compactCount} compact variants written`);

fs.writeFileSync(path.join(OUTDIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
await browser.close();

const files = fs.readdirSync(OUTDIR).filter((f) => f.endsWith('.png'));
console.log(`\n${manifest.length} cases captured, ${files.length} PNGs total (${cropped} cropped at ${MAX_H}px)`);
console.log(`-> ${OUTDIR}`);
