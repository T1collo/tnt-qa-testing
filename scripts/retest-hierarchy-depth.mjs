// Retest of guide §3 "max hierarchy depth = 3" with every identifier recorded, so each step
// can be looked up on the platform. Uses a product registered in master data (from
// data/products.csv) to rule out the unregistered-product noise seen in earlier runs.
//
// Run: node --env-file=.env scripts/retest-hierarchy-depth.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.API_BASE_URL;
const MFG = process.env.MANUFACTURER_API_TOKEN;
const URL_M = `${BASE}/api/integration/manufacturer/events`;

const PREFIX = '8904179';          // company prefix of GTIN 18904179702187 in products.csv
const ITEM_REF = '170218';
const SGLN = 'urn:epc:id:sgln:0614141.00001.0';
const SETTLE_MS = 15000;           // serial registration was observed to take ~10s

const d = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const uuid = () => `urn:uuid:${crypto.randomUUID()}`;
const iso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wrap = (e) => ({
  '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
  type: 'EPCISDocument', schemaVersion: '2.0', creationDate: iso(),
  epcisBody: { eventList: [e] },
});

const item = `urn:epc:id:sgtin:${PREFIX}.${ITEM_REF}.${d(7)}`;
const caseA = `urn:epc:id:sscc:${PREFIX}.${d(10)}`;
const palletB = `urn:epc:id:sscc:${PREFIX}.${d(10)}`;
const containerC = `urn:epc:id:sscc:${PREFIX}.${d(10)}`;

const steps = [
  {
    level: 1, label: 'Commission pack (SGTIN)',
    event: {
      type: 'ObjectEvent', eventID: uuid(), eventTime: iso(), eventTimeZoneOffset: '+03:00',
      epcList: [item], action: 'ADD', bizStep: 'commissioning', disposition: 'active',
      readPoint: { id: SGLN }, bizLocation: { id: SGLN },
      ilmd: { 'cbvmda:lotNumber': `LOT-${d(4)}`, 'cbvmda:itemExpirationDate': '2028-12-31' },
    },
  },
  { level: 2, label: 'Pack SGTIN into case', parent: caseA, children: [item] },
  { level: 3, label: 'Pack case onto pallet', parent: palletB, children: [caseA] },
  { level: 4, label: 'Pack pallet into container (beyond max 3)', parent: containerC, children: [palletB] },
];

const out = { run: iso(), environment: BASE, product: `${PREFIX}.${ITEM_REF}`, steps: [] };
console.log(`Hierarchy depth retest — ${out.run}\n`);

for (const s of steps) {
  const event = s.event || {
    type: 'AggregationEvent', eventID: uuid(), eventTime: iso(), eventTimeZoneOffset: '+03:00',
    parentID: s.parent, childEPCs: s.children, action: 'ADD', bizStep: 'packing', disposition: 'active',
    readPoint: { id: SGLN }, bizLocation: { id: SGLN },
  };
  const res = await fetch(URL_M, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ld+json', 'X-API-Key': MFG },
    body: JSON.stringify(wrap(event)),
  });
  const text = await res.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  const codes = [...new Set([j.code, ...(j.errors || []).map((e) => e.code), ...(j.warnings || []).map((w) => w.code)].filter(Boolean))];
  const rec = {
    level: s.level, step: s.label,
    submittedEventID: event.eventID,
    returnedEventIDs: j.event_ids || [],
    parentID: event.parentID || null,
    childEPCs: event.childEPCs || null,
    epcList: event.epcList || null,
    http: res.status, codes,
    warnings: (j.warnings || []).map((w) => `${w.code}: ${w.message}`),
  };
  out.steps.push(rec);

  console.log(`LEVEL ${s.level} — ${s.label}`);
  console.log(`  eventID  : ${rec.submittedEventID}`);
  if (rec.parentID) console.log(`  parentID : ${rec.parentID}`);
  if (rec.childEPCs) console.log(`  children : ${rec.childEPCs.join(', ')}`);
  if (rec.epcList) console.log(`  epcList  : ${rec.epcList.join(', ')}`);
  console.log(`  HTTP ${rec.http}  [${codes.join(', ') || 'no warnings'}]`);
  if (rec.returnedEventIDs.length && rec.returnedEventIDs[0] !== rec.submittedEventID) {
    console.log(`  NOTE: platform returned a different event id: ${rec.returnedEventIDs.join(', ')}`);
  }
  console.log('');
  await sleep(SETTLE_MS);
}

const file = path.join(import.meta.dirname, '..', 'reports', 'hierarchy-depth-retest.json');
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`saved -> ${file}`);
