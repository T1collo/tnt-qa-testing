// Guide 6.4 incorrect_data flow: original -> corrective event -> declaration citing it.
// Question: is a corrective event that fixes only non-key data (the guide's own example is a
// wrong purchase order) refused by the duplicate-payload check, making the flow impossible?
// Run: node --env-file=.env scripts/regression/probe-incorrect-data.mjs
import crypto from 'node:crypto';

const URL_M = `${process.env.API_BASE_URL}/api/integration/manufacturer/events`;
const KEY = process.env.MANUFACTURER_API_TOKEN;
const d = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => `urn:uuid:${crypto.randomUUID()}`;

const doc = (e) => ({
  '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
  type: 'EPCISDocument', schemaVersion: '2.0', creationDate: new Date().toISOString(),
  epcisBody: { eventList: [e] },
});
const post = async (e) => {
  const res = await fetch(URL_M, { method: 'POST', headers: { 'Content-Type': 'application/ld+json', 'X-API-Key': KEY }, body: JSON.stringify(doc(e)) });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, code: j.code || '', message: String(j.message || '').slice(0, 90) };
};

function shipping(over = {}) {
  return {
    type: 'ObjectEvent', eventID: uuid(), eventTime: new Date(Date.now() - 600_000).toISOString(),
    eventTimeZoneOffset: '+03:00', epcList: [`urn:epc:id:sscc:0614141.${d(10)}`],
    action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit',
    readPoint: { id: 'urn:epc:id:sgln:0614141.00001.0' }, bizLocation: { id: 'urn:epc:id:sgln:0614141.00001.0' },
    bizTransactionList: [{ type: 'urn:epcglobal:cbv:btt:po', bizTransaction: `urn:epcglobal:cbv:bt:0614141:PO-${d(5)}` }],
    ...over,
  };
}

async function scenario(label, correct) {
  const original = shipping();
  const o = await post(original);
  await sleep(4000);
  const corrective = { ...correct(original), eventID: uuid() };
  const c = await post(corrective);
  await sleep(4000);
  const declaration = {
    ...original,
    errorDeclaration: {
      declarationTime: new Date().toISOString(),
      reason: 'incorrect_data',
      correctiveEventIDs: [corrective.eventID],
    },
  };
  const x = await post(declaration);
  console.log(`\n${label}`);
  console.log(`  original    ${o.status} ${o.code}`);
  console.log(`  corrective  ${c.status} ${c.code} ${c.code ? c.message : ''}`);
  console.log(`  declaration ${x.status} ${x.code}`);
}

await scenario('A. correct the purchase order only (guide 6.4 example)', (orig) => ({
  ...orig,
  bizTransactionList: [{ type: 'urn:epcglobal:cbv:btt:po', bizTransaction: `${orig.bizTransactionList[0].bizTransaction}-FIXED` }],
}));
await scenario('B. correct the location (a field inside the duplicate key)', (orig) => ({
  ...orig,
  readPoint: { id: 'urn:epc:id:sgln:0619999.00002.0' },
  bizLocation: { id: 'urn:epc:id:sgln:0619999.00002.0' },
}));
