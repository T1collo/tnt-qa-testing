// Builds original EPCIS 1.2 XML fixtures for Manufacturer Partner Portal Upload
// (/partners/upload). Fresh UUIDs/serials every run. Does not copy the SAP sample.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const OUT = path.join(import.meta.dirname, '..', '..', 'Proof', 'xml', 'bodies');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, f));

const stamp = Date.now().toString().slice(-10);
let n = 0;
const uuid = () => randomUUID();
const digits = (len) => {
  let s = '';
  while (s.length < len) s += Math.floor(Math.random() * 10);
  return s.slice(0, len);
};
// Numeric serials only — alphanumeric SGTINs are fine, but keep fixtures boring.
const serial = () => `${stamp}${String(++n).padStart(5, '0')}${digits(2)}`;
const sgtin = (s = serial()) => `urn:epc:id:sgtin:0614141.107346.${s}`;
// 7-digit company prefix needs exactly 10-digit serial reference (extension + serial).
const sscc = () => `urn:epc:id:sscc:0614141.${digits(10)}`;
const sgln = (loc = '00001') => `urn:epc:id:sgln:0614141.${loc}.0`;
const past = (mins = 10) => new Date(Date.now() - mins * 60_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
const daysAgo = (d) => new Date(Date.now() - d * 86400_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
const future = (mins = 30) => new Date(Date.now() + mins * 60_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');

function doc(eventsXml, { creationDate = past(1), sbdh = null } = {}) {
  if (sbdh) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<StandardBusinessDocument xmlns="http://www.unece.org/cefact/namespaces/StandardBusinessDocumentHeader">
  <StandardBusinessDocumentHeader>
    <HeaderVersion>1.3</HeaderVersion>
    <Sender><Identifier Authority="GS1">0614141000010</Identifier></Sender>
    <Receiver><Identifier Authority="GS1">0619999000020</Identifier></Receiver>
    <DocumentIdentification>
      <Standard>EPCglobal</Standard>
      <TypeVersion></TypeVersion>
      <InstanceIdentifier>QA-SBDH-${stamp}</InstanceIdentifier>
      <Type>EPCISDocument</Type>
      <CreationDateAndTime>${creationDate}</CreationDateAndTime>
    </DocumentIdentification>
  </StandardBusinessDocumentHeader>
  <epcis:EPCISDocument xmlns:epcis="urn:epcglobal:epcis:xsd:1" xmlns:cbvmda="urn:epcglobal:cbv:mda" schemaVersion="1.2" creationDate="${creationDate}">
    <EPCISBody><EventList>
${eventsXml}
    </EventList></EPCISBody>
  </epcis:EPCISDocument>
</StandardBusinessDocument>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<epcis:EPCISDocument xmlns:epcis="urn:epcglobal:epcis:xsd:1" xmlns:cbvmda="urn:epcglobal:cbv:mda" schemaVersion="1.2" creationDate="${creationDate}">
  <EPCISBody><EventList>
${eventsXml}
  </EventList></EPCISBody>
</epcis:EPCISDocument>`;
}

function objectEvent({
  eventID = `urn:uuid:${uuid()}`,
  eventTime = past(8),
  epcs,
  action = 'ADD',
  bizStep,
  disposition,
  readPoint = sgln(),
  bizLocation = sgln(),
  lotNumber,
  expiry,
  bizTransactions,
  sources,
  destinations,
  quantityList,
  omit = [],
} = {}) {
  const lines = ['    <ObjectEvent>'];
  if (!omit.includes('eventID')) lines.push(`      <eventID>${eventID}</eventID>`);
  if (!omit.includes('eventTime')) lines.push(`      <eventTime>${eventTime}</eventTime>`);
  if (!omit.includes('tz')) lines.push('      <eventTimeZoneOffset>+03:00</eventTimeZoneOffset>');
  if (!omit.includes('epcList') && !quantityList) {
    lines.push('      <epcList>');
    for (const e of epcs || [sgtin()]) lines.push(`        <epc>${e}</epc>`);
    lines.push('      </epcList>');
  }
  if (!omit.includes('action')) lines.push(`      <action>${action}</action>`);
  if (bizStep && !omit.includes('bizStep')) lines.push(`      <bizStep>urn:epcglobal:cbv:bizstep:${bizStep}</bizStep>`);
  if (disposition && !omit.includes('disposition')) lines.push(`      <disposition>urn:epcglobal:cbv:disp:${disposition}</disposition>`);
  if (!omit.includes('readPoint')) lines.push(`      <readPoint><id>${readPoint}</id></readPoint>`);
  if (!omit.includes('bizLocation')) lines.push(`      <bizLocation><id>${bizLocation}</id></bizLocation>`);
  if (bizTransactions?.length) {
    lines.push('      <bizTransactionList>');
    for (const b of bizTransactions) {
      lines.push(`        <bizTransaction type="urn:epcglobal:cbv:btt:${b.type}">${b.id}</bizTransaction>`);
    }
    lines.push('      </bizTransactionList>');
  }
  const ext = [];
  if (quantityList?.length) {
    ext.push(`<quantityList>${quantityList.map((q) => `<quantityElement><epcClass>${q.epcClass}</epcClass><quantity>${q.quantity}</quantity>${q.uom ? `<uom>${q.uom}</uom>` : ''}</quantityElement>`).join('')}</quantityList>`);
  }
  if (sources?.length) {
    ext.push(`<sourceList>${sources.map((s) => `<source type="urn:epcglobal:cbv:sdt:${s.type}">${s.id}</source>`).join('')}</sourceList>`);
  }
  if (destinations?.length) {
    ext.push(`<destinationList>${destinations.map((d) => `<destination type="urn:epcglobal:cbv:sdt:${d.type}">${d.id}</destination>`).join('')}</destinationList>`);
  }
  if (lotNumber || expiry) {
    let ilmd = '<ilmd>';
    if (lotNumber) ilmd += `<cbvmda:lotNumber>${lotNumber}</cbvmda:lotNumber>`;
    if (expiry) ilmd += `<cbvmda:itemExpirationDate>${expiry}</cbvmda:itemExpirationDate>`;
    ilmd += '</ilmd>';
    ext.push(ilmd);
  }
  if (ext.length) lines.push(`      <extension>${ext.join('')}</extension>`);
  lines.push('    </ObjectEvent>');
  return { xml: lines.join('\n'), eventID, epcs };
}

function aggEvent({
  eventID = `urn:uuid:${uuid()}`,
  eventTime = past(7),
  parentID,
  children,
  action = 'ADD',
  bizStep = 'packing',
  disposition = 'active',
} = {}) {
  const kids = children || [sgtin(), sgtin()];
  const xml = `    <AggregationEvent>
      <eventID>${eventID}</eventID>
      <eventTime>${eventTime}</eventTime>
      <eventTimeZoneOffset>+03:00</eventTimeZoneOffset>
      <parentID>${parentID || sscc()}</parentID>
      <childEPCs>
${kids.map((e) => `        <epc>${e}</epc>`).join('\n')}
      </childEPCs>
      <action>${action}</action>
      <bizStep>urn:epcglobal:cbv:bizstep:${bizStep}</bizStep>
      <disposition>urn:epcglobal:cbv:disp:${disposition}</disposition>
      <readPoint><id>${sgln()}</id></readPoint>
      <bizLocation><id>${sgln()}</id></bizLocation>
    </AggregationEvent>`;
  return { xml, eventID, parentID, children: kids };
}

const cases = [];
function add(shot, title, expected, body, meta = {}) {
  const file = `${shot}.xml`;
  fs.writeFileSync(path.join(OUT, file), body);
  cases.push({ shot, title, expected, file, ...meta });
}

// ---- Manufacturer event happy paths ----
{
  const a = objectEvent({ bizStep: 'commissioning', disposition: 'active', action: 'ADD', lotNumber: `LOT${stamp}01`, expiry: '2028-12-31', epcs: [sgtin(), sgtin()] });
  add('E01', 'Commissioning', '202 accepted; job succeeds (master-data warnings OK)', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const kids = [sgtin(), sgtin()];
  const parent = sscc();
  const a = aggEvent({ parentID: parent, children: kids, bizStep: 'packing', action: 'ADD' });
  add('E02', 'Packing', '202 accepted; job succeeds (PARENT_NOT_FOUND / UNCOMMISSIONED_CHILD flags OK)', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const parent = sscc();
  const kids = [sscc(), sscc(), sscc()];
  const a = aggEvent({ parentID: parent, children: kids, bizStep: 'packing', action: 'ADD' });
  add('E03', 'SSCC-to-SSCC Packing', '202 accepted; job succeeds with aggregation flags OK', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const a = objectEvent({
    bizStep: 'shipping', disposition: 'in_transit', action: 'OBSERVE', epcs: [sscc()],
    bizTransactions: [{ type: 'desadv', id: `urn:epcglobal:cbv:bt:0614141:ASN${stamp}` }],
    sources: [{ type: 'owning_party', id: sgln() }, { type: 'location', id: sgln() }],
    destinations: [{ type: 'owning_party', id: sgln('22222') }, { type: 'location', id: sgln('22222') }],
  });
  add('E04', 'Shipping', '202 accepted; job succeeds (SHIPPING_WITHOUT_COMMISSIONING / NO_REGULATORY_APPROVAL OK)', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const a = objectEvent({
    bizStep: 'inspecting', disposition: 'active', action: 'OBSERVE', epcs: [sgtin(), sgtin()],
    bizTransactions: [{ type: 'cert', id: `urn:epcglobal:cbv:bt:0614141:CERT${stamp}` }],
  });
  add('E05', 'Regulator Approval', '202 accepted; UNAUTHORIZED_INSPECTING_EVENT warning expected for partner', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const a = objectEvent({
    bizStep: 'shipping', disposition: 'returned', action: 'OBSERVE', epcs: [sscc()],
    bizTransactions: [{ type: 'desadv', id: `urn:epcglobal:cbv:bt:0614141:RET${stamp}` }],
    sources: [{ type: 'owning_party', id: sgln('22222') }, { type: 'location', id: sgln('22222') }],
    destinations: [{ type: 'owning_party', id: sgln() }, { type: 'location', id: sgln() }],
  });
  add('E06', 'Return Shipping', '202 accepted; job succeeds with disposition/sequence flags OK', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const a = objectEvent({
    bizStep: 'receiving', disposition: 'returned', action: 'OBSERVE', epcs: [sscc()],
    bizTransactions: [{ type: 'recadv', id: `urn:epcglobal:cbv:bt:0614141:GR${stamp}` }],
    sources: [{ type: 'owning_party', id: sgln('22222') }, { type: 'location', id: sgln('22222') }],
    destinations: [{ type: 'owning_party', id: sgln() }, { type: 'location', id: sgln() }],
  });
  add('E07', 'Return Receiving', '202 accepted; job succeeds with receiving flags OK', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const a = objectEvent({
    bizStep: 'holding', disposition: 'recalled', action: 'OBSERVE',
    quantityList: [{ epcClass: `urn:epc:class:lgtin:0614141.107346.LOT${stamp}`, quantity: 10, uom: 'EA' }],
  });
  add('E08', 'Recall Initiation (holding)', 'Role mismatch or rejected/failed — holding not on manufacturer allow-list', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const a = objectEvent({ bizStep: 'inspecting', disposition: 'damaged', action: 'OBSERVE', epcs: [sgtin()] });
  add('E09', 'Damaged', '202 accepted; UNAUTHORIZED_INSPECTING_EVENT and/or INVALID_DISPOSITION flags OK', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const a = objectEvent({ bizStep: 'decommissioning', disposition: 'stolen', action: 'OBSERVE', epcs: [sgtin()] });
  add('E10', 'Stolen', '202 accepted; job succeeds with disposition flags OK', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const a = objectEvent({ bizStep: 'decommissioning', disposition: 'inactive', action: 'OBSERVE', epcs: [sgtin()] });
  add('E11', 'Lost', '202 accepted; job succeeds with disposition flags OK', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const a = objectEvent({ bizStep: 'inspecting', disposition: 'expired', action: 'OBSERVE', epcs: [sgtin(), sgtin()] });
  add('E12', 'Expired', '202 accepted; inspecting/expired flags OK', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const a = objectEvent({
    bizStep: 'destroying', disposition: 'destroyed', action: 'OBSERVE',
    epcs: [sgtin(), sgtin(), sgtin()],
  });
  add('E13', 'Destruction Completion', '202 accepted; destruction flags OK', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const a = objectEvent({ bizStep: 'decommissioning', disposition: 'non_sellable_other', action: 'OBSERVE', epcs: [sgtin(), sgtin()] });
  add('E14', 'Export', '202 accepted; export/disposition flags OK', doc(a.xml), { kind: 'event', eventID: a.eventID });
}
{
  const a = objectEvent({ bizStep: 'stock_taking', disposition: 'active', action: 'OBSERVE', epcs: [sgtin(), sgtin()] });
  add('E15', 'Stock Adjustment', '202 accepted or role rejection for stock_taking on manufacturer', doc(a.xml), { kind: 'event', eventID: a.eventID });
}

// ---- TC-S1 rule cases (XML / manufacturer upload reachable) ----
{
  const bad = `<?xml version="1.0" encoding="UTF-8"?>
<epcis:EPCISDocument xmlns:epcis="urn:epcglobal:epcis:xsd:1" schemaVersion="1.2" creationDate="${past(1)}">
  <EPCISBody><EventList>
    <ObjectEvent>
      <eventID>urn:uuid:${uuid()}</eventID>
      <eventTime>${past(5)}</eventTime>
      <epcList><epc>${sgtin()}</epc>
`;
  fs.writeFileSync(path.join(OUT, 'R001.xml'), bad);
  cases.push({
    shot: 'R001', title: 'TC-S1-001 INVALID_XML_STRUCTURE',
    expected: 'Hard reject / failed: INVALID_XML_STRUCTURE',
    file: 'R001.xml', kind: 'rule', code: 'INVALID_XML_STRUCTURE', expectFail: true,
  });
}

add('R005', 'TC-S1-005 INVALID_SBDH', 'Hard reject INVALID_SBDH or INVALID_XML_STRUCTURE for bad/empty SBDH TypeVersion',
  doc(objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}SB`, expiry: '2028-06-30' }).xml, { sbdh: true }),
  { kind: 'rule', code: 'INVALID_SBDH', expectFail: true });

{
  const a = objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}08`, expiry: '06/2028' });
  add('R008', 'TC-S1-008 INVALID_EXPIRY_FORMAT', 'Hard reject INVALID_EXPIRY_FORMAT', doc(a.xml), { kind: 'rule', code: 'INVALID_EXPIRY_FORMAT', expectFail: true });
}
{
  const a = objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}09`, expiry: '2028-12-31', epcs: ['urn:epc:id:sgtin:0614141.10734.BAD'] });
  add('R009', 'TC-S1-009 INVALID_GS1_IDENTIFIER', 'Hard reject INVALID_GS1_IDENTIFIER', doc(a.xml), { kind: 'rule', code: 'INVALID_GS1_IDENTIFIER', expectFail: true });
}
{
  const a = objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}10`, expiry: '2028-12-31', eventTime: future(30) });
  add('R010', 'TC-S1-010 FUTURE_EVENT_TIME', 'Hard reject FUTURE_EVENT_TIME', doc(a.xml), { kind: 'rule', code: 'FUTURE_EVENT_TIME', expectFail: true });
}
{
  const a = objectEvent({ disposition: 'active', lotNumber: `LOT${stamp}11`, expiry: '2028-12-31', omit: ['bizStep'] });
  add('R011', 'TC-S1-011 MISSING_NEEDED_FIELDS', 'Hard reject MISSING_NEEDED_FIELDS', doc(a.xml), { kind: 'rule', code: 'MISSING_NEEDED_FIELDS', expectFail: true });
}
{
  const eid = `urn:uuid:${uuid()}`;
  const a = objectEvent({ eventID: eid, bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}12a`, expiry: '2028-12-31' });
  add('R012a', 'TC-S1-012 setup first eventID', '202 accepted (setup for duplicate eventID)', doc(a.xml), { kind: 'setup', eventID: eid });
  const b = objectEvent({ eventID: eid, bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}12b`, expiry: '2028-12-31', epcs: [sgtin()] });
  add('R012', 'TC-S1-012 DUPLICATE_EVENT_ID', 'Job failed DUPLICATE_EVENT_ID', doc(b.xml), { kind: 'rule', code: 'DUPLICATE_EVENT_ID', expectFail: true, dependsOn: 'R012a', reuseEventID: eid });
}
{
  const epc = sgtin();
  const a = objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}13a`, expiry: '2028-12-31', epcs: [epc] });
  add('R013a', 'TC-S1-013 setup original payload', '202 accepted (setup for duplicate payload)', doc(a.xml), { kind: 'setup', epc });
  const b = objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}13a`, expiry: '2028-12-31', epcs: [epc] });
  add('R013', 'TC-S1-013 DUPLICATE_EVENT_PAYLOAD', 'Job failed DUPLICATE_EVENT_PAYLOAD', doc(b.xml), { kind: 'rule', code: 'DUPLICATE_EVENT_PAYLOAD', expectFail: true, dependsOn: 'R013a' });
}
{
  const epc = sgtin();
  const a = objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}14`, expiry: '2028-12-31', epcs: [epc, epc] });
  add('R014', 'TC-S1-014 DUPLICATE_EPC_IN_EVENT', 'Hard reject DUPLICATE_EPC_IN_EVENT', doc(a.xml), { kind: 'rule', code: 'DUPLICATE_EPC_IN_EVENT', expectFail: true });
}
{
  const a = objectEvent({ bizStep: 'shipping', disposition: 'in_transit', action: 'OBSERVE', epcs: [sgtin()] });
  add('R021', 'TC-S1-021 UNKNOWN_SGTIN', 'Accepted with UNKNOWN_SGTIN warning (or hard reject per sheet)', doc(a.xml), { kind: 'rule', code: 'UNKNOWN_SGTIN' });
}
{
  const a = objectEvent({
    bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}22`, expiry: '2028-12-31',
    readPoint: 'urn:epc:id:sgln:9999999.99999.0', bizLocation: 'urn:epc:id:sgln:9999999.99999.0',
  });
  add('R022', 'TC-S1-022 UNKNOWN_SGLN', 'Accepted with UNKNOWN_SGLN warning', doc(a.xml), { kind: 'rule', code: 'UNKNOWN_SGLN' });
}
{
  // GTIN 0614141107347 would need wrong check digit in item ref; use known bad pattern
  const a = objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}24`, expiry: '2028-12-31', epcs: ['urn:epc:id:sgtin:0614141.107340.BADCHECK01'] });
  add('R024', 'TC-S1-024 INVALID_GTIN_CHECK_DIGIT', 'Hard reject INVALID_GTIN_CHECK_DIGIT (or INVALID_GS1_IDENTIFIER)', doc(a.xml), { kind: 'rule', code: 'INVALID_GTIN_CHECK_DIGIT', expectFail: true });
}
{
  const a = objectEvent({
    bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}25`, expiry: '2028-12-31',
    readPoint: 'urn:epc:id:sgln:0614141.00001.1', bizLocation: 'urn:epc:id:sgln:0614141000001.0',
  });
  add('R025', 'TC-S1-025 INVALID_GLN_CHECK_DIGIT', 'Hard reject INVALID_GLN_CHECK_DIGIT (or INVALID_GS1_IDENTIFIER)', doc(a.xml), { kind: 'rule', code: 'INVALID_GLN_CHECK_DIGIT', expectFail: true });
}
{
  const a = aggEvent({ parentID: 'urn:epc:id:sscc:0614141.123456789', children: [sgtin()], bizStep: 'packing' });
  add('R026', 'TC-S1-026 INVALID_SSCC_CHECK_DIGIT', 'Hard reject INVALID_SSCC_CHECK_DIGIT (or INVALID_GS1_IDENTIFIER)', doc(a.xml), { kind: 'rule', code: 'INVALID_SSCC_CHECK_DIGIT', expectFail: true });
}
{
  const a = objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: 'NOT-A-REAL-LOT-XYZ', expiry: '2028-12-31' });
  add('R027', 'TC-S1-027 INVALID_LOT', 'Accepted with INVALID_LOT warning', doc(a.xml), { kind: 'rule', code: 'INVALID_LOT' });
}
{
  const a = objectEvent({
    bizStep: 'shipping', disposition: 'in_transit', action: 'OBSERVE', epcs: [sscc()],
    bizTransactions: [{ type: 'desadv', id: `urn:epcglobal:cbv:bt:0614141:ASNNOREG${stamp}` }],
    sources: [{ type: 'owning_party', id: sgln() }, { type: 'location', id: sgln() }],
    destinations: [{ type: 'owning_party', id: sgln('22222') }, { type: 'location', id: sgln('22222') }],
  });
  add('R029', 'TC-S1-029 NO_REGULATORY_APPROVAL', 'Accepted with NO_REGULATORY_APPROVAL warning', doc(a.xml), { kind: 'rule', code: 'NO_REGULATORY_APPROVAL' });
}
{
  const a = objectEvent({ bizStep: 'inspecting', disposition: 'damaged', action: 'OBSERVE', epcs: [sgtin()] });
  add('R030', 'TC-S1-030 UNAUTHORIZED_INSPECTING_EVENT', 'Accepted with UNAUTHORIZED_INSPECTING_EVENT warning', doc(a.xml), { kind: 'rule', code: 'UNAUTHORIZED_INSPECTING_EVENT' });
}
{
  const soon = new Date(Date.now() + 45 * 86400_000).toISOString().slice(0, 10);
  const a = objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}31`, expiry: soon });
  add('R031', 'TC-S1-031 EXPIRING_SOON', 'Accepted with EXPIRING_SOON warning', doc(a.xml), { kind: 'rule', code: 'EXPIRING_SOON' });
}
{
  const a = objectEvent({ bizStep: 'not_a_real_bizstep', disposition: 'active', action: 'OBSERVE', epcs: [sgtin()] });
  add('R035', 'TC-S1-035 INVALID_BIZSTEP', 'Hard reject or flag INVALID_BIZSTEP', doc(a.xml), { kind: 'rule', code: 'INVALID_BIZSTEP', expectFail: true });
}
{
  const a = aggEvent({ parentID: sscc(), children: [sscc()], bizStep: 'packing' });
  add('R037', 'TC-S1-037 INVALID_PARENT_CHILD_RELATION', 'Flag or reject INVALID_PARENT_CHILD_RELATION (SSCC under SSCC may also be valid as E03)', doc(a.xml), { kind: 'rule', code: 'INVALID_PARENT_CHILD_RELATION' });
}
{
  const a = aggEvent({ parentID: sscc(), children: [sgtin()], bizStep: 'packing' });
  add('R038', 'TC-S1-038 PARENT_NOT_FOUND', 'Accepted with PARENT_NOT_FOUND warning', doc(a.xml), { kind: 'rule', code: 'PARENT_NOT_FOUND' });
}
{
  const a = objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}42`, expiry: '2020-01-01' });
  add('R042', 'TC-S1-042 EXPIRED_PRODUCT', 'Accepted with EXPIRED_PRODUCT warning', doc(a.xml), { kind: 'rule', code: 'EXPIRED_PRODUCT' });
}
{
  const a = objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}46`, expiry: '2028-12-31', eventTime: daysAgo(8) });
  add('R046', 'TC-S1-046 STALE_EVENT_TIME', 'Accepted with STALE_EVENT_TIME warning', doc(a.xml), { kind: 'rule', code: 'STALE_EVENT_TIME' });
}
{
  const a = aggEvent({ parentID: sscc(), children: [sgtin(), sgtin()], bizStep: 'packing' });
  add('R047', 'TC-S1-047 UNCOMMISSIONED_CHILD', 'Accepted with UNCOMMISSIONED_CHILD warning', doc(a.xml), { kind: 'rule', code: 'UNCOMMISSIONED_CHILD' });
}
{
  const a = objectEvent({
    bizStep: 'shipping', disposition: 'in_transit', action: 'OBSERVE', epcs: [sgtin()],
    bizTransactions: [{ type: 'desadv', id: `urn:epcglobal:cbv:bt:0614141:ASNSHIP${stamp}` }],
    sources: [{ type: 'owning_party', id: sgln() }, { type: 'location', id: sgln() }],
    destinations: [{ type: 'owning_party', id: sgln('22222') }, { type: 'location', id: sgln('22222') }],
  });
  add('R048', 'TC-S1-048 SHIPPING_WITHOUT_COMMISSIONING', 'Accepted with SHIPPING_WITHOUT_COMMISSIONING warning', doc(a.xml), { kind: 'rule', code: 'SHIPPING_WITHOUT_COMMISSIONING' });
}
{
  const parent = sscc();
  const e1 = aggEvent({ parentID: parent, children: [sgtin()], eventID: `urn:uuid:${uuid()}`, eventTime: past(9) });
  const e2 = aggEvent({ parentID: parent, children: [sgtin()], eventID: `urn:uuid:${uuid()}`, eventTime: past(8) });
  add('R049', 'TC-S1-049 DUPLICATE_SSCC_IN_MESSAGE', 'Flag or reject DUPLICATE_SSCC_IN_MESSAGE', doc(`${e1.xml}\n${e2.xml}`), { kind: 'rule', code: 'DUPLICATE_SSCC_IN_MESSAGE' });
}

// Oversized file (>10 MB) — message size
{
  const filler = '<!--' + 'X'.repeat(11 * 1024 * 1024) + '-->';
  const a = objectEvent({ bizStep: 'commissioning', disposition: 'active', lotNumber: `LOT${stamp}SZ`, expiry: '2028-12-31' });
  const big = doc(a.xml).replace('</epcis:EPCISDocument>', `${filler}\n</epcis:EPCISDocument>`);
  fs.writeFileSync(path.join(OUT, 'RSIZE.xml'), big);
  cases.push({
    shot: 'RSIZE', title: 'Upload over 10 MB max', expected: 'UI/API reject over max size (MESSAGE_SIZE_EXCEEDED or client/server size error)',
    file: 'RSIZE.xml', kind: 'rule', code: 'MESSAGE_SIZE_EXCEEDED', expectFail: true,
  });
}

// NOT TESTABLE rows for remaining TC-S1 codes (listed in manifest only)
const notTestable = [
  ['R002', 'TC-S1-002 INVALID_JSON_STRUCTURE', 'JSON-LD only — XML upload UI accepts .xml only'],
  ['R003', 'TC-S1-003 MISSING_EPCIS_BODY', 'JSON-LD body shape — not expressible as XML file upload'],
  ['R004', 'TC-S1-004 MISSING_EVENT_LIST', 'JSON-LD body shape — not expressible as XML file upload'],
  ['R006', 'TC-S1-006 MESSAGE_SIZE_EXCEEDED (dispense 1MB)', 'Sync dispense endpoint only — not partner XML upload'],
  ['R007', 'TC-S1-007 TOO_MANY_SERIALS (50001)', 'Skipped: 50k+ serial fixture impractical for UI pack; max_epcs advertised as 50000'],
  ['R015', 'TC-S1-015 IMPOSSIBLE_SENSOR_VALUES', 'SensorElement is JSON-LD / EPCIS 2.0 — not XML 1.2 upload'],
  ['R016', 'TC-S1-016 ERROR_DECLARATION_BEFORE_EVENT', 'Needs chained errorDeclaration XML — deferred'],
  ['R017', 'TC-S1-017 ERROR_DECLARATION_ORIGINAL_NOT_FOUND', 'Needs errorDeclaration against unknown eventID'],
  ['R018', 'TC-S1-018 ERROR_DECLARATION_CONTENT_MISMATCH', 'Needs errorDeclaration resubmit chain'],
  ['R019', 'TC-S1-019 ERROR_DECLARATION_INVALID_REASON', 'Needs errorDeclaration with bad reason'],
  ['R020', 'TC-S1-020 ERROR_DECLARATION_CORRECTIVE_NOT_FOUND', 'Needs errorDeclaration + corrective IDs'],
  ['R023', 'TC-S1-023 INACTIVE_SGLN', 'Needs registered-but-inactive SGLN fixture'],
  ['R028', 'TC-S1-028 INVENTORY_SIGHTING_MISMATCH', 'Needs prior commission at location A then sighting at B'],
  ['R032', 'TC-S1-032 SERIAL_ALREADY_DISPENSED', 'Needs facility dispense then manufacturer event'],
  ['R033', 'TC-S1-033 SERIAL_ALREADY_DESTROYED', 'Needs destroy then lifecycle event chain'],
  ['R034', 'TC-S1-034 INVALID_DISPOSITION (dispensed→active)', 'Needs dispensed serial then illegal transition'],
  ['R036', 'TC-S1-036 INVALID_TERMINAL_STATE', 'Needs terminal serial then lifecycle action'],
  ['R039', 'TC-S1-039 CHILD_ALREADY_AGGREGATED', 'Needs pack then re-pack under second SSCC chain'],
  ['R040', 'TC-S1-040 INVALID_EVENT_SEQUENCE', 'Receiving-before-shipping is distributor/facility path'],
  ['R041', 'TC-S1-041 SSCC_AT_DISPENSING', 'Facility /dispense only'],
  ['R043', 'TC-S1-043 RECALL_ACTIVE', 'Needs active recall fixture'],
  ['R044', 'TC-S1-044 RECEIVING_WITHOUT_SHIPPING', 'Distributor/facility receiving path'],
  ['R045', 'TC-S1-045 UNPACK_WITHOUT_AGGREGATION', 'Distributor unpack path'],
  ['R050', 'TC-S1-050 DUPLICATE_SSCC_CROSS_MESSAGE', 'Needs two sequential pack messages with same parent'],
  ['R051', 'TC-S1-051 INCOMPLETE_ERROR_DECLARATION', 'Needs errorDeclaration XML'],
  ['R052', 'TC-S1-052 ERROR_DECLARATION_WITHOUT_REASON', 'Needs errorDeclaration XML'],
];
for (const [shot, title, reason] of notTestable) {
  cases.push({ shot, title, expected: 'NOT TESTABLE via manufacturer XML upload', file: null, kind: 'not_testable', reason, verdict: 'NOT TESTABLE' });
}

fs.writeFileSync(path.join(OUT, '..', 'manifest.json'), JSON.stringify({ created: new Date().toISOString(), stamp, cases }, null, 2));
console.log(`Wrote ${cases.filter((c) => c.file).length} XML files + ${notTestable.length} NOT TESTABLE rows to ${OUT}`);
console.log(`Manifest: ${cases.length} cases`);
