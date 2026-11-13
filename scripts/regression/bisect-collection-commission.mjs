// Bisects the 500 on the collection's own commissioning payload by changing one thing at a time.
// Run from repo root: node --env-file=.env scripts/regression/bisect-collection-commission.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';

const URL_M = `${process.env.API_BASE_URL}/api/integration/manufacturer/events`;
const KEY = process.env.MANUFACTURER_API_TOKEN;
const collection = JSON.parse(fs.readFileSync('Kenya TNT - Partner API Partner.postman_collection.json', 'utf8'));
const find = (items, path) => path.reduce((level, name) => (level?.item ?? level)?.find?.((n) => n.name === name), { item: items });
const raw = find(collection.item, ['Manufacturer Events', 'Commission (ObjectEvent)', 'JSON-LD']).request.body.raw;

const d = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const GOOD_SGLN = 'urn:epc:id:sgln:0614141.00001.0';

function base() {
  const doc = JSON.parse(raw);
  const e = doc.epcisBody.eventList[0];
  doc.creationDate = new Date().toISOString();
  e.eventID = `urn:uuid:${crypto.randomUUID()}`;
  e.eventTime = new Date(Date.now() - 600_000).toISOString();
  e.epcList = [`urn:epc:id:sgtin:0614141.000111.${d(9)}`];
  e.ilmd['cbvmda:lotNumber'] = `LOT-${d(5)}`;
  return doc;
}

const ev = (doc) => doc.epcisBody.eventList[0];
const VARIANTS = [
  ['collection payload, fresh ids', () => base()],
  ['+ valid SGLN (readPoint & bizLocation)', () => { const x = base(); ev(x).readPoint.id = GOOD_SGLN; ev(x).bizLocation.id = GOOD_SGLN; return x; }],
  ['+ valid readPoint only', () => { const x = base(); ev(x).readPoint.id = GOOD_SGLN; return x; }],
  ['+ valid bizLocation only', () => { const x = base(); ev(x).bizLocation.id = GOOD_SGLN; return x; }],
  ['malformed SGLN, no ilmd', () => { const x = base(); delete ev(x).ilmd; return x; }],
  ['malformed SGLN, lot only', () => { const x = base(); delete ev(x).ilmd['cbvmda:itemExpirationDate']; return x; }],
  ['malformed SGLN, expiry only', () => { const x = base(); delete ev(x).ilmd['cbvmda:lotNumber']; return x; }],
  ['two serials (as the journey sends)', () => { const x = base(); ev(x).epcList.push(`urn:epc:id:sgtin:0614141.000111.${d(9)}`); return x; }],
  ['13-digit serial (journey format)', () => { const x = base(); ev(x).epcList = [`urn:epc:id:sgtin:0614141.000111.${Date.now().toString().slice(-8)}${d(5)}`]; return x; }],
];

console.log(`payload location: ${ev(base()).readPoint.id} / ${ev(base()).bizLocation.id}`);
console.log(`payload ilmd keys: ${Object.keys(ev(base()).ilmd).join(', ')}\n`);
for (const [label, build] of VARIANTS) {
  const outcomes = [];
  for (let i = 0; i < 3; i += 1) {
    const res = await fetch(URL_M, {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json', 'X-API-Key': KEY },
      body: JSON.stringify(build()),
    });
    const text = await res.text();
    let code = '';
    try { code = JSON.parse(text).code || ''; } catch { /* ignore */ }
    outcomes.push(`${res.status}${code ? ` ${code}` : ''}`);
  }
  console.log(`  ${label.padEnd(42)} ${outcomes.join('  ')}`);
}
