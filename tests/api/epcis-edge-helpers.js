// Builders and runners for the EPCIS partner-API edge cases (tests/api/epcis-edge.spec.js).
//
// Every event starts from the matching request in "Kenya TNT - Partner API Partner.postman_collection.json"
// (its JSON-LD body, passed through freshenBusinessData/freshenEventIds as the dashboard does), then the
// case's identifiers and fields are overlaid. The same event object is rendered both as an EPCIS 2.0
// JSON-LD document (short CBV tokens) and as an EPCIS 1.2 XML document (full urn:epcglobal:cbv URNs), so
// the two formats carry the same business content - each run with its own fresh identifiers.
const crypto = require('crypto');
const {
  loadCollection,
  findNode,
  freshenEventIds,
  freshenBusinessData,
} = require('../../dashboard/lib/postmanRunner');
const { postEvent } = require('../helpers/apiEnv');
const { logEntity } = require('../helpers/datalog');

const FORMATS = ['JSON-LD', 'XML'];

// ---------------------------------------------------------------- identifiers
let counter = 0;
const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
function serial() {
  counter = (counter + 1) % 1000;
  return `${String(Date.now()).slice(-9)}${String(counter).padStart(3, '0')}${digits(2)}`;
}
// Product used for every SGTIN: Amtel 5 mg/80 mg (GTIN 18904179702187), a registered product, so
// its serials enter the serial registry on commissioning and downstream events are judged on their
// state rather than drowned in UNKNOWN_SGTIN.
const SGTIN_PREFIX = 'urn:epc:id:sgtin:8904179.170218';
const LGTIN_PREFIX = 'urn:epc:class:lgtin:8904179.170218';
const sgtin = () => `${SGTIN_PREFIX}.${serial()}`;
const sscc = () => `urn:epc:id:sscc:0614141.${digits(10)}`;
// lotNumber is limited to 20 characters: "QA-AUTO-" + 12 digits.
const lot = () => `QA-AUTO-${String(Date.now()).slice(-8)}${digits(4)}`;
const uuid = () => `urn:uuid:${crypto.randomUUID()}`;

// ---------------------------------------------------------------- templates
// First event of a collection request's JSON-LD body, freshened. `folderPath` is the folder path.
function template(folderPath) {
  const node = findNode(loadCollection().item, [...folderPath, 'JSON-LD']);
  if (!node) throw new Error(`collection node not found: ${folderPath.join(' / ')}`);
  const raw = freshenEventIds(freshenBusinessData(node.request.body.raw));
  return JSON.parse(raw).epcisBody.eventList[0];
}

// An event: collection template + overrides. An override of `undefined` removes the key.
function event(folderPath, overrides = {}) {
  const base = template(folderPath);
  const out = { ...base, eventID: uuid(), eventTime: new Date(Date.now() - 5 * 60_000).toISOString(), ...overrides };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// Collection request paths used by the cases.
const T = {
  commission: ['Manufacturer Events', 'Commission (ObjectEvent)'],
  mfgPack: ['Manufacturer Events', 'Pack (AggregationEvent)'],
  mfgShip: ['Manufacturer Events', 'Ship (ObjectEvent)'],
  distReceive: ['Distributor Events', 'Receive (ObjectEvent)'],
  distUnpack: ['Distributor Events', 'Unpack (AggregationEvent)'],
  distPack: ['Distributor Events', 'Pack (AggregationEvent)'],
  distShip: ['Distributor Events', 'Ship (ObjectEvent)'],
  dispense: ['Facility Events', 'Dispense (ObjectEvent - SGTIN only)'],
  distDamaged: ['Special Events', 'Distributor', 'Damaged (inspecting / damaged)'],
  distDestroy: ['Special Events', 'Distributor', 'Destruction (destroying / destroyed)'],
  distLost: ['Special Events', 'Distributor', 'Lost (decommissioning / inactive)'],
  facExpired: ['Special Events', 'Facility', 'Expired (inspecting / expired)'],
};

// ---------------------------------------------------------------- rendering
function jsonLdDoc(events) {
  return {
    '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: new Date().toISOString(),
    epcisBody: { eventList: events },
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const urn = (kind, token) => (/^urn:/.test(token) ? token : `urn:epcglobal:cbv:${kind}:${token}`);

// EPCIS 1.2 XML for one event, laid out like the collection's XML bodies (eventID first,
// sourceList/destinationList/quantityList/ilmd inside <extension>).
function xmlEvent(e) {
  const t = e.type;
  const lines = [`<${t}>`, `<eventID>${e.eventID}</eventID>`];
  lines.push(`<eventTime>${e.eventTime}</eventTime>`, `<eventTimeZoneOffset>${e.eventTimeZoneOffset || '+03:00'}</eventTimeZoneOffset>`);
  if (t === 'AggregationEvent') {
    if (e.parentID) lines.push(`<parentID>${e.parentID}</parentID>`);
    lines.push(`<childEPCs>${(e.childEPCs || []).map((x) => `<epc>${x}</epc>`).join('')}</childEPCs>`);
  } else {
    lines.push(`<epcList>${(e.epcList || []).map((x) => `<epc>${x}</epc>`).join('')}</epcList>`);
  }
  lines.push(`<action>${e.action}</action>`);
  if (e.bizStep) lines.push(`<bizStep>${urn('bizstep', e.bizStep)}</bizStep>`);
  if (e.disposition) lines.push(`<disposition>${urn('disp', e.disposition)}</disposition>`);
  if (e.readPoint) lines.push(`<readPoint><id>${e.readPoint.id}</id></readPoint>`);
  if (e.bizLocation) lines.push(`<bizLocation><id>${e.bizLocation.id}</id></bizLocation>`);
  if (e.bizTransactionList?.length) {
    lines.push(`<bizTransactionList>${e.bizTransactionList
      .map((b) => `<bizTransaction type="${urn('btt', b.type)}">${esc(b.bizTransaction)}</bizTransaction>`)
      .join('')}</bizTransactionList>`);
  }
  const ext = [];
  const qty = t === 'AggregationEvent' ? e.childQuantityList : e.quantityList;
  if (qty?.length) {
    const tag = t === 'AggregationEvent' ? 'childQuantityList' : 'quantityList';
    ext.push(`<${tag}>${qty.map((q) => `<quantityElement><epcClass>${q.epcClass}</epcClass><quantity>${q.quantity}</quantity>${q.uom ? `<uom>${q.uom}</uom>` : ''}</quantityElement>`).join('')}</${tag}>`);
  }
  if (e.sourceList?.length) ext.push(`<sourceList>${e.sourceList.map((s) => `<source type="${urn('sdt', s.type)}">${s.source}</source>`).join('')}</sourceList>`);
  if (e.destinationList?.length) ext.push(`<destinationList>${e.destinationList.map((d) => `<destination type="${urn('sdt', d.type)}">${d.destination}</destination>`).join('')}</destinationList>`);
  if (e.ilmd) ext.push(`<ilmd>${Object.entries(e.ilmd).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</ilmd>`);
  if (ext.length) lines.push(`<extension>${ext.join('')}</extension>`);
  lines.push(`</${t}>`);
  return lines.join('\n');
}

function xmlDoc(events) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<epcis:EPCISDocument xmlns:epcis="urn:epcglobal:epcis:xsd:1" xmlns:cbvmda="urn:epcglobal:cbv:mda" schemaVersion="1.2" creationDate="${new Date().toISOString()}">`,
    '<EPCISBody><EventList>',
    ...events.map(xmlEvent),
    '</EventList></EPCISBody>',
    '</epcis:EPCISDocument>',
  ].join('\n');
}

// Sends `events` (array or single) as `role` in `format`. Returns postEvent's result plus `codes`
// (warning codes, the top-level error code and any errors[].code).
async function send(role, events, format) {
  const list = Array.isArray(events) ? events : [events];
  const body = format === 'XML' ? xmlDoc(list) : jsonLdDoc(list);
  const res = await postEvent(role, body, format === 'XML' ? 'xml' : 'json');
  const codes = new Set(res.warnings);
  if (res.code) codes.add(res.code);
  for (const e of res.json?.errors || []) if (e?.code) codes.add(e.code);
  res.codes = [...codes];
  return res;
}

const ok = (status) => status >= 200 && status < 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Guide 2.6.2: everything except dispensing is processed asynchronously after the 202, so a
// setup chain pauses between steps for the previous event to land. Measured on TrackIQ: state
// from one event (aggregation, disposition) is visible to the next one within ~10 s.
const SETTLE_MS = Number(process.env.EPCIS_SETTLE_MS || 10_000);

// Warnings every event draws because the collection's example GLNs, lots and PPB approvals are not
// in the environment's master data. Left out of the short evidence string so the code under test
// stands out; assertions always look at the full code list.
const NOISE = new Set([
  'UNKNOWN_SGLN', 'UNKNOWN_PARTY_GLN', 'INVALID_LOT', 'NO_REGULATORY_APPROVAL',
  'INVENTORY_SIGHTING_MISMATCH', 'UNAUTHORIZED_INSPECTING_EVENT', 'PARENT_NOT_FOUND',
]);
const brief = (res) => {
  const codes = res.codes.filter((c) => !NOISE.has(c));
  return `HTTP ${res.status}${codes.length ? ` [${codes.join(', ')}]` : ''}`;
};
const messagesFor = (res, code) =>
  [...(res.json?.warnings || []), ...(res.json?.errors || [])].filter((w) => w?.code === code).map((w) => w.message);

const CLEANUP = 'Partner-API test data (sandbox trk_test_ key). No delete endpoint: void with an EPCIS errorDeclaration (did_not_occur) on the originating event if it must be removed.';

// One format's run of a case. `step` sends a setup event that must be accepted and then lets it
// settle; `send` sends the event under test with no status assumption. Every response lands in
// `obs`, and every identifier minted through it is logged to the data log.
function journey(format, testId) {
  const obs = [];
  const minted = { sgtin: [], sscc: [], lot: [] };
  const mint = (kind, make) => () => {
    const v = make();
    minted[kind].push(v);
    return v;
  };
  const j = {
    format,
    obs,
    sgtin: mint('sgtin', sgtin),
    sscc: mint('sscc', sscc),
    lot: mint('lot', lot),
    note: (text) => obs.push(text),
    async send(label, role, events) {
      const res = await send(role, events, format);
      obs.push(`${label} ${brief(res)}`);
      return res;
    },
    async step(label, role, events, { settle = true } = {}) {
      const res = await j.send(label, role, events);
      if (!ok(res.status)) {
        throw new Error(`${format} setup step "${label}" was refused: HTTP ${res.status} ${res.text.slice(0, 300)}`);
      }
      if (settle) await sleep(SETTLE_MS);
      return res;
    },
    logAll() {
      for (const [type, ids] of Object.entries(minted)) {
        if (ids.length) logEntity({ type, identifier: ids.join(','), testId, cleanup: CLEANUP });
      }
    },
  };
  return j;
}

// Runs `fn(journey)` for JSON-LD and XML side by side (each with its own identifiers), appends
// both formats' evidence to `observed`, and rethrows the first failure.
async function bothFormats(testId, observed, fn) {
  const runs = FORMATS.map((f) => journey(f, testId));
  const results = await Promise.allSettled(runs.map((j) => fn(j)));
  runs.forEach((j, i) => {
    j.logAll();
    const failed = results[i].status === 'rejected' ? ' => FAIL' : '';
    observed.push(`${j.format}: ${j.obs.join(', ')}${failed}`);
  });
  const failure = results.find((r) => r.status === 'rejected');
  if (failure) throw failure.reason;
}

module.exports = {
  FORMATS, SETTLE_MS, NOISE, T, SGTIN_PREFIX, LGTIN_PREFIX,
  sgtin, sscc, lot, uuid, digits, template, event, jsonLdDoc, xmlDoc, send, ok, sleep,
  brief, messagesFor, journey, bothFormats, logEntity, CLEANUP,
};
