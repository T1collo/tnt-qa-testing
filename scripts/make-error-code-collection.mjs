// Generates a Postman collection covering every error code in
// docs/Sheet1_Error_Code_Tests_DocsVsSystem.xlsx, so the 52 cases can be executed
// by Newman (or clicked through in the Postman GUI) against the live platform.
//
// Stateful cases are split into an explicit "setup" request followed by the assertion
// request, so the report shows the whole sequence rather than a bare result.
//
// Run: node scripts/make-error-code-collection.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'postman', 'TnT-ErrorCodes-52.postman_collection.json');

const M = '{{base_url}}/api/integration/manufacturer/events';
const F = '{{base_url}}/api/integration/facility/events';
const D = '{{base_url}}/api/integration/facility/events/dispense';
const KEY = { [M]: '{{mfg_token}}', [F]: '{{fac_token}}', [D]: '{{fac_token}}' };

const SGLN = '{{sgln}}';

// default ObjectEvent; overrides are merged, `undefined` removes a key
function objEvent(over = {}) {
  const base = {
    type: 'ObjectEvent',
    eventID: '{{eventID}}',
    eventTime: '{{now}}',
    eventTimeZoneOffset: '+03:00',
    epcList: ['{{sgtin}}'],
    action: 'ADD',
    bizStep: 'commissioning',
    disposition: 'active',
    readPoint: { id: SGLN },
    bizLocation: { id: SGLN },
  };
  const merged = { ...base, ...over };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged;
}
const epcisDoc = (events) => ({
  '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
  type: 'EPCISDocument',
  schemaVersion: '2.0',
  creationDate: '{{now}}',
  epcisBody: { eventList: Array.isArray(events) ? events : [events] },
});

// the exact event the setup request commissions, replayed from stored variables
const priorEvent = (over = {}) => objEvent({
  eventID: '{{priorEventID}}',
  eventTime: '{{priorEventTime}}',
  epcList: ['{{priorEpc}}'],
  ...over,
});

const SETUP_CAPTURE = `// stash the commissioned event so the next request can reference it.
// AggregationEvents carry childEPCs rather than epcList and must not clobber the serial.
const e = JSON.parse(pm.request.body.raw).epcisBody.eventList[0];
if (e.epcList && e.epcList.length) {
  pm.collectionVariables.set('priorEpc', e.epcList[0]);
  pm.collectionVariables.set('priorEventID', e.eventID);
  pm.collectionVariables.set('priorEventTime', e.eventTime);
}
pm.test('setup accepted', () => pm.expect(pm.response.code).to.be.oneOf([200, 201, 202]));`;

function assertion(id, expCode, kind, docStatus) {
  return `// ${id} - documented: ${docStatus} / ${expCode}
let codes = [], body = {};
try { body = pm.response.json(); } catch (e) { /* non-JSON error body */ }
if (body.code) codes.push(body.code);
for (const k of ['errors', 'warnings', 'violations']) {
  for (const it of (body[k] || [])) if (it.code) codes.push(it.code);
}
codes = [...new Set(codes)];
pm.collectionVariables.set('lastCodes', codes.join(', ') || '(none)');

pm.test('${id} | returns documented code ${expCode}', function () {
  pm.expect(codes, 'codes in response: [' + codes.join(', ') + ']').to.include('${expCode}');
});
pm.test('${id} | documented HTTP ${docStatus} (actual ' + pm.response.code + ')', function () {
  ${kind === 'reject'
    ? `pm.expect(pm.response.code).to.eql(400);`
    : `pm.expect(pm.response.code, 'event should be accepted and stored').to.be.oneOf([200, 201, 202]);`}
});`;
}

const items = [];
let setupCount = 0;

function addSetup(label, url, body) {
  setupCount++;
  items.push({
    name: `    ↳ setup · ${label}`,
    request: {
      method: 'POST',
      header: [
        { key: 'Content-Type', value: 'application/ld+json' },
        { key: 'X-API-Key', value: KEY[url] },
      ],
      url: { raw: url, host: [url] },
      body: { mode: 'raw', raw: JSON.stringify(body, null, 2) },
    },
    event: [{ listen: 'test', script: { type: 'text/javascript', exec: SETUP_CAPTURE.split('\n') } }],
  });
}

function addCase({ id, title, expCode, kind, docStatus, url, body, contentType, pre, setups = [] }) {
  for (const s of setups) addSetup(s.label, s.url, s.body);
  items.push({
    name: `${id} · ${expCode}${title ? ` — ${title}` : ''}`,
    request: {
      method: 'POST',
      header: [
        { key: 'Content-Type', value: contentType || 'application/ld+json' },
        { key: 'X-API-Key', value: KEY[url] },
      ],
      url: { raw: url, host: [url] },
      body: { mode: 'raw', raw: typeof body === 'string' ? body : JSON.stringify(body, null, 2) },
      description: `Documented expectation: HTTP ${docStatus}, error.code = ${expCode}\nSheet reference: docs/Sheet1_Error_Code_Tests_DocsVsSystem.xlsx`,
    },
    event: [
      ...(pre ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: pre.split('\n') } }] : []),
      { listen: 'test', script: { type: 'text/javascript', exec: assertion(id, expCode, kind, docStatus).split('\n') } },
    ],
  });
}

const COMMISSION = epcisDoc(objEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-{{lot4}}' } }));
const commissionSetup = (label = 'commission a fresh serial') => ({ label, url: M, body: COMMISSION });

// ---------------------------------------------------------------- 6.1.1 hard rejects
addCase({ id: 'TC-S1-001', expCode: 'INVALID_XML_STRUCTURE', kind: 'reject', docStatus: '400', url: M,
  contentType: 'application/xml', title: 'unclosed tag',
  body: '<epcisDocument><EPCISBody><EventList><ObjectEvent><unclosed></EventList></epcisDocument' });

addCase({ id: 'TC-S1-002', expCode: 'INVALID_JSON_STRUCTURE', kind: 'reject', docStatus: '400', url: M,
  title: 'JSON-LD missing @context',
  body: { epcisBody: { eventList: [{}] } } });

addCase({ id: 'TC-S1-003', expCode: 'MISSING_EPCIS_BODY', kind: 'reject', docStatus: '400', url: M,
  title: 'epcisBody absent',
  body: { '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'], type: 'EPCISDocument', schemaVersion: '2.0', creationDate: '{{now}}' } });

addCase({ id: 'TC-S1-004', expCode: 'MISSING_EVENT_LIST', kind: 'reject', docStatus: '400', url: M,
  title: 'eventList is a string',
  body: { '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'], type: 'EPCISDocument', schemaVersion: '2.0', epcisBody: { eventList: 'not-an-array' } } });

addCase({ id: 'TC-S1-005', expCode: 'INVALID_SBDH', kind: 'reject', docStatus: '400', url: M,
  contentType: 'application/xml', title: 'SBDH with empty StandardVersion',
  body: '<?xml version="1.0"?><StandardBusinessDocument><StandardBusinessDocumentHeader><StandardVersion/></StandardBusinessDocumentHeader></StandardBusinessDocument>' });

addCase({ id: 'TC-S1-006', expCode: 'MESSAGE_SIZE_EXCEEDED', kind: 'reject', docStatus: '400', url: D,
  title: 'sync dispense over the 1 MB cap',
  pre: "pm.variables.set('pad', 'X'.repeat(1200000));",
  body: epcisDoc(objEvent({ action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed', ilmd: { 'cbvmda:lotNumber': 'L1', 'cbvmda:pad': '{{pad}}' } })) });

addCase({ id: 'TC-S1-007', expCode: 'TOO_MANY_SERIALS', kind: 'reject', docStatus: '400', url: M,
  title: '50001 serials (cap is 50000)',
  pre: `const list = [];
for (let i = 0; i < 50001; i++) list.push('urn:epc:id:sgtin:0614141.000111.' + String(i).padStart(7, '0'));
pm.variables.set('bigEpcList', JSON.stringify(list));`,
  body: `{"@context":["https://ref.gs1.org/standards/epcis/epcis-context.jsonld"],"type":"EPCISDocument","schemaVersion":"2.0","creationDate":"{{now}}","epcisBody":{"eventList":[{"type":"ObjectEvent","eventID":"{{eventID}}","eventTime":"{{now}}","eventTimeZoneOffset":"+03:00","epcList":{{bigEpcList}},"action":"ADD","bizStep":"commissioning","disposition":"active","readPoint":{"id":"{{sgln}}"},"bizLocation":{"id":"{{sgln}}"}}]}}` });

addCase({ id: 'TC-S1-008', expCode: 'INVALID_EXPIRY_FORMAT', kind: 'reject', docStatus: '400', url: M,
  title: 'expiry as MM/YYYY',
  body: epcisDoc(objEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-{{lot4}}', 'cbvmda:itemExpirationDate': '06/2027' } })) });

addCase({ id: 'TC-S1-009', expCode: 'INVALID_GS1_IDENTIFIER', kind: 'reject', docStatus: '400', url: M,
  title: 'SGTIN digit count != 13',
  body: epcisDoc(objEvent({ epcList: ['urn:epc:id:sgtin:ABCDEFG.XXXXXX.{{serial6}}'] })) });

addCase({ id: 'TC-S1-010', expCode: 'FUTURE_EVENT_TIME', kind: 'reject', docStatus: '400', url: M,
  title: 'eventTime +10 minutes',
  body: epcisDoc(objEvent({ eventTime: '{{future}}' })) });

addCase({ id: 'TC-S1-011', expCode: 'MISSING_NEEDED_FIELDS', kind: 'reject', docStatus: '400', url: M,
  title: 'bizStep omitted',
  body: epcisDoc(objEvent({ bizStep: undefined })) });

addCase({ id: 'TC-S1-012', expCode: 'DUPLICATE_EVENT_ID', kind: 'reject', docStatus: '400', url: M,
  title: 'same eventID submitted twice',
  setups: [{ label: 'first submission of this eventID', url: M, body: epcisDoc(objEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-{{lot4}}' } })) }],
  body: epcisDoc(priorEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-DUPE' } })) });

addCase({ id: 'TC-S1-013', expCode: 'DUPLICATE_EVENT_PAYLOAD', kind: 'reject', docStatus: '400', url: M,
  title: 'identical content, new eventID',
  setups: [commissionSetup('original event')],
  body: epcisDoc(priorEvent({ eventID: '{{eventID}}' })) });

addCase({ id: 'TC-S1-014', expCode: 'DUPLICATE_EPC_IN_EVENT', kind: 'reject', docStatus: '400', url: M,
  title: 'same EPC twice in epcList',
  body: epcisDoc(objEvent({ epcList: ['{{sgtin}}', '{{sgtin}}'] })) });

addCase({ id: 'TC-S1-015', expCode: 'IMPOSSIBLE_SENSOR_VALUES', kind: 'reject', docStatus: '400', url: M,
  title: 'min 30 > max 10',
  body: epcisDoc(objEvent({ sensorElementList: [{ sensorReport: [{ type: 'gs1:Temperature', minValue: 30, maxValue: 10, meanValue: 20, uom: 'CEL' }] }] })) });

addCase({ id: 'TC-S1-016', expCode: 'ERROR_DECLARATION_BEFORE_EVENT', kind: 'reject', docStatus: '400', url: M,
  title: 'declarationTime 1h before eventTime',
  setups: [commissionSetup()],
  pre: "pm.variables.set('beforeEvent', new Date(Date.parse(pm.collectionVariables.get('priorEventTime')) - 3600000).toISOString());",
  body: epcisDoc(priorEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-{{lot4}}' }, errorDeclaration: { declarationTime: '{{beforeEvent}}', reason: 'urn:epcglobal:cbv:er:did_not_occur' } })) });

addCase({ id: 'TC-S1-017', expCode: 'ERROR_DECLARATION_ORIGINAL_NOT_FOUND', kind: 'reject', docStatus: '400', url: M,
  title: 'declaration against unknown eventID',
  body: epcisDoc(objEvent({ errorDeclaration: { declarationTime: '{{now}}', reason: 'urn:epcglobal:cbv:er:did_not_occur' } })) });

addCase({ id: 'TC-S1-018', expCode: 'ERROR_DECLARATION_CONTENT_MISMATCH', kind: 'reject', docStatus: '400', url: M,
  title: 'epcList changed on resubmit',
  setups: [commissionSetup()],
  body: epcisDoc(priorEvent({ epcList: ['{{sgtin}}'], ilmd: { 'cbvmda:lotNumber': 'LOT-{{lot4}}' }, errorDeclaration: { declarationTime: '{{now}}', reason: 'urn:epcglobal:cbv:er:did_not_occur' } })) });

addCase({ id: 'TC-S1-019', expCode: 'ERROR_DECLARATION_INVALID_REASON', kind: 'reject', docStatus: '400', url: M,
  title: 'reason outside CBV vocabulary',
  setups: [commissionSetup()],
  body: epcisDoc(priorEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-{{lot4}}' }, errorDeclaration: { declarationTime: '{{now}}', reason: 'user_cancelled' } })) });

addCase({ id: 'TC-S1-020', expCode: 'ERROR_DECLARATION_CORRECTIVE_NOT_FOUND', kind: 'reject', docStatus: '400', url: M,
  title: 'correctiveEventIDs points at nothing',
  setups: [commissionSetup()],
  body: epcisDoc(priorEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-{{lot4}}' }, errorDeclaration: { declarationTime: '{{now}}', reason: 'urn:epcglobal:cbv:er:incorrect_data', correctiveEventIDs: ['urn:uuid:00000000-0000-4000-8000-000000000999'] } })) });

addCase({ id: 'TC-S1-021', expCode: 'UNKNOWN_SGTIN', kind: 'reject', docStatus: '400', url: F,
  title: 'uncommissioned serial observed',
  body: epcisDoc(objEvent({ action: 'OBSERVE', bizStep: 'receiving', disposition: 'in_progress' })) });

addCase({ id: 'TC-S1-022', expCode: 'UNKNOWN_SGLN', kind: 'reject', docStatus: '400', url: M,
  title: 'location not in registry',
  body: epcisDoc(objEvent({ readPoint: { id: 'urn:epc:id:sgln:0614141.99999.0' }, bizLocation: { id: 'urn:epc:id:sgln:0614141.99999.0' } })) });

addCase({ id: 'TC-S1-023', expCode: 'INACTIVE_SGLN', kind: 'reject', docStatus: '400', url: M,
  title: 'registered but inactive location (needs fixture)',
  body: epcisDoc(objEvent({ readPoint: { id: '{{sglnB}}' }, bizLocation: { id: '{{sglnB}}' } })) });

addCase({ id: 'TC-S1-024', expCode: 'INVALID_GTIN_CHECK_DIGIT', kind: 'reject', docStatus: '400', url: M,
  title: 'GTIN Mod-10 failure',
  body: epcisDoc(objEvent({ epcList: ['urn:epc:id:sgtin:616110297499{{digit1}}.CW{{lot4}}'] })) });

addCase({ id: 'TC-S1-025', expCode: 'INVALID_GLN_CHECK_DIGIT', kind: 'reject', docStatus: '400', url: M,
  title: 'GLN check digit failure',
  body: epcisDoc(objEvent({ readPoint: { id: 'urn:epc:id:sgln:8888888.888888' }, bizLocation: { id: 'urn:epc:id:sgln:8888888.888888' } })) });

addCase({ id: 'TC-S1-026', expCode: 'INVALID_SSCC_CHECK_DIGIT', kind: 'reject', docStatus: '400', url: M,
  title: 'SSCC check digit failure',
  body: epcisDoc(objEvent({ type: 'AggregationEvent', action: 'ADD', bizStep: 'packing', disposition: 'in_progress', parentID: 'urn:epc:id:sscc:0614141.000000001', childEPCs: ['{{sgtin}}'], epcList: undefined })) });

// ---------------------------------------------------------------- 6.1.2 advisory warnings
addCase({ id: 'TC-S1-027', expCode: 'INVALID_LOT', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'lot not registered under GTIN',
  body: epcisDoc(objEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-UNKNOWN-999' } })) });

addCase({ id: 'TC-S1-028', expCode: 'INVENTORY_SIGHTING_MISMATCH', kind: 'warn', docStatus: '201 + warning', url: F,
  title: 'sighted at a different location',
  setups: [commissionSetup('commission at location A')],
  body: epcisDoc(objEvent({ epcList: ['{{priorEpc}}'], action: 'OBSERVE', bizStep: 'inspecting', disposition: 'active', readPoint: { id: '{{sglnB}}' }, bizLocation: { id: '{{sglnB}}' } })) });

addCase({ id: 'TC-S1-029', expCode: 'NO_REGULATORY_APPROVAL', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'shipping without PPB approval',
  setups: [commissionSetup()],
  body: epcisDoc(objEvent({ epcList: ['{{priorEpc}}'], action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit' })) });

addCase({ id: 'TC-S1-030', expCode: 'UNAUTHORIZED_INSPECTING_EVENT', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'inspecting from a non-regulatory actor',
  body: epcisDoc(objEvent({ action: 'OBSERVE', bizStep: 'inspecting', disposition: 'active' })) });

addCase({ id: 'TC-S1-031', expCode: 'EXPIRING_SOON', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'expiry in 45 days',
  body: epcisDoc(objEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-{{lot4}}', 'cbvmda:itemExpirationDate': '{{expSoon}}' } })) });

addCase({ id: 'TC-S1-032', expCode: 'SERIAL_ALREADY_DISPENSED', kind: 'warn', docStatus: '201 + warning', url: F,
  title: 'event on an already-dispensed serial',
  setups: [
    commissionSetup(),
    { label: 'dispense that serial', url: D, body: epcisDoc(objEvent({ epcList: ['{{priorEpc}}'], eventID: '{{eventID}}', action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed' })) },
  ],
  body: epcisDoc(objEvent({ epcList: ['{{priorEpc}}'], action: 'OBSERVE', bizStep: 'inspecting', disposition: 'active' })) });

addCase({ id: 'TC-S1-033', expCode: 'SERIAL_ALREADY_DESTROYED', kind: 'warn', docStatus: '201 + warning', url: F,
  title: 'event on a destroyed serial',
  setups: [
    commissionSetup(),
    { label: 'destroy that serial', url: F, body: epcisDoc(objEvent({ epcList: ['{{priorEpc}}'], eventID: '{{eventID}}', action: 'DELETE', bizStep: 'destroying', disposition: 'destroyed' })) },
  ],
  body: epcisDoc(objEvent({ epcList: ['{{priorEpc}}'], action: 'OBSERVE', bizStep: 'inspecting', disposition: 'active' })) });

addCase({ id: 'TC-S1-034', expCode: 'INVALID_DISPOSITION', kind: 'warn', docStatus: '201 + warning', url: F,
  title: 'illegal dispensed -> active transition',
  setups: [
    commissionSetup(),
    { label: 'dispense that serial', url: D, body: epcisDoc(objEvent({ epcList: ['{{priorEpc}}'], eventID: '{{eventID}}', action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed' })) },
  ],
  body: epcisDoc(objEvent({ epcList: ['{{priorEpc}}'], action: 'OBSERVE', bizStep: 'inspecting', disposition: 'active' })) });

addCase({ id: 'TC-S1-035', expCode: 'INVALID_BIZSTEP', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'bizStep outside the CBV vocabulary',
  body: epcisDoc(objEvent({ bizStep: 'unknown_bizstep_xyz' })) });

addCase({ id: 'TC-S1-036', expCode: 'INVALID_TERMINAL_STATE', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'lifecycle action on a terminal serial',
  setups: [
    commissionSetup(),
    { label: 'destroy that serial', url: F, body: epcisDoc(objEvent({ epcList: ['{{priorEpc}}'], eventID: '{{eventID}}', action: 'DELETE', bizStep: 'destroying', disposition: 'destroyed' })) },
  ],
  body: epcisDoc(objEvent({ epcList: ['{{priorEpc}}'], action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit' })) });

addCase({ id: 'TC-S1-037', expCode: 'INVALID_PARENT_CHILD_RELATION', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'SSCC nested under SSCC',
  body: epcisDoc(objEvent({ type: 'AggregationEvent', action: 'ADD', bizStep: 'packing', disposition: 'in_progress', parentID: '{{sscc}}', childEPCs: ['{{sscc2}}'], epcList: undefined })) });

addCase({ id: 'TC-S1-038', expCode: 'PARENT_NOT_FOUND', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'ADD against an unknown parent SSCC',
  body: epcisDoc(objEvent({ type: 'AggregationEvent', action: 'ADD', bizStep: 'packing', disposition: 'in_progress', parentID: '{{sscc}}', childEPCs: ['{{sgtin}}'], epcList: undefined })) });

addCase({ id: 'TC-S1-039', expCode: 'CHILD_ALREADY_AGGREGATED', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'child re-aggregated under a second SSCC',
  setups: [
    commissionSetup(),
    { label: 'aggregate under SSCC-A', url: M, body: epcisDoc(objEvent({ type: 'AggregationEvent', eventID: '{{eventID}}', action: 'ADD', bizStep: 'packing', disposition: 'in_progress', parentID: '{{sscc}}', childEPCs: ['{{priorEpc}}'], epcList: undefined })) },
  ],
  body: epcisDoc(objEvent({ type: 'AggregationEvent', action: 'ADD', bizStep: 'packing', disposition: 'in_progress', parentID: '{{sscc2}}', childEPCs: ['{{priorEpc}}'], epcList: undefined })) });

addCase({ id: 'TC-S1-040', expCode: 'INVALID_EVENT_SEQUENCE', kind: 'warn', docStatus: '201 + warning', url: F,
  title: 'receiving before any shipping',
  setups: [commissionSetup()],
  body: epcisDoc(objEvent({ epcList: ['{{priorEpc}}'], action: 'OBSERVE', bizStep: 'receiving', disposition: 'in_progress' })) });

addCase({ id: 'TC-S1-041', expCode: 'SSCC_AT_DISPENSING', kind: 'warn', docStatus: '201 + warning', url: D,
  title: 'SSCC used in a dispensing event',
  body: epcisDoc(objEvent({ action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed', epcList: ['{{sscc}}'] })) });

addCase({ id: 'TC-S1-042', expCode: 'EXPIRED_PRODUCT', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'expiry in the past',
  body: epcisDoc(objEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-{{lot4}}', 'cbvmda:itemExpirationDate': '{{expPast}}' } })) });

addCase({ id: 'TC-S1-043', expCode: 'RECALL_ACTIVE', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'product under active recall (needs fixture)',
  body: epcisDoc(objEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-{{lot4}}' } })) });

addCase({ id: 'TC-S1-044', expCode: 'RECEIVING_WITHOUT_SHIPPING', kind: 'warn', docStatus: '201 + warning', url: F,
  title: 'receiving with no prior shipping',
  setups: [commissionSetup()],
  body: epcisDoc(objEvent({ epcList: ['{{priorEpc}}'], action: 'OBSERVE', bizStep: 'receiving', disposition: 'in_progress' })) });

addCase({ id: 'TC-S1-045', expCode: 'UNPACK_WITHOUT_AGGREGATION', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'unpack with no prior pack',
  body: epcisDoc(objEvent({ type: 'AggregationEvent', action: 'DELETE', bizStep: 'unpacking', disposition: 'in_progress', parentID: '{{sscc}}', childEPCs: ['{{sgtin}}'], epcList: undefined })) });

addCase({ id: 'TC-S1-046', expCode: 'STALE_EVENT_TIME', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'eventTime 8 days old',
  body: epcisDoc(objEvent({ eventTime: '{{stale}}' })) });

addCase({ id: 'TC-S1-047', expCode: 'UNCOMMISSIONED_CHILD', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'aggregating uncommissioned children',
  body: epcisDoc(objEvent({ type: 'AggregationEvent', action: 'ADD', bizStep: 'packing', disposition: 'in_progress', parentID: '{{sscc}}', childEPCs: ['{{sgtin}}', '{{sgtin2}}'], epcList: undefined })) });

addCase({ id: 'TC-S1-048', expCode: 'SHIPPING_WITHOUT_COMMISSIONING', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'shipping a never-commissioned serial',
  body: epcisDoc(objEvent({ action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit' })) });

addCase({ id: 'TC-S1-049', expCode: 'DUPLICATE_SSCC_IN_MESSAGE', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'same parent SSCC twice in one document',
  body: epcisDoc([
    objEvent({ type: 'AggregationEvent', action: 'ADD', bizStep: 'packing', disposition: 'in_progress', parentID: '{{sscc}}', childEPCs: ['{{sgtin}}'], epcList: undefined }),
    objEvent({ type: 'AggregationEvent', eventID: '{{eventID2}}', action: 'ADD', bizStep: 'packing', disposition: 'in_progress', parentID: '{{sscc}}', childEPCs: ['{{sgtin2}}'], epcList: undefined }),
  ]) });

addCase({ id: 'TC-S1-050', expCode: 'DUPLICATE_SSCC_CROSS_MESSAGE', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'SSCC re-introduced as parent in a later message',
  setups: [{ label: 'pack SSCC-X', url: M, body: epcisDoc(objEvent({ type: 'AggregationEvent', action: 'ADD', bizStep: 'packing', disposition: 'in_progress', parentID: '{{ssccShared}}', childEPCs: ['{{sgtin}}'], epcList: undefined })) }],
  body: epcisDoc(objEvent({ type: 'AggregationEvent', action: 'ADD', bizStep: 'packing', disposition: 'in_progress', parentID: '{{ssccShared}}', childEPCs: ['{{sgtin2}}'], epcList: undefined })) });

addCase({ id: 'TC-S1-051', expCode: 'INCOMPLETE_ERROR_DECLARATION', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'incorrect_data with no correctiveEventIDs',
  setups: [commissionSetup()],
  body: epcisDoc(priorEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-{{lot4}}' }, errorDeclaration: { declarationTime: '{{now}}', reason: 'urn:epcglobal:cbv:er:incorrect_data', correctiveEventIDs: [] } })) });

addCase({ id: 'TC-S1-052', expCode: 'ERROR_DECLARATION_WITHOUT_REASON', kind: 'warn', docStatus: '201 + warning', url: M,
  title: 'declarationTime present, reason absent',
  setups: [commissionSetup()],
  body: epcisDoc(priorEvent({ ilmd: { 'cbvmda:lotNumber': 'LOT-{{lot4}}' }, errorDeclaration: { declarationTime: '{{now}}' } })) });

// ---------------------------------------------------------------- collection shell
const COLLECTION_PRE = `// fresh identifiers for every request so nothing trips the duplicate matrix
const d = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const uuid = () => 'urn:uuid:' + pm.variables.replaceIn('{{$randomUUID}}');
pm.variables.set('eventID', uuid());
pm.variables.set('eventID2', uuid());
pm.variables.set('now', new Date().toISOString());
pm.variables.set('sgtin', 'urn:epc:id:sgtin:0614141.000111.' + d(7));
pm.variables.set('sgtin2', 'urn:epc:id:sgtin:0614141.000111.' + d(7));
pm.variables.set('sscc', 'urn:epc:id:sscc:0614141.' + d(10));
pm.variables.set('sscc2', 'urn:epc:id:sscc:0614141.' + d(10));
pm.variables.set('sgln', 'urn:epc:id:sgln:0614141.00001.0');
pm.variables.set('sglnB', 'urn:epc:id:sgln:0619999.00002.0');
pm.variables.set('serial6', d(6));
pm.variables.set('lot4', d(4));
pm.variables.set('digit1', d(1));
pm.variables.set('future', new Date(Date.now() + 10 * 60000).toISOString());
pm.variables.set('stale', new Date(Date.now() - 8 * 86400000).toISOString());
pm.variables.set('expSoon', new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10));
pm.variables.set('expPast', new Date(Date.now() - 86400000).toISOString().slice(0, 10));
if (!pm.collectionVariables.get('ssccShared')) {
  pm.collectionVariables.set('ssccShared', 'urn:epc:id:sscc:0614141.' + d(10));
}`;

const collection = {
  info: {
    name: 'TnT — Error Code Conformance (52 cases)',
    description: 'Every error code in Sheet1_Error_Code_Tests_DocsVsSystem.xlsx, executed against the live platform.\n\nTokens are supplied at run time (never stored here):\n\n  npx newman run postman/TnT-ErrorCodes-52.postman_collection.json \\\n    --env-var base_url=$API_BASE_URL \\\n    --env-var mfg_token=$MANUFACTURER_API_TOKEN \\\n    --env-var fac_token=$FACILITY_API_TOKEN \\\n    --delay-request 1500\n\nRequests prefixed "↳ setup" establish state for the case that follows; their failures are not conformance findings.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: items,
  event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: COLLECTION_PRE.split('\n') } }],
  variable: [
    { key: 'base_url', value: 'https://tnt-demo.apeiro-digital.com' },
    { key: 'mfg_token', value: '' },
    { key: 'fac_token', value: '' },
  ],
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(collection, null, 2));
const cases = items.filter((i) => !i.name.startsWith('    ↳')).length;
console.log(`${OUT}\n  ${cases} test cases + ${setupCount} setup requests = ${items.length} requests`);
