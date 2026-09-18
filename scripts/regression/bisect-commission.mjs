// Bisects the manufacturer commissioning 500: which part of a valid commissioning event makes
// the manufacturer route fall over? Each variant is fresh (new eventID and serial), so the
// duplicate check never interferes.
//
// Run: node --env-file=.env scripts/regression/bisect-commission.mjs [repeats]
import crypto from 'node:crypto';

const BASE = process.env.API_BASE_URL;
const ROUTES = {
  manufacturer: [`${BASE}/api/integration/manufacturer/events`, process.env.MANUFACTURER_API_TOKEN],
  supplier: [`${BASE}/api/integration/supplier/events`, process.env.DISTRIBUTOR_API_TOKEN],
};
const REPEATS = Number(process.argv[2] || 2);

const d = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const SGLN = 'urn:epc:id:sgln:0614141.00001.0';

function doc({ prefix = 'urn:epc:id:sgtin:0614141.000111', ilmd, context }) {
  const event = {
    type: 'ObjectEvent', eventID: `urn:uuid:${crypto.randomUUID()}`,
    eventTime: new Date(Date.now() - 600_000).toISOString(), eventTimeZoneOffset: '+03:00',
    epcList: [`${prefix}.${d(9)}`], action: 'ADD', bizStep: 'commissioning', disposition: 'active',
    readPoint: { id: SGLN }, bizLocation: { id: SGLN },
  };
  if (ilmd) event.ilmd = ilmd;
  return {
    '@context': [context || 'https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
    type: 'EPCISDocument', schemaVersion: '2.0', creationDate: new Date().toISOString(),
    epcisBody: { eventList: [event] },
  };
}

const lot = () => `LOT-${d(5)}`;
const VARIANTS = [
  ['no ilmd', {}],
  ['lot only', { ilmd: { 'cbvmda:lotNumber': lot() } }],
  ['expiry only', { ilmd: { 'cbvmda:itemExpirationDate': '2028-12-31' } }],
  ['lot + expiry', { ilmd: { 'cbvmda:lotNumber': lot(), 'cbvmda:itemExpirationDate': '2028-12-31' } }],
  ['lot + expiry, registered GTIN', { prefix: 'urn:epc:id:sgtin:8904179.170218', ilmd: { 'cbvmda:lotNumber': lot(), 'cbvmda:itemExpirationDate': '2028-12-31' } }],
  ['lot + expiry, 2.0.0 context URL', { context: 'https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld', ilmd: { 'cbvmda:lotNumber': lot(), 'cbvmda:itemExpirationDate': '2028-12-31' } }],
  ['lot + expiry 2027-07-15 (collection value)', { ilmd: { 'cbvmda:lotNumber': lot(), 'cbvmda:itemExpirationDate': '2027-07-15' } }],
];

for (const [routeName, [url, key]] of Object.entries(ROUTES)) {
  console.log(`\n=== ${routeName} route ===`);
  for (const [label, opts] of VARIANTS) {
    const outcomes = [];
    for (let i = 0; i < REPEATS; i += 1) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/ld+json', 'X-API-Key': key },
        body: JSON.stringify(doc({ ...opts, ilmd: opts.ilmd && { ...opts.ilmd, ...(opts.ilmd['cbvmda:lotNumber'] ? { 'cbvmda:lotNumber': lot() } : {}) } })),
      });
      const text = await res.text();
      let code = '';
      try { code = JSON.parse(text).code || ''; } catch { /* non-JSON */ }
      outcomes.push(`${res.status}${code ? ` ${code}` : ''}`);
    }
    console.log(`  ${label.padEnd(44)} ${outcomes.join('  ')}`);
  }
}
