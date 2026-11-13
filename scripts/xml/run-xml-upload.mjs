// Partner portal XML upload (/partners/upload) against the EPCIS rules in Partner Docs > Technical
// Guides. Builds the XML pack, uploads each file through the page (session auth), polls every
// submission at /partners/async-submissions/<id>, and judges each test against its expected code.
// When the page blocks a file before sending it (size/type), the same file is also POSTed straight
// to the API so the server-side check is tested too.
//
// Outputs: pack  -> C:\Users\Collins\Desktop\uploads\xml-partner (or --pack)
//          proof -> Proof/partner-xml/<id>.png (page after upload) and <id>-status.png (final record)
//          results.json and jira-matrix.txt (Passed / Failed matrices) in Proof/partner-xml/
// Run:  node --env-file=.env scripts/xml/run-xml-upload.mjs [--only X01,X10] [--sample "<path to SAP .XML>"]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const ROOT = path.join(import.meta.dirname, '..', '..');

const args = Object.fromEntries(process.argv.slice(2).reduce((p, a, i, all) => (a.startsWith('--') ? [...p, [a.slice(2), all[i + 1]]] : p), []));
const BASE = 'https://tnt-demo.apeiro-digital.com';
const API = `${BASE}/api`;
const PACK = args.pack || 'C:\\Users\\Collins\\Desktop\\uploads\\xml-partner';
const PROOF = path.join(ROOT, 'Proof', 'partner-xml');
const SAMPLE = args.sample || 'C:\\Users\\Collins\\Downloads\\SC_EP_NT_O_BXCEKSE (1).XML';
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const { PARTNER_EMAIL, PARTNER_PASSWORD } = process.env;
if (!PARTNER_EMAIL || !PARTNER_PASSWORD) throw new Error('set PARTNER_EMAIL and PARTNER_PASSWORD in .env');

// Master data: registered product Amtel (GTIN 18904179702187) and the parity-pack GLNs.
const SGTIN = 'urn:epc:id:sgtin:8904179.170218';
const SSCC_PREFIX = 'urn:epc:id:sscc:8904179.';
const SGLN = 'urn:epc:id:sgln:0614141.00001.0';
const DEST_SGLN = 'urn:epc:id:sgln:0614142.00001.0';
const UNKNOWN_SGTIN = 'urn:epc:id:sgtin:6161999.099999';
const OTHER_MFR_SGTIN = 'urn:epc:id:sgtin:4057598.001364'; // Xarelto (Bayer), GTIN 04057598013642
const MAX_BYTES = 10 * 1024 * 1024;

// Codes documented in the Technical Guides, plus ones the API is known to return.
const KNOWN = new Set(`BUSINESS_RULE MASTER_DATA INVALID_DISPOSITION RECEIVING_WITHOUT_SHIPPING INVALID_PARENT_CHILD_RELATION
INVALID_TERMINAL_STATE DUPLICATE_EVENT_ID SHIPPING_WITHOUT_COMMISSIONING MISSING_NEEDED_FIELDS IMPOSSIBLE_SENSOR_VALUES EXPIRED_PRODUCT
UNKNOWN_SGTIN UNKNOWN_SGLN STALE_EVENT_TIME INVALID_JSON_STRUCTURE INACTIVE_SGLN ERROR_DECLARATION_CONTENT_MISMATCH DUPLICATE_EVENT_PAYLOAD
CHILD_ALREADY_AGGREGATED UNSUPPORTED_FORMAT UNPACK_WITHOUT_AGGREGATION UNCOMMISSIONED_CHILD UNAUTHORIZED_INSPECTING_EVENT TOO_MANY_SERIALS
SERIAL_ALREADY_DISPENSED SERIAL_ALREADY_DESTROYED RECALL_ACTIVE RATE_LIMITED PAYLOAD_TOO_LARGE PARTIALLY_ACCEPTED PARENT_NOT_FOUND
OUT_OF_ORDER_EVENT NO_REGULATORY_APPROVAL MIXED_LOT_IN_COMMISSIONING MISSING_REQUIRED_FIELD MISSING_ILMD MISSING_EVENT_LIST
MISSING_EPCIS_BODY MESSAGE_SIZE_EXCEEDED INVENTORY_SIGHTING_MISMATCH INVALID_XML_STRUCTURE INVALID_SSCC_CHECK_DIGIT INVALID_SBDH
INVALID_LOT INVALID_GTIN_CHECK_DIGIT INVALID_GS1_IDENTIFIER INVALID_GLN_CHECK_DIGIT INVALID_EXPIRY_FORMAT INVALID_ACTION FUTURE_EVENT_TIME
EXPIRING_SOON DUPLICATE_EPC_IN_EVENT DISPENSING_WITHOUT_RECEIVING DESTRUCTION_WITHOUT_RECALL ALREADY_DISPENSED PARTNER_TYPE_BIZSTEP_MISMATCH
UNKNOWN_PARTY_GLN UNPROCESSABLE_ENTITY SERVER_ERROR UPLOAD_FORMAT_PLANNED`.split(/\s+/));

// ---------------------------------------------------------------- XML builders
const RUN = crypto.randomBytes(2).toString('hex').toUpperCase();
let serialN = 0;
const serial = () => `${String(Date.now()).slice(-9)}${String((serialN += 1)).padStart(5, '0')}`;
const items = (n) => Array.from({ length: n }, () => `${SGTIN}.${serial()}`);
const sscc = () => `${SSCC_PREFIX}${String(crypto.randomInt(1e9, 1e10 - 1)).padStart(10, '0')}`;
const uuid = () => `urn:uuid:${crypto.randomUUID()}`;
let clock = Date.now() - 60 * 60_000;
const tick = () => new Date((clock += 1000)).toISOString();
const LOT = () => `L${RUN}${String(serialN).slice(-3)}`;
const EXP = `${new Date().getFullYear() + 2}-12-31`;
const epcList = (tag, epcs) => `<${tag}>${epcs.map((e) => `<epc>${e}</epc>`).join('')}</${tag}>`;
const where = `<readPoint><id>${SGLN}</id></readPoint><bizLocation><id>${SGLN}</id></bizLocation>`;

// Each builder returns the event XML; `o` overrides pieces so a test can break exactly one thing.
function commission(epcs, o = {}) {
  const ilmd = o.ilmd ?? `<extension><ilmd><cbvmda:lotNumber>${o.lot ?? LOT()}</cbvmda:lotNumber><cbvmda:itemExpirationDate>${o.exp ?? EXP}</cbvmda:itemExpirationDate></ilmd></extension>`;
  return `<ObjectEvent>${o.id === null ? '' : `<eventID>${o.id ?? uuid()}</eventID>`}<eventTime>${o.time ?? tick()}</eventTime>${o.tz === null ? '' : `<eventTimeZoneOffset>${o.tz ?? '+03:00'}</eventTimeZoneOffset>`}`
    + `${epcList('epcList', epcs)}<action>${o.action ?? 'ADD'}</action>${o.bizStep === null ? '' : `<bizStep>urn:epcglobal:cbv:bizstep:${o.bizStep ?? 'commissioning'}</bizStep>`}`
    + `<disposition>urn:epcglobal:cbv:disp:${o.disp ?? 'active'}</disposition>${where}${ilmd}</ObjectEvent>`;
}
const pack = (parent, children, o = {}) => `<AggregationEvent><eventID>${o.id ?? uuid()}</eventID><eventTime>${o.time ?? tick()}</eventTime><eventTimeZoneOffset>+03:00</eventTimeZoneOffset>`
  + `<parentID>${parent}</parentID>${epcList('childEPCs', children)}<action>ADD</action><bizStep>urn:epcglobal:cbv:bizstep:packing</bizStep>`
  + `<disposition>urn:epcglobal:cbv:disp:in_progress</disposition>${where}</AggregationEvent>`;
const ship = (epcs, o = {}) => `<ObjectEvent><eventID>${uuid()}</eventID><eventTime>${tick()}</eventTime><eventTimeZoneOffset>+03:00</eventTimeZoneOffset>`
  + `${epcList('epcList', epcs)}<action>OBSERVE</action><bizStep>urn:epcglobal:cbv:bizstep:shipping</bizStep><disposition>urn:epcglobal:cbv:disp:in_transit</disposition>${where}`
  + `${o.noBizTx ? '' : `<bizTransactionList><bizTransaction type="urn:epcglobal:cbv:btt:desadv">urn:epcglobal:cbv:bt:0614141000012:ASN-${RUN}-${serial()}</bizTransaction></bizTransactionList>`}`
  + `<extension><sourceList><source type="urn:epcglobal:cbv:sdt:owning_party">${SGLN}</source></sourceList><destinationList><destination type="urn:epcglobal:cbv:sdt:owning_party">${DEST_SGLN}</destination></destinationList></extension></ObjectEvent>`;
const observe = (epcs, bizStep, disp) => `<ObjectEvent><eventID>${uuid()}</eventID><eventTime>${tick()}</eventTime><eventTimeZoneOffset>+03:00</eventTimeZoneOffset>`
  + `${epcList('epcList', epcs)}<action>OBSERVE</action><bizStep>urn:epcglobal:cbv:bizstep:${bizStep}</bizStep><disposition>urn:epcglobal:cbv:disp:${disp}</disposition>${where}</ObjectEvent>`;
const doc = (events, o = {}) => `<?xml version="1.0" encoding="UTF-8"?>\n<epcis:EPCISDocument xmlns:epcis="${o.ns ?? 'urn:epcglobal:epcis:xsd:1'}" xmlns:cbvmda="urn:epcglobal:cbv:mda" schemaVersion="${o.schema ?? '1.2'}" creationDate="${new Date().toISOString()}">\n`
  + `${o.header ?? ''}${o.body ?? `<EPCISBody><EventList>\n${events.join('\n')}\n</EventList></EPCISBody>`}\n</epcis:EPCISDocument>\n`;
const journey = () => {
  const it = items(6); const c1 = sscc(); const c2 = sscc(); const pal = sscc();
  return [commission(it), pack(c1, it.slice(0, 3)), pack(c2, it.slice(3)), pack(pal, [c1, c2]), ship([pal])];
};

// The user's SAP ATTP export: its header (SBDH, n0: prefix) and its whole events, untouched.
function sampleParts() {
  const raw = fs.readFileSync(SAMPLE, 'utf8');
  const start = raw.indexOf('<EventList>') + '<EventList>'.length;
  const end = raw.lastIndexOf('</EventList>');
  const events = raw.slice(start, end).match(/<(ObjectEvent|AggregationEvent)>[\s\S]*?<\/\1>/g);
  return { head: raw.slice(0, start), tail: raw.slice(end), events, raw };
}
const epcCount = (xml) => (xml.match(/<epc>|<parentID>/g) || []).length;
// Largest prefix of the sample's events that stays under both caps (bytes and EPCs).
function samplePrefix(parts, maxBytes, maxEpcs) {
  let bytes = Buffer.byteLength(parts.head + parts.tail); let epcs = 0; const out = [];
  for (const e of parts.events) {
    const b = Buffer.byteLength(e) + 1; const n = epcCount(e);
    if (bytes + b > maxBytes || epcs + n > maxEpcs) break;
    out.push(e); bytes += b; epcs += n;
  }
  return `${parts.head}\n${out.join('\n')}\n${parts.tail}`;
}

// ---------------------------------------------------------------- the tests
// expect: { outcome: 'accepted' | 'rejected' | 'partial', codes: [one of these must be reported] }
const T = [];
const t = (id, group, title, rule, expect, build, extra = {}) => T.push({ id, group, title, rule, expect, build, ...extra });
const acc = (...codes) => ({ outcome: 'accepted', codes });
// A valid journey must not pick up warnings that only appear when its events are processed out of order.
const clean = { mustNot: ['SHIPPING_WITHOUT_COMMISSIONING', 'INVALID_DISPOSITION', 'UNCOMMISSIONED_CHILD'] };
const rej = (...codes) => ({ outcome: 'rejected', codes });

// A. Valid files and format compatibility
t('X01', 'Valid', 'Valid journey: commission 6 items > 2 cases > 1 pallet > ship', 'Guide 3.x happy path', acc(), () => doc(journey()), { checkIds: true, ...clean });
// The SAP sample is an imported product (GS1 prefix 4008500, Germany) with no sourceList/countryOfOrigin,
// which the guide requires for foreign-MAH commissioning, so the correct outcome is a rejection.
const SAP_RULE = 'Guide: imported-product commissioning needs sourceList (foreign MAH GLN) + countryOfOrigin';
t('X02a', 'Valid', 'Your SAP ATTP file, first ~1 MB of whole events, unchanged', SAP_RULE, rej('MISSING_NEEDED_FIELDS'), () => samplePrefix(sampleParts(), 1024 * 1024, 50_000), { name: 'SC_EP_NT_O_BXCEKSE-1MB.XML' });
t('X02b', 'Valid', 'Your SAP ATTP file, largest slice under 10 MB and 50,000 EPCs, unchanged', SAP_RULE, rej('MISSING_NEEDED_FIELDS'), () => samplePrefix(sampleParts(), MAX_BYTES - 4096, 49_000), { name: 'SC_EP_NT_O_BXCEKSE-max.XML' });
t('X03', 'Valid', 'Your full SAP ATTP file (25.8 MB), unchanged', 'Max 10 MB per document', rej('PAYLOAD_TOO_LARGE', 'MESSAGE_SIZE_EXCEEDED'), () => sampleParts().raw, { name: 'SC_EP_NT_O_BXCEKSE-full.XML' });
t('X04', 'Valid', 'eventID inside <baseExtension>', 'Guide: either placement accepted', acc(), () => doc(journey()).replace(/<eventID>([^<]+)<\/eventID>/g, '<baseExtension><eventID>$1</eventID></baseExtension>'), { checkIds: true, ...clean });
t('X05', 'Valid', 'Uppercase .XML extension (as SAP exports it)', 'Accepted extension .xml', acc(), () => doc(journey()), { name: 'X05_upper.XML', ...clean });
t('X06', 'Valid', 'UTF-8 with BOM', 'XML 1.0 encoding', acc(), () => `\uFEFF${doc(journey())}`, clean);
t('X07', 'Valid', 'Windows CRLF line endings', 'XML 1.0 line handling', acc(), () => doc(journey()).replace(/\n/g, '\r\n'), clean);
t('X08', 'Valid', 'UTF-16 encoded document (declared UTF-16)', 'XML 1.0 encoding', acc(), () => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(doc(journey()).replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le')]), clean);

// B. Document structure
t('X10', 'Structure', 'Malformed XML (unclosed tag)', 'INVALID_XML_STRUCTURE', rej('INVALID_XML_STRUCTURE'), () => doc(journey()).replace('</epcList>', ''));
t('X11', 'Structure', 'No EPCISBody', 'MISSING_EPCIS_BODY', rej('MISSING_EPCIS_BODY'), () => doc([], { body: '' }));
t('X12', 'Structure', 'EPCISBody without EventList', 'MISSING_EVENT_LIST', rej('MISSING_EVENT_LIST'), () => doc([], { body: '<EPCISBody></EPCISBody>' }));
t('X13', 'Structure', 'Empty EventList', 'MISSING_EVENT_LIST', rej('MISSING_EVENT_LIST'), () => doc([], { body: '<EPCISBody><EventList></EventList></EPCISBody>' }));
t('X14', 'Structure', 'EPCIS 2.0 XML document (xsd:2, schemaVersion 2.0)', 'EPCIS 1.2 XML only', rej('UNSUPPORTED_FORMAT', 'INVALID_XML_STRUCTURE'), () => doc(journey(), { ns: 'urn:epcglobal:epcis:xsd:2', schema: '2.0' }));
t('X15', 'Structure', 'SBDH header without Sender/Receiver', 'INVALID_SBDH', rej('INVALID_SBDH'), () => doc(journey(), {
  header: '<EPCISHeader><extension><sbdh:StandardBusinessDocumentHeader xmlns:sbdh="http://www.unece.org/cefact/namespaces/StandardBusinessDocumentHeader"><sbdh:HeaderVersion>1.3</sbdh:HeaderVersion></sbdh:StandardBusinessDocumentHeader></extension></EPCISHeader>\n',
}));
t('X16', 'Structure', 'Empty file (0 bytes)', 'Reject empty upload', rej(), () => '');
t('X17', 'Structure', 'JSON-LD content saved as .xml', 'EPCIS 1.2 XML only', rej('INVALID_XML_STRUCTURE', 'UNSUPPORTED_FORMAT', 'UPLOAD_FORMAT_PLANNED'), () => JSON.stringify({ '@context': ['https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld'], type: 'EPCISDocument', schemaVersion: '2.0', epcisBody: { eventList: [] } }));
t('X18', 'Structure', 'CSV file (.csv)', 'XML only; CSV "coming later"', rej('UNSUPPORTED_FORMAT', 'UPLOAD_FORMAT_PLANNED'), () => 'Event_Type,GTIN,Unit_ID\nCOMMISSIONING,18904179702187,1\n', { name: 'X18_file.csv', mime: 'text/csv' });
t('X19', 'Structure', 'Well-formed XML that is not an EPCISDocument', 'EPCIS 1.2 schema', rej('INVALID_XML_STRUCTURE', 'MISSING_EPCIS_BODY'), () => '<?xml version="1.0"?><invoice><line>1</line></invoice>');

// C. Event field rules
const one = (o) => () => doc([commission(items(2), o)]);
t('X20', 'Fields', 'Event without eventID (no top-level, no baseExtension)', 'Guide: neither placement = hard reject', rej('MISSING_REQUIRED_FIELD'), one({ id: null }));
const part = (...codes) => ({ outcome: 'partial', codes });
t('X21', 'Fields', 'Same eventID on two events in one file', 'DUPLICATE_EVENT_ID: second event rejected', part('DUPLICATE_EVENT_ID'), () => { const id = uuid(); return doc([commission(items(2), { id }), commission(items(2), { id })]); });
t('X22', 'Fields', 'X01 uploaded again after it was ingested', 'DUPLICATE_EVENT_ID', rej('DUPLICATE_EVENT_ID', 'DUPLICATE_EVENT_PAYLOAD'), null, { reuse: 'X01', phase: 2 });
t('X23', 'Fields', 'eventTime one day in the future', 'FUTURE_EVENT_TIME', rej('FUTURE_EVENT_TIME'), one({ time: new Date(Date.now() + 86_400_000).toISOString() }));
t('X24', 'Fields', 'eventTime 10 days old', 'STALE_EVENT_TIME (warning path)', acc('STALE_EVENT_TIME'), one({ time: new Date(Date.now() - 10 * 86_400_000).toISOString() }));
t('X25', 'Fields', 'eventTime not in UTC (no Z, local time)', 'eventTime must be UTC ending in Z', rej(), one({ time: new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d+Z$/, '') }));
t('X26', 'Fields', 'eventTimeZoneOffset missing', 'MISSING_REQUIRED_FIELD', rej('MISSING_REQUIRED_FIELD'), one({ tz: null }));
t('X27', 'Fields', 'action CREATE (not ADD/OBSERVE/DELETE)', 'INVALID_ACTION', rej('INVALID_ACTION'), one({ action: 'CREATE' }));
t('X28', 'Fields', 'Commissioning with disposition in_transit', 'INVALID_DISPOSITION', rej('INVALID_DISPOSITION'), one({ disp: 'in_transit' }));
t('X29', 'Fields', 'Commissioning without ILMD (no lot, no expiry)', 'MISSING_ILMD', rej('MISSING_ILMD'), one({ ilmd: '' }));
t('X30', 'Fields', 'Expiry date 31/12/2028 (not YYYY-MM-DD)', 'INVALID_EXPIRY_FORMAT', rej('INVALID_EXPIRY_FORMAT'), one({ exp: '31/12/2028' }));
t('X31', 'Fields', 'Two lot numbers in one commissioning event', 'MIXED_LOT_IN_COMMISSIONING', rej('MIXED_LOT_IN_COMMISSIONING'), one({
  ilmd: `<extension><ilmd><cbvmda:lotNumber>LA${RUN}</cbvmda:lotNumber><cbvmda:lotNumber>LB${RUN}</cbvmda:lotNumber><cbvmda:itemExpirationDate>${EXP}</cbvmda:itemExpirationDate></ilmd></extension>`,
}));
t('X32', 'Fields', 'Malformed SGTIN (company prefix + item ref = 12 digits)', 'INVALID_GS1_IDENTIFIER', rej('INVALID_GS1_IDENTIFIER'), () => doc([commission([`urn:epc:id:sgtin:8904179.17021.${serial()}`])]));
t('X33', 'Fields', 'Malformed SSCC parent (16 digits) on the pack event', 'INVALID_GS1_IDENTIFIER: pack event rejected', part('INVALID_GS1_IDENTIFIER'), () => { const it = items(2); return doc([commission(it), pack(`${SSCC_PREFIX}${'1'.repeat(9)}`, it)]); });
t('X34', 'Fields', 'Same EPC twice in one event', 'DUPLICATE_EPC_IN_EVENT', rej('DUPLICATE_EPC_IN_EVENT'), () => { const e = items(1)[0]; return doc([commission([e, e])]); });
t('X35', 'Fields', 'Event without bizStep', 'MISSING_REQUIRED_FIELD', rej('MISSING_REQUIRED_FIELD'), one({ bizStep: null }));
t('X36', 'Fields', 'Shipping without bizTransactionList', 'Guide: bizTransactionList mandatory on all events', rej('MISSING_REQUIRED_FIELD'), () => { const it = items(2); const c = sscc(); return doc([commission(it), pack(c, it), ship([c], { noBizTx: true })]); });

// D. Business rules
t('X40', 'Business rules', 'Pack items that were never commissioned', 'UNCOMMISSIONED_CHILD', acc('UNCOMMISSIONED_CHILD'), () => doc([pack(sscc(), items(2))]));
t('X41', 'Business rules', 'Pack an item already packed in another case', 'CHILD_ALREADY_AGGREGATED', rej('CHILD_ALREADY_AGGREGATED'), () => { const it = items(2); return doc([commission(it), pack(sscc(), it), pack(sscc(), [it[0]])]); });
t('X42', 'Business rules', 'Ship a case that was never commissioned or packed', 'SHIPPING_WITHOUT_COMMISSIONING', acc('SHIPPING_WITHOUT_COMMISSIONING'), () => doc([ship([sscc()])]));
t('X43', 'Business rules', 'Pack listed before commission in the file (eventTime order is correct)', 'Events processed in eventTime order', acc(), () => {
  const it = items(2); const t1 = tick(); const t2 = tick();
  return doc([pack(sscc(), it, { time: t2 }), commission(it, { time: t1 })]);
}, { mustNot: ['UNCOMMISSIONED_CHILD'] });
// Product checks are soft blocks: the event is accepted but must be flagged.
t('X44', 'Business rules', 'Unknown GTIN (not in master data)', 'Soft block: accepted, flagged UNKNOWN_SGTIN', acc('UNKNOWN_SGTIN'), () => doc([commission([`${UNKNOWN_SGTIN}.${serial()}`])]));
t('X45', 'Business rules', "Another manufacturer's GTIN (Xarelto, Bayer)", 'Soft block: accepted, flagged (product not owned by partner)', acc('UNKNOWN_SGTIN', 'MASTER_DATA'), () => doc([commission([`${OTHER_MFR_SGTIN}.${serial()}`])]));
t('X46', 'Business rules', 'Dispensing event from a manufacturer', 'PARTNER_TYPE_BIZSTEP_MISMATCH: dispense event rejected', part('PARTNER_TYPE_BIZSTEP_MISMATCH'), () => { const it = items(1); return doc([commission(it), observe(it, 'dispensing', 'dispensed')]); });
t('X47', 'Business rules', 'Pack an item destroyed earlier in the file', 'SERIAL_ALREADY_DESTROYED', rej('SERIAL_ALREADY_DESTROYED', 'INVALID_TERMINAL_STATE'), () => { const it = items(2); return doc([commission(it), observe([it[0]], 'destroying', 'destroyed'), pack(sscc(), it)]); });
t('X48', 'Business rules', '100 events, event 51 has a malformed SGTIN', 'PARTIALLY_ACCEPTED: 99 accepted, 1 rejected', { outcome: 'partial', codes: ['INVALID_GS1_IDENTIFIER', 'PARTIALLY_ACCEPTED'] }, () => doc(Array.from({ length: 100 }, (_, i) => commission(i === 50 ? [`urn:epc:id:sgtin:8904179.17021.${serial()}`] : items(1)))));

// E. Limits (EPCs counted as SGTINs + SSCCs; locations are not EPCs)
const bulk = (n, per = 1000) => { const ev = []; for (let left = n; left > 0; left -= per) ev.push(commission(items(Math.min(per, left)))); return doc(ev); };
t('X50', 'Limits', 'Exactly 50,000 EPCs in one document', 'Max 50,000 EPCs per document', acc(), () => bulk(50_000));
t('X51', 'Limits', '50,001 EPCs in one document', 'TOO_MANY_SERIALS', rej('TOO_MANY_SERIALS'), () => bulk(50_001));
t('X52', 'Limits', 'Valid file padded to just under 10 MB', 'Max 10 MB', acc(), () => { const d = doc(journey()); return d.replace('</epcis:EPCISDocument>', `<!--${' '.repeat(MAX_BYTES - Buffer.byteLength(d) - 64)}-->\n</epcis:EPCISDocument>`); }, clean);
t('X53', 'Limits', 'Valid file padded to just over 10 MB', 'PAYLOAD_TOO_LARGE', rej('PAYLOAD_TOO_LARGE', 'MESSAGE_SIZE_EXCEEDED'), () => { const d = doc(journey()); return d.replace('</epcis:EPCISDocument>', `<!--${' '.repeat(MAX_BYTES - Buffer.byteLength(d) + 1024)}-->\n</epcis:EPCISDocument>`); });

// F. Security and session
t('X60', 'Security', 'External entity (XXE) pointing at file:///etc/passwd in lotNumber', 'DOCTYPE/entities must be refused', rej(), () => doc([commission(items(1), { lot: '&xxe;' })]).replace('<epcis:EPCISDocument', '<!DOCTYPE epcis:EPCISDocument [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n<epcis:EPCISDocument'), { leak: /root:|\/bin\/(ba)?sh/ });
t('X61', 'Security', 'Internal entity expansion (bounded: 1,000 copies)', 'DOCTYPE/entities must be refused', rej(), () => doc([commission(items(1), { lot: '&e3;' })]).replace('<epcis:EPCISDocument', '<!DOCTYPE epcis:EPCISDocument [<!ENTITY e0 "QA"><!ENTITY e1 "&e0;&e0;&e0;&e0;&e0;&e0;&e0;&e0;&e0;&e0;"><!ENTITY e2 "&e1;&e1;&e1;&e1;&e1;&e1;&e1;&e1;&e1;&e1;"><!ENTITY e3 "&e2;&e2;&e2;&e2;&e2;&e2;&e2;&e2;&e2;&e2;">]>\n<epcis:EPCISDocument'));
t('X62', 'Security', 'Script markup in lotNumber (escaped <script>)', 'Lot must be alphanumeric (INVALID_LOT)', rej('INVALID_LOT'), one({ lot: `&lt;script&gt;alert(${RUN})&lt;/script&gt;` }));
t('X63', 'Security', 'Upload with no session (signed out)', 'Session auth required', rej(), () => doc(journey()), { noSession: true });

// ---------------------------------------------------------------- running
const results = [];
const run = T.filter((x) => !ONLY || ONLY.has(x.id));
// --rejudge: re-read each job's current state and re-score the last run, without building or uploading.
const REJUDGE = 'rejudge' in args;
const previous = REJUDGE ? JSON.parse(fs.readFileSync(path.join(PROOF, 'results.json'), 'utf8')).results : [];
fs.mkdirSync(PACK, { recursive: true });
fs.mkdirSync(PROOF, { recursive: true });
for (const x of run) {
  if (REJUDGE) {
    const old = previous.find((p) => p.id === x.id);
    if (old) Object.assign(x, { upload: old.upload, requestId: old.requestId, sentIds: old.sentIds, sentEpcs: old.sentEpcs, bytes: old.bytes, ui: old.ui, file: path.join(PACK, old.file) });
    else x.skipped = 'not in the previous run';
    continue;
  }
  if (!x.build) continue;
  const body = x.build();
  x.file = path.join(PACK, x.name || `${x.id}_${x.title.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}.xml`);
  fs.writeFileSync(x.file, body);
  const text = Buffer.isBuffer(body) ? '' : body;
  x.sentIds = [...text.matchAll(/<eventID>\s*([^<\s]+)\s*<\/eventID>/g)].map((m) => m[1]);
  x.sentEpcs = epcCount(text);
  x.bytes = fs.statSync(x.file).size;
}

async function signIn(browser) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto('/partners/login', { waitUntil: 'load' });
  await page.locator('input[type=email]').fill(PARTNER_EMAIL);
  await page.locator('input[type=password]').fill(PARTNER_PASSWORD);
  await page.locator('button[type=submit]').click();
  await page.waitForURL(/\/partners\/dashboard/, { timeout: 60_000 });
  return page;
}

const UPLOAD_RE = /\/api\/partners\/uploads$/;
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Upload through the page; if the page never sends it, POST the same file to the API directly.
async function upload(page, x) {
  await page.goto('/partners/upload', { waitUntil: 'networkidle' });
  const respP = page.waitForResponse((r) => r.request().method() === 'POST' && UPLOAD_RE.test(new URL(r.url()).pathname), { timeout: 120_000 }).catch(() => null);
  await page.locator('input[type=file]').setInputFiles({ name: path.basename(x.file), mimeType: x.mime || 'application/xml', buffer: fs.readFileSync(x.file) });
  await page.waitForTimeout(800);
  const btn = page.getByRole('button', { name: /Upload XML/i });
  const enabled = await btn.isEnabled().catch(() => false);
  if (enabled) await btn.click();
  const resp = enabled ? await Promise.race([respP, page.waitForTimeout(15_000).then(() => null)]) : null;
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(PROOF, `${x.id}.png`), fullPage: true });
  x.ui = { sent: Boolean(resp), message: (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600) };
  if (resp) {
    x.upload = { status: resp.status(), body: (await resp.text().catch(() => '')).slice(0, 4000) };
  } else {
    const r = await page.request.post(`${API}/partners/uploads`, { multipart: { file: { name: path.basename(x.file), mimeType: x.mime || 'application/xml', buffer: fs.readFileSync(x.file) } } });
    x.upload = { status: r.status(), body: (await r.text()).slice(0, 4000), direct: true };
  }
  x.requestId = json(x.upload.body)?.request_id || null;
  console.log(`${x.id.padEnd(5)} upload ${x.upload.status}${x.upload.direct ? ' (direct API; page did not send)' : ''} ${x.requestId || x.upload.body.slice(0, 160)}`);
}

async function poll(page, x) {
  if (!x.requestId) return;
  for (let i = 0; i < 300; i += 1) {
    const r = await page.request.get(`${API}/partners/async-submissions/${x.requestId}`);
    x.record = await r.json().catch(() => null);
    if (x.record && !/^(accepted|queued|processing|pending|received|in_progress)$/i.test(x.record.status || '')) return;
    await page.waitForTimeout(3000);
  }
}

async function shootStatus(ctx, x) {
  const shown = x.record ? { ...x.record, result_summary: { ...(x.record.result_summary || {}), event_ids: `(${x.record.result_summary?.event_ids?.length ?? 0} ids)` } } : { upload_http_status: x.upload?.status, upload_response: json(x.upload?.body) || x.upload?.body };
  const esc = JSON.stringify(shown, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const p = await ctx.newPage();
  await p.setContent(`<h3 style="font-family:sans-serif">${x.id} ${x.title.replace(/</g, '&lt;')}: final submission status (${BASE}/partners/upload)</h3><pre style="font-size:13px;white-space:pre-wrap">${esc}</pre>`);
  await p.screenshot({ path: path.join(PROOF, `${x.id}-status.png`), fullPage: true });
  await p.close();
}

function judge(x) {
  const rec = x.record || {};
  const sum = rec.result_summary || {};
  const blob = `${x.upload?.body || ''} ${JSON.stringify(rec)}`;
  const codes = [...new Set(blob.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [])].filter((c) => KNOWN.has(c));
  if (x.upload?.status === 413 && !codes.includes('PAYLOAD_TOO_LARGE')) codes.push('PAYLOAD_TOO_LARGE'); // plain 413 body, no code
  const events = sum.event_count ?? sum.events_processed;
  const accepted = sum.accepted_count ?? (rec.status === 'succeeded' ? events : 0);
  let outcome;
  if (x.upload && x.upload.status < 400 && /^(accepted|queued|processing|pending|received|in_progress)$/i.test(rec.status || '')) outcome = 'never completed';
  else if (!x.upload || x.upload.status >= 400 || /fail|reject|error/i.test(rec.status || '') || (rec.status && !accepted)) outcome = 'rejected';
  else if (rec.status === 'succeeded' && events != null && accepted < events) outcome = 'partial';
  else if (rec.status === 'succeeded') outcome = 'accepted';
  else outcome = rec.status || 'no result';
  const notes = [];
  if (outcome === 'never completed') notes.push(`job still "${rec.status}" ${Math.round((Date.now() - Date.parse(rec.accepted_at)) / 60000)} min after upload, no result or diagnostics`);
  if (x.checkIds && rec.status === 'succeeded') {
    const back = new Set(sum.event_ids || []);
    const kept = x.sentIds.filter((id) => back.has(id)).length;
    if (kept !== x.sentIds.length) notes.push(`eventIDs kept ${kept}/${x.sentIds.length}`);
  }
  if (x.leak && x.leak.test(blob)) notes.push('FILE CONTENT LEAKED');
  const hit = !x.expect.codes.length || x.expect.codes.some((c) => codes.includes(c));
  const bad = (x.mustNot || []).filter((c) => codes.includes(c));
  if (bad.length) notes.push(`unexpected ${bad.join(', ')}`);
  // A rejection with the right outcome but a different code still enforces the rule: PASS, with the
  // code difference noted. A warning the test is about (accepted + code) must actually be raised.
  const codeOptional = x.expect.outcome !== 'accepted';
  if (!hit && codeOptional && outcome === x.expect.outcome) notes.push(`code differs from guide: expected ${x.expect.codes.join(' or ')}`);
  if (hit && x.expect.codes.length && x.expect.outcome !== 'accepted' && outcome === 'accepted') notes.push('rule raised only as a warning; every event accepted');
  const pass = outcome === x.expect.outcome && (hit || codeOptional) && !bad.length && !notes.some((n) => /kept|LEAK/.test(n));
  const actual = `${outcome}${x.upload ? ` (upload ${x.upload.status}${x.noSession ? ', no session' : x.upload.direct ? ', page blocked it; API direct' : ''}${rec.status ? `, job ${rec.status}` : ''}${events != null ? `, ${accepted}/${events} events` : ''})` : ''}`;
  return { pass, outcome, codes, actual, notes, errorMessage: rec.error_message || json(x.upload?.body)?.message || '', epcs: sum.epc_count ?? sum.estimated_epcs, estimated: json(x.upload?.body)?.estimated_epcs };
}

const browser = await chromium.launch();
try {
  const page = await signIn(browser);
  if (REJUDGE) {
    for (const x of run) if (x.requestId) x.record = await (await page.request.get(`${API}/partners/async-submissions/${x.requestId}`)).json().catch(() => null);
  }
  const phase1 = REJUDGE ? [] : run.filter((x) => !x.phase && !x.noSession);
  for (const x of phase1) await upload(page, x);
  for (const x of REJUDGE ? [] : run.filter((y) => y.noSession)) {
    const anon = await (await browser.newContext()).newPage();
    const r = await anon.request.post(`${API}/partners/uploads`, { multipart: { file: { name: path.basename(x.file), mimeType: 'application/xml', buffer: fs.readFileSync(x.file) } } });
    x.upload = { status: r.status(), body: (await r.text()).slice(0, 2000), direct: true };
    await anon.context().close();
    console.log(`${x.id.padEnd(5)} upload ${x.upload.status} (no session)`);
  }
  await Promise.all(phase1.map((x) => poll(page, x)));
  // Phase 2: re-uploads of files that must already be ingested.
  for (const x of REJUDGE ? [] : run.filter((y) => y.phase === 2)) {
    const src = T.find((y) => y.id === x.reuse);
    if (!src.file) { x.skipped = `needs ${x.reuse} in the same run`; continue; }
    x.file = src.file; x.sentIds = src.sentIds; x.bytes = src.bytes;
    await upload(page, x);
    await poll(page, x);
  }
  for (const x of run) {
    if (x.skipped) continue;
    await shootStatus(page.context(), x);
    x.verdict = judge(x);
    const { file, build, ...keep } = x;
    results.push({ ...keep, file: path.basename(file || '') });
    console.log(`${x.id.padEnd(5)} ${x.verdict.pass ? 'PASS' : 'FAIL'}  expected ${x.expect.outcome} ${x.expect.codes.join('|')}  got ${x.verdict.actual} [${x.verdict.codes.join(',')}] ${x.verdict.notes.join('; ')}`);
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(PROOF, 'results.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));

// ---------------------------------------------------------------- Jira matrix
const cell = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ');
const row = (x) => `| ${x.id} | ${x.group} | ${cell(x.title)} | ${cell(x.rule)} | ${x.expect.outcome}${x.expect.codes.length ? ` ${x.expect.codes.join(' or ')}` : ''} | ${cell(x.verdict.actual)}${x.verdict.codes.length ? `: ${x.verdict.codes.join(', ')}` : ''}${x.verdict.notes.length ? `; ${x.verdict.notes.join('; ')}` : ''} | ${x.verdict.pass ? '(/) PASS' : '(x) FAIL'} |`;
const head = '||ID||Area||Test||Rule (Technical Guides)||Expected||Actual||Status||';
const passed = results.filter((x) => x.verdict.pass);
const failed = results.filter((x) => !x.verdict.pass);
fs.writeFileSync(path.join(PROOF, 'jira-matrix.txt'), `h2. Partner portal XML upload (/partners/upload) vs EPCIS rules. Overall result: ${failed.length ? 'FAIL' : 'PASS'}

*Environment:* ${BASE}/partners/upload, partner ${PARTNER_EMAIL} (manufacturer), run ${new Date().toISOString()}
*Reference file:* SC_EP_NT_O_BXCEKSE (1).XML (SAP ATTP export, 25.8 MB, 14,949 events)

h3. Numbers
* *${results.length}* tests: *${passed.length}* PASS, *${failed.length}* FAIL

h3. Failed (${failed.length})
${head}
${failed.map(row).join('\n')}

h3. Passed (${passed.length})
${head}
${passed.map(row).join('\n')}

h3. Findings
FINDINGS
`);
console.log(`\n${passed.length} PASS, ${failed.length} FAIL -> ${path.relative(ROOT, PROOF)}`);
