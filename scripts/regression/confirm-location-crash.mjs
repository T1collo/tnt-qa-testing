// Confirms the manufacturer commissioning 500: real (catalogue) product prefix combined with the
// collection's malformed location code. Each cell is 3 fresh submissions.
// Run: node --env-file=.env scripts/regression/confirm-location-crash.mjs
import crypto from 'node:crypto';

const URL_M = `${process.env.API_BASE_URL}/api/integration/manufacturer/events`;
const KEY = process.env.MANUFACTURER_API_TOKEN;
const d = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

const PREFIXES = {
  'unregistered 0614141.000111': 'urn:epc:id:sgtin:0614141.000111',
  'Telmicos 6161102.097499': 'urn:epc:id:sgtin:6161102.097499',
  'Amtel (registered) 8904179.170218': 'urn:epc:id:sgtin:8904179.170218',
};
const LOCATIONS = {
  'valid 0614141.00001.0': 'urn:epc:id:sgln:0614141.00001.0',
  'collection 10000000.00009.0 (13 digits)': 'urn:epc:id:sgln:10000000.00009.0',
};

const send = async (prefix, sgln) => {
  const body = {
    '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
    type: 'EPCISDocument', schemaVersion: '2.0', creationDate: new Date().toISOString(),
    epcisBody: { eventList: [{
      type: 'ObjectEvent', eventID: `urn:uuid:${crypto.randomUUID()}`,
      eventTime: new Date(Date.now() - 600_000).toISOString(), eventTimeZoneOffset: '+03:00',
      epcList: [`${prefix}.${d(9)}`], action: 'ADD', bizStep: 'commissioning', disposition: 'active',
      readPoint: { id: sgln }, bizLocation: { id: sgln },
      ilmd: { 'cbvmda:lotNumber': `LOT-${d(5)}`, 'cbvmda:itemExpirationDate': '2028-12-31' },
    }] },
  };
  const res = await fetch(URL_M, { method: 'POST', headers: { 'Content-Type': 'application/ld+json', 'X-API-Key': KEY }, body: JSON.stringify(body) });
  return res.status;
};

for (const [pName, prefix] of Object.entries(PREFIXES)) {
  for (const [lName, sgln] of Object.entries(LOCATIONS)) {
    const out = [];
    for (let i = 0; i < 3; i += 1) out.push(await send(prefix, sgln));
    console.log(`${pName.padEnd(36)} ${lName.padEnd(40)} ${out.join(' ')}`);
  }
}
