// Generates the L4 CSV vs L5 API parity pack: one CSV per scenario, the same events as an EPCIS
// 2.0 "API twin" in a Postman collection, one Jira comment per test, and the parity matrix.
//
// Every scenario is defined once and built twice, once per channel. The two builds have the same
// structure and timestamps but their own serials, SSCCs and lots, so neither collides with the
// other. The API twin is the baseline: the CSV must get the same outcome (ticket "Same outcome").
// Where a CSV row has no faithful EPCIS form (a broken check digit, an Excel-mangled GTIN), the
// twin leaves that row out and the CSV must reject it rather than repair it.
//
// Rule references and the "Guide v0.2" predictions come from Taifacare_Technical_Onboarding_Guidev0.2
// (the ticket cites v0.3, which is not in the repo). Predictions guide the tester; the API result
// is what the CSV is judged against.
//
// Run:  node scripts/csv/make-csv-parity-pack.mjs [--gtin 6161102974997] [--gtin2 18904179702187]
//         [--gln 0614141000012] [--dist-gln 0614142000011] [--out <dir>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';

const require = createRequire(import.meta.url);
const { sgtinPrefix } = require('../../dashboard/lib/productRegistry.js');

const ROOT = path.join(import.meta.dirname, '..', '..');
const TEMPLATE = path.join(ROOT, '..', 'CSV-bulk import tests', 'epcis-event-csv-template (2).csv');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => {
    if (a.startsWith('--')) pairs.push([a.slice(2), all[i + 1]]);
    return pairs;
  }, [])
);
const GTIN = args.gtin || '6161102974997';
const GTIN2 = args.gtin2 || '18904179702187';
const OTHER_MAH_GTIN = '04057598013642'; // Xarelto, Bayer's product in data/products.csv
const GLN = args.gln || '0614141000012';
const DIST_GLN = args['dist-gln'] || '0614142000011';
const MAH_GLN = '4012345000009';
const LSP_GLN = '0614143000010';
const OUT = args.out || 'C:\\Users\\Collins\\Desktop\\uploads';

const TEMPLATE_TEXT = fs.readFileSync(TEMPLATE, 'utf8').replace(/^﻿/, '');
const HEADER = TEMPLATE_TEXT.split(/\r?\n/)[0];
const COLS = HEADER.split(',');
const col = Object.fromEntries(COLS.map((c, i) => [c, i]));

const now = new Date();
const ymd = now.toISOString().slice(0, 10);
const YEAR = Number(ymd.slice(0, 4));
const MMDD = ymd.slice(5, 7) + ymd.slice(8, 10);
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RUN = Array.from(crypto.randomBytes(3), (b) => ALNUM[b % ALNUM.length]).join('');
const SSCC_RUN = String(crypto.randomInt(0, 10));
const LOT_MFG = `${ymd.slice(0, 8)}01`;
const LOT_EXP = `${YEAR + 2}-${ymd.slice(5, 7)}-01`;
const PERMIT = `PPB/IMP/${YEAR}/${String(crypto.randomInt(1000, 10000)).padStart(6, '0')}`;
const dayOffset = (days) => new Date(now.getTime() + days * 86400_000).toISOString().slice(0, 10);

// --- GS1 ----------------------------------------------------------------------------------------
function checkDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}
const gs1 = (body) => body + checkDigit(body);
const validGs1 = (code) => /^\d+$/.test(code) && checkDigit(code.slice(0, -1)) === code.slice(-1);
const breakCheck = (code) => code.slice(0, -1) + String((Number(code.at(-1)) + 1) % 10);
const UNKNOWN_GTIN = gs1('616199999999');
const UNKNOWN_GLN = gs1('999999900000');
const SECOND_GLN = gs1('061414100002');
const DEPOT_GLN = gs1('061414200002');

// EPC URIs. Company prefixes are taken as 7 digits, as in dashboard/lib/productRegistry.js.
const escapeSerial = (s) => s.replace(/[^A-Za-z0-9\-_.!'()*+,;:=]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
const sgtinUri = (gtin, serial) => `${sgtinPrefix(gtin)}.${escapeSerial(serial)}`;
const ssccUri = (s) => `urn:epc:id:sscc:${s.slice(1, 8)}.${s[0]}${s.slice(8, 17)}`;
const sglnUri = (g) => `urn:epc:id:sgln:${g.slice(0, 7)}.${g.slice(7, 12)}.0`;
const COUNTRY = { Germany: 'DE', India: 'IN', Kenya: 'KE', 'Korea, Republic of': 'KR', "Côte d'Ivoire": 'CI' };

// --- clock --------------------------------------------------------------------------------------
// Each channel replays the same clock, so a CSV and its twin carry identical times.
const CLOCK_START = now.getTime() - 30 * 3600_000;
let clockMs = CLOCK_START;
const nairobi = (ms) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 19);
const tick = () => nairobi((clockMs += 1000));

// --- rows ---------------------------------------------------------------------------------------
function makeRow(fields) {
  const r = new Array(COLS.length).fill('');
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in col)) throw new Error(`unknown column ${k}`);
    r[col[k]] = v;
  }
  return r;
}
const quote = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const line = (r) => r.map(quote).join(',');
const body = (lines, header = HEADER) => [header, ...lines].join('\n') + '\n';

const CHANNELS = {
  csv: { tag: 'Q', digit: '1', name: 'CSV' },
  api: { tag: 'A', digit: '2', name: 'API' },
};

function fileContext(id, ch) {
  const code = id.replace(/\D/g, '').slice(-4).padStart(4, '0');
  let s = 0;
  let c = 0;
  const f = {
    id,
    rows: [],
    meta: [],
    flagged: [],
    lot: `L${ch.tag}${MMDD}${RUN}${code}`,
    serial: () => `${ch.tag}${MMDD}${RUN}${code}${String(++s).padStart(5, '0')}`,
    sscc: () => {
      if (c >= 999) throw new Error(`${id}: SSCC counter exhausted`);
      return gs1(`06164003${ch.digit}${SSCC_RUN}${code}${String(++c).padStart(3, '0')}`);
    },
    add(fields, meta = {}) {
      f.rows.push(makeRow(fields));
      f.meta.push(meta);
      if (f.flagging) f.flagged.push({ line: f.rows.length + 1, why: f.flagging });
      return f.rows.at(-1);
    },
    flag(why, fn) {
      f.flagging = why;
      const out = fn();
      f.flagging = null;
      return out;
    },
    commission(serial = f.serial(), extra = {}, ts = tick()) {
      f.add({
        Event_Type: 'COMMISSIONING', Identifier_Type: 'SGTIN', GTIN, Unit_ID: serial, Packaging_Level: 'Item',
        Event_Timestamp: ts, Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN, Lot_Batch_Number: f.lot,
        Lot_Manufacturing_Date: LOT_MFG, Lot_Expiry_Date: LOT_EXP, Manufacturing_Origin: 'IMPORT',
        Country_of_Origin: 'Germany', Import_Sales_Permit_Ref: PERMIT, Sender_Owner_GLN: MAH_GLN, Sender_Owner_Name: 'Bayer AG', ...extra,
      });
      return serial;
    },
    pack(serial, parent, extra = {}, meta) {
      f.add({
        Event_Type: 'AGGREGATION', Identifier_Type: 'SGTIN', GTIN, Unit_ID: serial, Parent_ID: parent, Packaging_Level: 'Item',
        Event_Timestamp: tick(), Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN, ...extra,
      }, meta);
    },
    box(sscc, parent, extra = {}) {
      f.add({
        Event_Type: 'AGGREGATION', Identifier_Type: 'SSCC', Unit_ID: sscc, Parent_ID: parent, Packaging_Level: 'Case',
        Event_Timestamp: tick(), Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN, ...extra,
      });
    },
    ship(sscc, extra = {}) {
      f.add({
        Event_Type: 'SHIPPING', Identifier_Type: 'SSCC', Unit_ID: sscc, Packaging_Level: 'Package',
        Event_Timestamp: tick(), Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN, Import_Sales_Permit_Ref: PERMIT,
        Sender_Owner_GLN: MAH_GLN, Sender_Owner_Name: 'Bayer AG', Sender_Custodian_GLN: MAH_GLN, Sender_Location_Name: 'Bayer Leverkusen DC',
        Receiver_Owner_GLN: DIST_GLN, Receiver_Owner_Name: 'KEMSA', Receiver_Custodian_GLN: DIST_GLN, Receiver_Location_Name: 'KEMSA Embakasi Warehouse',
        LSP_GLN, LSP_Name: 'DHL Supply Chain Kenya', Transaction_Type: 'desadv',
        Transaction_Reference: `INV-${RUN}${ch.tag}${code}-${String(f.rows.length + 1).padStart(3, '0')}`, ...extra,
      });
    },
    caseOf(items = 2, extra = {}) {
      const kase = f.sscc();
      const serials = Array.from({ length: items }, () => f.commission(f.serial(), extra));
      serials.forEach((sn) => f.pack(sn, kase, extra.GTIN ? { GTIN: extra.GTIN } : {}));
      return { kase, serials };
    },
    packageOf(items = 2) {
      const pallet = f.sscc();
      const { kase, serials } = f.caseOf(items);
      f.box(kase, pallet);
      return { pallet, kase, serials };
    },
    controls() {
      f.commission();
      f.commission();
    },
  };
  return f;
}

// --- API twin: one EPCIS event per CSV row ------------------------------------------------------
const v = (r, c) => r[col[c]];

function utc(ts, off) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(ts) || !/^[+-](0\d|1[0-4]):[0-5]\d$/.test(off)) return null;
  const ms = Date.parse(`${ts}${off}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function epcOf(idType, gtin, unit) {
  if (idType === 'SSCC') {
    if (!/^\d{18}$/.test(unit)) return { na: `"${unit}" is not an 18-digit SSCC` };
    if (!validGs1(unit)) return { na: 'the SSCC check digit is wrong, and an SSCC URI carries no check digit, so the API cannot send this error' };
    return { uri: ssccUri(unit) };
  }
  if (idType !== 'SGTIN') return { na: `Identifier_Type "${idType}" is not SGTIN or SSCC` };
  if (!unit) return { na: 'the serial is blank, so there is no SGTIN to send' };
  if (!gtin) return { na: 'the GTIN is blank, so there is no SGTIN to send' };
  if (!/^\d{8}$|^\d{12,14}$/.test(gtin)) return { na: `GTIN "${gtin}" is not a GTIN-8/12/13/14, so no SGTIN can be formed` };
  if (!validGs1(gtin)) return { na: 'the GTIN check digit is wrong, and an SGTIN URI drops the check digit, so the API cannot send this error' };
  return { uri: sgtinUri(gtin, unit) };
}

function glnOf(value, field) {
  if (!value) return { uri: null };
  if (!/^\d{13}$/.test(value)) return { na: `${field} "${value}" is not a 13-digit GLN` };
  if (!validGs1(value)) return { na: `${field} has a wrong check digit, and an SGLN URI carries no check digit, so the API cannot send this error` };
  return { uri: sglnUri(value) };
}

const uuidFrom = (text) => {
  const h = crypto.createHash('sha256').update(text).digest('hex');
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function twinEvent(r, meta, chName) {
  if (meta.twinEvent) return { event: { eventID: uuidFrom(`${chName}|${line(r)}`), ...meta.twinEvent } };
  const type = v(r, 'Event_Type');
  const kind = { COMMISSIONING: 'commission', AGGREGATION: 'pack', SHIPPING: 'ship' }[type];
  if (!kind) return { na: type ? `Event_Type "${type}" is not one of COMMISSIONING / AGGREGATION / SHIPPING` : 'Event_Type is blank' };
  const unit = epcOf(v(r, 'Identifier_Type'), v(r, 'GTIN'), v(r, 'Unit_ID'));
  if (unit.na) return unit;
  const loc = glnOf(v(r, 'BizLocation_GLN'), 'BizLocation_GLN');
  if (loc.na) return loc;

  const e = { type: kind === 'pack' ? 'AggregationEvent' : 'ObjectEvent', eventID: uuidFrom(`${chName}|${line(r)}`) };
  const ts = v(r, 'Event_Timestamp');
  const off = v(r, 'Event_TimeZone_Offset');
  const t = utc(ts, off);
  if (t) e.eventTime = t;
  else if (ts) e.eventTime = ts; // sent as written, so the API judges the same bad value
  if (off) e.eventTimeZoneOffset = off;
  const place = loc.uri ? { readPoint: { id: loc.uri }, bizLocation: { id: loc.uri } } : {};

  if (kind === 'commission') {
    Object.assign(e, { epcList: [unit.uri], action: 'ADD', bizStep: 'commissioning', disposition: 'active', ...place });
    const ilmd = {};
    if (v(r, 'Lot_Batch_Number')) ilmd['cbvmda:lotNumber'] = v(r, 'Lot_Batch_Number');
    if (v(r, 'Lot_Expiry_Date')) ilmd['cbvmda:itemExpirationDate'] = v(r, 'Lot_Expiry_Date');
    if (v(r, 'Country_of_Origin')) ilmd['cbvmda:countryOfOrigin'] = COUNTRY[v(r, 'Country_of_Origin')] || v(r, 'Country_of_Origin');
    if (Object.keys(ilmd).length) e.ilmd = ilmd;
    const mah = glnOf(v(r, 'Sender_Owner_GLN'), 'Sender_Owner_GLN');
    if (mah.na) return mah;
    if (mah.uri) e.sourceList = [{ type: 'owning_party', source: mah.uri }];
    return { event: e };
  }
  if (kind === 'pack') {
    let parent = { uri: meta.parentUri || null };
    if (!parent.uri && v(r, 'Parent_ID')) parent = epcOf('SSCC', '', v(r, 'Parent_ID'));
    if (parent.na) return { na: `Parent_ID: ${parent.na}` };
    Object.assign(e, parent.uri ? { parentID: parent.uri } : {}, { childEPCs: [unit.uri], action: 'ADD', bizStep: 'packing', disposition: 'active', ...place });
    return { event: e };
  }
  Object.assign(e, { epcList: [unit.uri], action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit', ...place });
  const ends = {};
  for (const [field, list, key, typ] of [
    ['Sender_Owner_GLN', 'sourceList', 'source', 'owning_party'], ['Sender_Custodian_GLN', 'sourceList', 'source', 'possessing_party'],
    ['Receiver_Owner_GLN', 'destinationList', 'destination', 'owning_party'], ['Receiver_Custodian_GLN', 'destinationList', 'destination', 'possessing_party'],
  ]) {
    const g = glnOf(v(r, field), field);
    if (g.na) return g;
    if (g.uri) (ends[list] ||= []).push({ type: typ, [key]: g.uri });
  }
  if (v(r, 'Transaction_Type') || v(r, 'Transaction_Reference')) {
    const bt = {};
    if (v(r, 'Transaction_Type')) bt.type = v(r, 'Transaction_Type');
    if (v(r, 'Transaction_Reference')) bt.bizTransaction = `urn:epcglobal:cbv:bt:${v(r, 'Sender_Owner_GLN') || GLN}:${v(r, 'Transaction_Reference')}`;
    e.bizTransactionList = [bt];
  }
  Object.assign(e, ends);
  return { event: e };
}

const epcisDoc = (events) => ({
  '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
  type: 'EPCISDocument',
  schemaVersion: '2.0',
  creationDate: now.toISOString(),
  epcisBody: { eventList: events },
});

// Merges events that a partner would send as one: commissioning by lot, packing by parent + time.
function mergeEvents(events, how) {
  const out = [];
  const byKey = new Map();
  for (const e of events) {
    const key = how === 'lot' && e.bizStep === 'commissioning' ? `lot|${e.ilmd?.['cbvmda:lotNumber']}`
      : how === 'parent' && e.type === 'AggregationEvent' ? `p|${e.parentID}|${e.eventTime}` : null;
    if (key && byKey.has(key)) {
      const into = byKey.get(key);
      (into.epcList || into.childEPCs).push(...(e.epcList || e.childEPCs));
    } else {
      out.push(e);
      if (key) byKey.set(key, e);
    }
  }
  return out;
}

// --- support requests (state changes made through the API, either channel) ---------------------
const support = {
  damage: (sscc, label) => ({ role: 'manufacturer', label, event: {
    type: 'ObjectEvent', eventTimeZoneOffset: '+03:00', epcList: [ssccUri(sscc)], action: 'OBSERVE', bizStep: 'inspecting', disposition: 'damaged',
    readPoint: { id: sglnUri(GLN) }, bizLocation: { id: sglnUri(GLN) },
    bizTransactionList: [{ type: 'cert', bizTransaction: `urn:epcglobal:cbv:bt:${GLN}:QA-DAMAGE-${RUN}` }],
  } }),
  destroy: (serials, label) => ({ role: 'manufacturer', label, event: {
    type: 'ObjectEvent', eventTimeZoneOffset: '+03:00', epcList: serials.map((s) => sgtinUri(GTIN, s)), action: 'OBSERVE', bizStep: 'destroying', disposition: 'destroyed',
    readPoint: { id: sglnUri(GLN) }, bizLocation: { id: sglnUri(GLN) },
    bizTransactionList: [{ type: 'cert', bizTransaction: `urn:epcglobal:cbv:bt:${GLN}:QA-DESTROY-${RUN}` }],
  } }),
  distReceive: (sscc, label) => ({ role: 'distributor', label, event: {
    type: 'ObjectEvent', eventTimeZoneOffset: '+03:00', epcList: [ssccUri(sscc)], action: 'OBSERVE', bizStep: 'receiving', disposition: 'active',
    readPoint: { id: sglnUri(DIST_GLN) }, bizLocation: { id: sglnUri(DIST_GLN) },
    bizTransactionList: [{ type: 'recadv', bizTransaction: `urn:epcglobal:cbv:bt:${DIST_GLN}:GR-${RUN}` }],
    sourceList: [{ type: 'owning_party', source: sglnUri(MAH_GLN) }], destinationList: [{ type: 'owning_party', destination: sglnUri(DIST_GLN) }],
  } }),
  distShip: (sscc, label) => ({ role: 'distributor', label, event: {
    type: 'ObjectEvent', eventTimeZoneOffset: '+03:00', epcList: [ssccUri(sscc)], action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit',
    readPoint: { id: sglnUri(DIST_GLN) }, bizLocation: { id: sglnUri(DIST_GLN) },
    bizTransactionList: [{ type: 'desadv', bizTransaction: `urn:epcglobal:cbv:bt:${DIST_GLN}:ASN-${RUN}` }],
    sourceList: [{ type: 'owning_party', source: sglnUri(DIST_GLN) }],
    destinationList: [{ type: 'owning_party', destination: '{{fac_sgln}}' }, { type: 'location', destination: '{{fac_sgln}}' }],
  } }),
  facReceive: (sscc, label) => ({ role: 'facility', label, event: {
    type: 'ObjectEvent', eventTimeZoneOffset: '+03:00', epcList: [ssccUri(sscc)], action: 'OBSERVE', bizStep: 'receiving', disposition: 'active',
    readPoint: { id: '{{fac_sgln}}' }, bizLocation: { id: '{{fac_sgln}}' },
    bizTransactionList: [{ type: 'recadv', bizTransaction: `urn:epcglobal:cbv:bt:${DIST_GLN}:GR-FAC-${RUN}` }],
    sourceList: [{ type: 'owning_party', source: sglnUri(DIST_GLN) }], destinationList: [{ type: 'owning_party', destination: '{{fac_sgln}}' }],
  } }),
  dispense: (serial, label) => ({ role: 'dispense', label, event: {
    type: 'ObjectEvent', eventTimeZoneOffset: '+03:00', epcList: [sgtinUri(GTIN, serial)], action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed',
    readPoint: { id: '{{fac_sgln}}' }, bizLocation: { id: '{{fac_sgln}}' },
  } }),
};

// --- scenarios ----------------------------------------------------------------------------------
const AREAS = {
  T01: 'T1 Path', T02: 'T2 Commissioning', T03: 'T3 Packing', T04: 'T4 Shipping', T06: 'T6 Rule coverage',
  T07: 'T7 Field mapping', T08: 'T8 Grouping and order', T09: 'T9 Duplicates', T10: 'T10 Partial failure',
  T11: 'T11 Identity', T12: 'T12 Batch loophole', T13: 'T13 File handling', T14: 'T14 Volume',
  T15: 'T15 Downstream', T16: 'T16 Recall and status', T18: 'T18 Audit and security',
};

// guide: [outcome, code?, note?]. outcome is Accept, Flag or Reject.
const g = (outcome, code = '', note = '') => ({ outcome, code, note });
const NOT_SENT = (column) => g('Accept', '', `${column} has no field in the guide's EPCIS profile, so the twin does not send it`);

// Ship tests that need their own package, and what the regulator does with it.
const POOL_SPEC = {
  'T04-01': 'Leave pending', 'T04-02': 'Reject', 'T04-03': 'Approve', 'T04-04': 'Approve', 'T04-05': 'Approve', 'T04-06': 'Approve',
  'T04-07': 'Approve', 'T04-08': 'Approve', 'T04-09': 'Approve', 'T04-10': 'Approve', 'T04-11': 'Approve', 'T04-12': 'Approve',
  'T04-13': 'Approve', 'T04-14': 'Approve', 'T04-15': 'Approve', 'T04-16': 'Approve', 'T04-17': 'Approve', 'T04-18': 'Approve',
  'T04-21': 'Approve', 'T04-24': 'Approve', 'T04-26': 'Approve', 'T04-29a': 'Approve', 'T04-29b': 'Approve',
  'T07-01': 'Approve', 'T15-01': 'Approve', 'T16-01': 'Approve', 'T16-02': 'Approve',
};

function defineScenarios(ch) {
  clockMs = CLOCK_START;
  const list = [];
  const saved = {};
  const scenario = (id, slug, what, guide, build, opts = {}) => {
    const f = fileContext(id, ch);
    build(f);
    list.push({ id, slug, what, guide, f, ...opts });
  };
  const batch = (id, slug, what, guide, extra, opts) => scenario(id, slug, what, guide, (f) => {
    f.controls();
    f.flag(what, () => f.commission(f.serial(), extra));
  }, opts);
  const packRule = (id, slug, what, guide, extra, opts) => scenario(id, slug, what, guide, (f) => {
    const sn = f.commission();
    f.flag(what, () => f.pack(sn, f.sscc(), extra));
  }, opts);
  const boxRule = (id, slug, what, guide, extra, opts) => scenario(id, slug, what, guide, (f) => {
    const { kase } = f.caseOf();
    f.flag(what, () => f.box(kase, f.sscc(), extra));
  }, opts);
  const P = {};
  const shipRule = (id, slug, what, guide, extra, opts = {}) => scenario(id, slug, what, guide,
    (f) => f.flag(what, () => f.ship(P[id].pallet, extra)), { needs: 'T04-00 and its approvals', ...opts });

  // T1 path (manual, uses T02-01)
  scenario('T01-01', 'trace_upload_to_ledger', 'Trace one CSV event from upload to the ledger and compare it with its API twin', g('Accept'), () => {}, {
    manual: [
      'Use the first COMMISSIONING row of T02-01 (CSV) and its twin (API).',
      'In the Partner Portal API Logs, open both events and screenshot each: channel, validation result, rule or engine version if shown.',
      'Ask the devs (or check the import job record) whether the CSV import calls the same L5 ingest endpoint as the API, or writes to the database directly.',
      'PASS only if both events went through the same validation engine and rule version, and the CSV path has no direct write.',
    ],
  });

  // T2 commissioning
  scenario('T02-01', 'foreign_mah_single_lot', '5 items, one lot, foreign MAH (IMPORT, Germany, Bayer as MAH)', g('Accept'), (f) => {
    for (let i = 0; i < 5; i++) f.commission();
    saved.serial = f.rows[0][col.Unit_ID];
    saved.lot = f.lot;
  });
  scenario('T02-02', 'local_mah', 'Locally made product: origin LOCAL, country Kenya, no permit, no foreign MAH', g('Accept', '', 'the guide only asks for country of origin and the MAH source for foreign products'), (f) => {
    for (let i = 0; i < 2; i++) f.commission(f.serial(), { Manufacturing_Origin: 'LOCAL', Country_of_Origin: 'Kenya', Import_Sales_Permit_Ref: '', Sender_Owner_GLN: '', Sender_Owner_Name: '' });
  });
  scenario('T02-03', 'mixed_lots', 'Two lots in one file, rows interleaved', g('Accept', '', 'one lot per commissioning event (guide 3.1.1.1); the API twin sends one event per row'), (f) => {
    for (let i = 0; i < 2; i++) {
      f.commission();
      f.commission(f.serial(), { Lot_Batch_Number: `${f.lot}B` });
    }
  });
  batch('T02-04', 'missing_lot', 'Lot number blank', g('Reject', 'MISSING_NEEDED_FIELDS', 'guide 3.1.1: ILMD must carry lot and expiry'), { Lot_Batch_Number: '' });
  batch('T02-05', 'missing_expiry', 'Expiry date blank', g('Reject', 'MISSING_NEEDED_FIELDS', 'guide 3.1.1: ILMD must carry lot and expiry'), { Lot_Expiry_Date: '' });
  batch('T02-06', 'foreign_missing_country', 'Foreign MAH product with no country of origin', g('Reject', '', 'guide 3.1.1: countryOfOrigin is required for foreign MAH products; no code named'), { Country_of_Origin: '' });
  batch('T02-07', 'foreign_missing_mah_gln', 'Foreign MAH product with no MAH GLN (Sender_Owner_GLN blank)', g('Reject', '', 'guide 3.1.1: sourceList must include the foreign MAH GLN; no code named'), { Sender_Owner_GLN: '', Sender_Owner_Name: '' });
  batch('T02-08', 'missing_location', 'Location GLN blank (no bizLocation)', g('Reject', 'MISSING_NEEDED_FIELDS', 'guide 3: bizLocation is mandatory on every event'), { BizLocation_GLN: '' });
  const lotOf = (n, sfx) => `QA${ch.tag}${RUN}${'X'.repeat(n)}`.slice(0, n - sfx.length) + sfx;
  scenario('T02-09', 'lot_20_chars', 'Lot number at the GS1 maximum of 20 characters', g('Accept'), (f) => f.commission(f.serial(), { Lot_Batch_Number: lotOf(20, '209') }));
  batch('T02-10', 'lot_21_chars', 'Lot number of 21 characters (GS1 AI 10 allows 20)', g('Reject', 'INVALID_LOT', 'GS1 limit; the guide names no exact code'), { Lot_Batch_Number: lotOf(21, '210') });
  batch('T02-11', 'lot_forbidden_char', 'Lot number contains "#", outside the GS1 character set', g('Reject', '', 'GS1 character set; no code named'), { Lot_Batch_Number: `LOT#${ch.tag}${RUN}211` });
  scenario('T02-12', 'serial_20_chars', 'Serial at the GS1 maximum of 20 characters', g('Accept'), (f) => f.commission(`S${ch.tag}${RUN}212`.padEnd(20, 'A')));
  batch('T02-13', 'serial_21_chars', 'Serial of 21 characters (GS1 AI 21 allows 20)', g('Reject', 'INVALID_GS1_IDENTIFIER'), { Unit_ID: `S${ch.tag}${RUN}213`.padEnd(21, 'A') });
  batch('T02-14', 'serial_forbidden_char', 'Serial contains "#", outside the GS1 character set', g('Reject', 'INVALID_GS1_IDENTIFIER'), { Unit_ID: `SN#${ch.tag}${RUN}214` });
  scenario('T02-15', 'serial_allowed_specials', 'Serials using the GS1 specials - _ . / (the twin escapes / as %2F)', g('Accept'), (f) => {
    for (const c of ['-', '_', '.', '/']) f.commission(`Sp${ch.tag}${RUN}${c}${c.charCodeAt(0)}a`);
  });
  batch('T02-16', 'serial_blank', 'Serial blank', g('Reject', 'MISSING_NEEDED_FIELDS'), { Unit_ID: '' });
  batch('T02-17', 'gtin_bad_check_digit', 'GTIN with a wrong check digit', g('Reject', 'INVALID_GTIN_CHECK_DIGIT'), { GTIN: breakCheck(GTIN) });
  batch('T02-18', 'gtin_not_registered', `GTIN ${UNKNOWN_GTIN}: valid check digit, not a registered product`, g('Flag', 'UNKNOWN_SGTIN'), { GTIN: UNKNOWN_GTIN });
  batch('T02-19', 'gtin_11_digits', 'GTIN of 11 digits', g('Reject', 'INVALID_GS1_IDENTIFIER'), { GTIN: GTIN.slice(0, 11) });
  batch('T02-20', 'gtin_padded_14', 'The same GTIN written as 14 digits with a leading zero', g('Accept', '', 'GTIN-13 and its zero-padded GTIN-14 are the same GTIN'), { GTIN: GTIN.padStart(14, '0') });
  batch('T02-21', 'gtin_blank', 'GTIN blank', g('Reject', 'MISSING_NEEDED_FIELDS'), { GTIN: '' });
  batch('T02-22', 'expiry_past', 'Expiry date 2025-01-01, already past', g('Flag', 'EXPIRED_PRODUCT'), { Lot_Expiry_Date: '2025-01-01' });
  batch('T02-23', 'expiry_wrong_format', 'Expiry date written DD/MM/YYYY', g('Reject', 'INVALID_EXPIRY_FORMAT'), { Lot_Expiry_Date: `01/${ymd.slice(5, 7)}/${YEAR + 2}` });
  batch('T02-24', 'expiry_impossible_date', `Expiry date ${YEAR + 2}-02-30, which does not exist`, g('Reject', 'INVALID_EXPIRY_FORMAT'), { Lot_Expiry_Date: `${YEAR + 2}-02-30` });
  batch('T02-25', 'expiry_before_manufacture', 'Expiry date earlier than the manufacturing date', NOT_SENT('Lot_Manufacturing_Date'), { Lot_Manufacturing_Date: `${YEAR + 3}-06-01` });
  batch('T02-26', 'manufacture_future', `Manufacturing date ${YEAR + 1}-06-01, in the future`, NOT_SENT('Lot_Manufacturing_Date'), { Lot_Manufacturing_Date: `${YEAR + 1}-06-01` });
  scenario('T02-27', 'lot_two_expiries_same_file', 'One lot given two different expiry dates in one file', g('Flag', 'INVALID_LOT', 'no explicit rule; INVALID_LOT is the nearest code'), (f) => {
    f.commission();
    f.flag('Second expiry date for the same lot', () => f.commission(f.serial(), { Lot_Expiry_Date: `${YEAR + 3}-01-01` }));
  });
  scenario('T02-28', 'one_lot_two_products', 'One lot number used on two products', g('Accept', '', 'lots are registered per GTIN, so the same lot text on two GTINs is two lots'), (f) => {
    f.commission();
    f.commission(f.serial(), { GTIN: GTIN2 });
  });
  batch('T02-29', 'existing_lot_top_up', 'New serials added to the T02-01 lot, same dates', g('Accept'), { Lot_Batch_Number: saved.lot }, { needs: 'T02-01' });
  batch('T02-30', 'existing_lot_other_expiry', 'T02-01 lot re-commissioned with a different expiry date', g('Flag', 'INVALID_LOT', 'no explicit rule; INVALID_LOT is the nearest code'), { Lot_Batch_Number: saved.lot, Lot_Expiry_Date: `${YEAR + 3}-01-01` }, { needs: 'T02-01' });
  batch('T02-31', 'gln_bad_check_digit', 'Location GLN 0614141000016 (the template value), wrong check digit', g('Reject', 'INVALID_GLN_CHECK_DIGIT'), { BizLocation_GLN: '0614141000016' });
  batch('T02-32', 'gln_short', 'Location GLN of 7 digits', g('Reject', 'INVALID_GS1_IDENTIFIER'), { BizLocation_GLN: GLN.slice(0, 7) });
  batch('T02-33', 'gln_unregistered', `Location GLN ${UNKNOWN_GLN}: valid, not registered`, g('Flag', 'UNKNOWN_SGLN'), { BizLocation_GLN: UNKNOWN_GLN });
  scenario('T02-34', 'serial_twice_same_file', 'The same serial commissioned twice in one file', g('Flag', 'INVALID_EVENT_SEQUENCE', 'no explicit rule for re-commissioning; nearest code'), (f) => {
    const sn = f.commission();
    f.commission();
    f.flag('Repeats the serial on line 2', () => f.commission(sn));
  });
  batch('T02-35', 'serial_from_other_lot', 'A T02-01 serial commissioned again under a new lot', g('Flag', 'INVALID_EVENT_SEQUENCE', 'no explicit rule for re-commissioning; nearest code'), { Unit_ID: saved.serial }, { needs: 'T02-01' });
  batch('T02-36', 'same_serial_other_product', 'A T02-01 serial on a different product (a new GTIN + serial pair)', g('Accept'), { Unit_ID: saved.serial, GTIN: GTIN2 }, { needs: 'T02-01' });
  batch('T02-37', 'event_type_blank', 'Event_Type blank', g('Reject', 'MISSING_NEEDED_FIELDS'), { Event_Type: '' });
  batch('T02-38', 'event_type_misspelled', 'Event_Type "COMISSIONING"', g('Reject'), { Event_Type: 'COMISSIONING' });
  batch('T02-39', 'event_type_lowercase', 'Event_Type "commissioning" in lower case', g('Reject', '', 'the template values are fixed upper-case codes'), { Event_Type: 'commissioning' });
  batch('T02-40', 'eighteen_digit_serial', 'SGTIN whose serial is 18 digits (looks like an SSCC, but is a legal serial)', g('Accept'), { Unit_ID: gs1(`06164003${ch.digit}${SSCC_RUN}0240999`) });
  batch('T02-41', 'packaging_level_pallet', 'Packaging_Level "Pallet", not a template value', NOT_SENT('Packaging_Level'), { Packaging_Level: 'Pallet' });
  batch('T02-42', 'packaging_level_case_on_item', 'Item commissioned with Packaging_Level "Case"', NOT_SENT('Packaging_Level'), { Packaging_Level: 'Case' });
  batch('T02-43', 'event_time_future', `Event time in ${YEAR + 1}`, g('Reject', 'FUTURE_EVENT_TIME'), { Event_Timestamp: `${YEAR + 1}-01-01T08:15:00` });
  batch('T02-44', 'event_time_wrong_format', 'Event time written DD/MM/YYYY HH:MM', g('Reject', 'INVALID_JSON_STRUCTURE'), { Event_Timestamp: `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${YEAR} 08:15` });
  batch('T02-45', 'event_time_impossible', 'Event time with month 13 and hour 99', g('Reject', 'INVALID_JSON_STRUCTURE'), { Event_Timestamp: `${YEAR}-13-45T99:00:00` });
  batch('T02-46', 'event_time_blank', 'Event time blank', g('Reject', 'MISSING_NEEDED_FIELDS'), { Event_Timestamp: '' });
  batch('T02-47', 'timezone_out_of_range', 'Time zone offset +25:00', g('Reject', 'INVALID_JSON_STRUCTURE'), { Event_TimeZone_Offset: '+25:00' });
  batch('T02-48', 'timezone_blank', 'Time zone offset blank', g('Reject', 'MISSING_NEEDED_FIELDS'), { Event_TimeZone_Offset: '' });
  batch('T02-49', 'timezone_other_valid', 'Valid non-Nairobi offset -05:00 (UTC conversion check)', g('Accept'), { Event_TimeZone_Offset: '-05:00' });
  batch('T02-50', 'permit_blank', 'Import permit blank on an IMPORT row', NOT_SENT('Import_Sales_Permit_Ref'), { Import_Sales_Permit_Ref: '' });
  batch('T02-51', 'origin_invalid', 'Manufacturing_Origin "SPACE"', NOT_SENT('Manufacturing_Origin'), { Manufacturing_Origin: 'SPACE' });
  batch('T02-52', 'origin_blank', 'Manufacturing_Origin blank', NOT_SENT('Manufacturing_Origin'), { Manufacturing_Origin: '' });

  // T3 packing
  scenario('T03-01', 'item_to_case', '5 items packed into one case', g('Accept'), (f) => {
    const { kase, serials } = f.caseOf(5);
    saved.case1 = kase;
    saved.packed = serials[0];
  });
  scenario('T03-02', 'case_to_pallet', '2 cases packed into one pallet', g('Accept'), (f) => {
    const pallet = f.sscc();
    const a = f.caseOf();
    f.box(a.kase, pallet);
    f.box(f.caseOf().kase, pallet);
    saved.boxedCase = a.kase;
  });
  scenario('T03-03', 'two_products_one_case', 'Two products in one case', g('Accept'), (f) => {
    const kase = f.sscc();
    const a = f.commission();
    const b = f.commission(f.serial(), { GTIN: GTIN2, Lot_Batch_Number: `${f.lot}B` });
    f.pack(a, kase);
    f.pack(b, kase, { GTIN: GTIN2 });
  });
  scenario('T03-04', 'two_lots_one_case', 'Two lots of one product in one case', g('Accept'), (f) => {
    const kase = f.sscc();
    const a = f.commission();
    const b = f.commission(f.serial(), { Lot_Batch_Number: `${f.lot}B` });
    f.pack(a, kase);
    f.pack(b, kase);
  });
  scenario('T03-05', 'single_item_case', 'A case holding one item', g('Accept'), (f) => f.caseOf(1));
  scenario('T03-06', 'four_levels', 'Item > case > pallet > pallet: four levels', g('Reject', '', 'guide 3: maximum hierarchy is 3 levels; no code named'), (f) => {
    const { pallet } = f.packageOf();
    f.flag('Fourth level', () => f.box(pallet, f.sscc()));
  });
  scenario('T03-07', 'two_parents_same_file', 'One item packed into two cases in one file', g('Flag', 'CHILD_ALREADY_AGGREGATED'), (f) => {
    const sn = f.commission();
    f.pack(sn, f.sscc());
    f.flag('Item already has a parent (line 3)', () => f.pack(sn, f.sscc()));
  });
  scenario('T03-08', 'two_parents_across_files', 'A T03-01 item packed into a new case', g('Flag', 'CHILD_ALREADY_AGGREGATED'), (f) => {
    f.flag('Item already in a case from T03-01', () => f.pack(saved.packed, f.sscc()));
  }, { needs: 'T03-01' });
  scenario('T03-09', 'cyclic_hierarchy', 'Two SSCCs, each the parent of the other', g('Flag', 'INVALID_PARENT_CHILD_RELATION'), (f) => {
    const { kase } = f.caseOf();
    const pallet = f.sscc();
    f.box(kase, pallet);
    f.flag('Closes a loop with the row above', () => f.box(pallet, kase));
  });
  scenario('T03-10', 'self_parent', 'A case listed as its own parent', g('Flag', 'INVALID_PARENT_CHILD_RELATION'), (f) => {
    const { kase } = f.caseOf();
    f.flag('Unit_ID equals Parent_ID', () => f.box(kase, kase));
  });
  scenario('T03-11', 'sscc_under_sgtin', 'A case SSCC packed under an item serial (SGTIN as parent)', g('Flag', 'INVALID_PARENT_CHILD_RELATION'), (f) => {
    const sn = f.commission();
    const { kase } = f.caseOf();
    f.flag('Parent is an item serial', () => f.add({
      Event_Type: 'AGGREGATION', Identifier_Type: 'SSCC', GTIN, Unit_ID: kase, Parent_ID: sn, Packaging_Level: 'Case',
      Event_Timestamp: tick(), Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN,
    }, { parentUri: sgtinUri(GTIN, sn) }));
  });
  scenario('T03-12', 'mixed_locations', `Items commissioned at ${GLN}, packed at a second site ${SECOND_GLN}`, g('Flag', 'INVENTORY_SIGHTING_MISMATCH', 'guide 3.1.2: children must be at the packing bizLocation'), (f) => {
    const kase = f.sscc();
    const sn = f.commission();
    f.flag('Packed at a different location from where it was commissioned', () => f.pack(sn, kase, { BizLocation_GLN: SECOND_GLN }));
  });
  scenario('T03-13', 'uncommissioned_child', 'A serial that was never commissioned packed into a case', g('Flag', 'UNCOMMISSIONED_CHILD'), (f) => {
    const kase = f.sscc();
    f.pack(f.commission(), kase);
    f.flag('Serial never commissioned', () => f.pack(f.serial(), kase));
  });
  scenario('T03-14', 'empty_case_boxed', 'A case SSCC with no items boxed into a pallet', g('Flag', 'UNCOMMISSIONED_CHILD'), (f) => {
    f.controls();
    f.flag('Case was never packed', () => f.box(f.sscc(), f.sscc()));
  });
  packRule('T03-15', 'parent_blank', 'Pack row with no parent SSCC', g('Reject', 'MISSING_NEEDED_FIELDS'), { Parent_ID: '' });
  packRule('T03-16', 'parent_bad_check_digit', 'Parent SSCC with a wrong check digit', g('Reject', 'INVALID_SSCC_CHECK_DIGIT'), { Parent_ID: breakCheck(gs1(`06164003${ch.digit}${SSCC_RUN}0316999`)) });
  packRule('T03-17', 'parent_17_digits', 'Parent SSCC of 17 digits', g('Reject', 'INVALID_GS1_IDENTIFIER'), { Parent_ID: `06164003${ch.digit}${SSCC_RUN}0317999` });
  packRule('T03-18', 'parent_19_digits', 'Parent SSCC of 19 digits', g('Reject', 'INVALID_GS1_IDENTIFIER'), { Parent_ID: `${gs1(`06164003${ch.digit}${SSCC_RUN}0318999`)}0` });
  packRule('T03-19', 'parent_portal_label', 'Parent written as a portal label "CASE-MAN001-1", not an SSCC', g('Reject', 'INVALID_GS1_IDENTIFIER'), { Parent_ID: 'CASE-MAN001-1' });
  scenario('T03-20', 'packed_before_commissioned', 'Pack time 2 days before the commissioning time', g('Flag', 'INVALID_EVENT_SEQUENCE'), (f) => {
    const sn = f.commission();
    f.flag('Pack event earlier than commissioning', () => f.pack(sn, f.sscc(), { Event_Timestamp: nairobi(now.getTime() - 3 * 86400_000) }));
  });
  scenario('T03-21', 'rows_out_of_order', 'Pack row above its commissioning row; timestamps in the right order', g('Accept', '', 'guide 6.1.3: events are accepted in any order'), (f) => {
    const sn = f.serial();
    const kase = f.sscc();
    const packTime = nairobi(clockMs + 5000);
    f.pack(sn, kase, { Event_Timestamp: packTime });
    f.commission(sn);
    clockMs += 5000;
  });
  packRule('T03-22', 'child_gtin_mismatch', 'Pack row names a different product from the commissioned one', g('Flag', 'UNCOMMISSIONED_CHILD'), { GTIN: GTIN2 });
  packRule('T03-23', 'child_gtin_blank', 'Pack row with no GTIN for an SGTIN child', g('Reject', 'MISSING_NEEDED_FIELDS'), { GTIN: '' });
  packRule('T03-24', 'item_marked_sscc', 'Item serial marked Identifier_Type SSCC', g('Reject', 'INVALID_GS1_IDENTIFIER'), { Identifier_Type: 'SSCC' });
  packRule('T03-25', 'item_marked_package', 'Item marked Packaging_Level "Package"', NOT_SENT('Packaging_Level'), { Packaging_Level: 'Package' });
  scenario('T03-26', 'add_to_existing_case', 'A new item added to the T03-01 case', g('Accept', '', 'no rule seals a case'), (f) => {
    const sn = f.commission();
    f.flag(`Case from T03-01`, () => f.pack(sn, saved.case1));
  }, { needs: 'T03-01' });
  scenario('T03-27', 'loose_item_in_pallet', 'A loose item packed straight into a pallet beside a case', g('Accept', '', 'no rule bars mixed levels'), (f) => {
    const { pallet } = f.packageOf();
    const sn = f.commission();
    f.flag('Item skips the case level', () => f.pack(sn, pallet));
  });
  scenario('T03-28', 'case_in_two_pallets_same_file', 'One case boxed into two pallets in one file', g('Flag', 'CHILD_ALREADY_AGGREGATED'), (f) => {
    const { kase } = f.caseOf();
    f.box(kase, f.sscc());
    f.flag('Case already has a parent', () => f.box(kase, f.sscc()));
  });
  scenario('T03-29', 'case_already_boxed', 'A T03-02 case boxed into a new pallet', g('Flag', 'CHILD_ALREADY_AGGREGATED'), (f) => {
    f.flag('Case already in a pallet from T03-02', () => f.box(saved.boxedCase, f.sscc()));
  }, { needs: 'T03-02' });
  scenario('T03-30', 'unknown_case_boxed', 'Boxing a case SSCC that does not exist', g('Flag', 'UNCOMMISSIONED_CHILD'), (f) => {
    f.flag('Case never created', () => f.box(f.sscc(), f.sscc()));
  });
  scenario('T03-31', 'boxed_before_packed', 'Case boxed 2 days before its items were packed', g('Flag', 'INVALID_EVENT_SEQUENCE'), (f) => {
    const { kase } = f.caseOf();
    f.flag('Boxing earlier than packing', () => f.box(kase, f.sscc(), { Event_Timestamp: nairobi(now.getTime() - 3 * 86400_000) }));
  });
  boxRule('T03-32', 'case_marked_sgtin', 'Case SSCC marked Identifier_Type SGTIN (becomes an unknown SGTIN)', g('Flag', 'UNCOMMISSIONED_CHILD'), { Identifier_Type: 'SGTIN', GTIN });
  boxRule('T03-33', 'case_marked_item', 'Case marked Packaging_Level "Item"', NOT_SENT('Packaging_Level'), { Packaging_Level: 'Item' });

  // T4 shipping
  scenario('T04-00', 'setup_packages', `${Object.keys(POOL_SPEC).length} packages for the shipping, mapping, downstream and recall tests`, g('Accept'), (f) => {
    for (const key of Object.keys(POOL_SPEC)) P[key] = f.packageOf();
  });
  saved.pool = P;
  shipRule('T04-01', 'ship_pending_package', 'Ship a package still pending PPB approval', g('Flag', 'NO_REGULATORY_APPROVAL'), {});
  shipRule('T04-02', 'ship_rejected_package', 'Ship a package PPB rejected', g('Flag', 'NO_REGULATORY_APPROVAL'), {});
  shipRule('T04-03', 'ship_approved_package', 'Ship an approved package (SSCC)', g('Accept'), {});
  scenario('T04-04', 'ship_child_sgtin_active_parent', 'Ship one item serial that is still inside an active case', g('Accept', '', 'no explicit rule; record any flag'), (f) => {
    f.flag('Item is still aggregated', () => f.ship(P['T04-04'].serials[0], { Identifier_Type: 'SGTIN', GTIN, Packaging_Level: 'Item' }));
  }, { needs: 'T04-00 and its approvals' });
  shipRule('T04-05', 'missing_transaction', 'Transaction type and reference both blank', g('Reject', 'MISSING_NEEDED_FIELDS', 'guide 3: bizTransactionList is mandatory on shipping'), { Transaction_Type: '', Transaction_Reference: '' });
  shipRule('T04-06', 'missing_reference_only', 'Transaction reference blank (type given)', g('Reject', 'MISSING_NEEDED_FIELDS', 'a generated reference would be a silent default'), { Transaction_Reference: '' });
  shipRule('T04-07', 'missing_source', 'Sender owner and custodian blank', g('Reject', 'MISSING_NEEDED_FIELDS'), { Sender_Owner_GLN: '', Sender_Owner_Name: '', Sender_Custodian_GLN: '' });
  shipRule('T04-08', 'missing_destination', 'Receiver owner and custodian blank', g('Reject', 'MISSING_NEEDED_FIELDS'), { Receiver_Owner_GLN: '', Receiver_Owner_Name: '', Receiver_Custodian_GLN: '' });
  shipRule('T04-09', 'receiver_owner_only', 'Receiver custodian blank, owner given', g('Accept'), { Receiver_Custodian_GLN: '' });
  shipRule('T04-10', 'owner_custodian_differ', `Different owner and custodian on both ends (carrier ${LSP_GLN} holds it; KEMSA depot ${DEPOT_GLN} receives)`, g('Accept', '', 'mapping check: custodian goes to possessing_party, not owning_party'), { Sender_Custodian_GLN: LSP_GLN, Receiver_Custodian_GLN: DEPOT_GLN });
  shipRule('T04-11', 'no_logistics_provider', 'Logistics provider blank', NOT_SENT('LSP_GLN'), { LSP_GLN: '', LSP_Name: '' });
  shipRule('T04-12', 'pickup_name_blank', 'Pickup location name blank', NOT_SENT('Sender_Location_Name'), { Sender_Location_Name: '' });
  shipRule('T04-13', 'destination_name_blank', 'Destination name blank', NOT_SENT('Receiver_Location_Name'), { Receiver_Location_Name: '' });
  shipRule('T04-14', 'transaction_type_invalid', 'Transaction type "invoice_xyz" (not a CBV type)', g('Reject', '', 'not a CBV business transaction type; no code named'), { Transaction_Type: 'invoice_xyz' });
  shipRule('T04-15', 'receiver_unregistered', `Receiver GLN ${UNKNOWN_GLN}: valid, not registered`, g('Flag', 'UNKNOWN_SGLN'), { Receiver_Owner_GLN: UNKNOWN_GLN, Receiver_Custodian_GLN: UNKNOWN_GLN });
  shipRule('T04-16', 'receiver_bad_check_digit', 'Receiver GLN 0614142000013 (the template value), wrong check digit', g('Reject', 'INVALID_GLN_CHECK_DIGIT'), { Receiver_Owner_GLN: '0614142000013', Receiver_Custodian_GLN: '0614142000013' });
  shipRule('T04-17', 'ship_to_self', 'Receiver is the sender', g('Accept', '', 'no rule; record any flag'), { Receiver_Owner_GLN: MAH_GLN, Receiver_Custodian_GLN: MAH_GLN });
  shipRule('T04-18', 'ship_before_packed', 'Ship time 2 days before the package was built', g('Flag', 'INVALID_EVENT_SEQUENCE'), { Event_Timestamp: nairobi(now.getTime() - 3 * 86400_000) });
  scenario('T04-19', 'ship_unknown_sscc', 'Ship an SSCC that does not exist', g('Flag', 'SHIPPING_WITHOUT_COMMISSIONING'), (f) => {
    f.flag('SSCC never created', () => f.ship(f.sscc()));
  });
  scenario('T04-20', 'ship_bad_check_digit', 'Shipped SSCC with a wrong check digit', g('Reject', 'INVALID_SSCC_CHECK_DIGIT'), (f) => {
    f.flag('SSCC check digit wrong', () => f.ship(breakCheck(P['T04-03'].pallet)));
  }, { needs: 'T04-00' });
  scenario('T04-21', 'ship_case_inside_pallet', 'Ship a case that is still inside its pallet', g('Accept', '', 'no explicit rule; record any flag'), (f) => {
    f.flag('Case is still aggregated', () => f.ship(P['T04-21'].kase, { Packaging_Level: 'Case' }));
  }, { needs: 'T04-00 and its approvals' });
  scenario('T04-22', 'ship_loose_item', 'Ship a single commissioned item that is in no case', g('Accept', '', 'no explicit rule; record any flag'), (f) => {
    const sn = f.commission();
    f.flag('Item shipped on its own', () => f.ship(sn, { Identifier_Type: 'SGTIN', GTIN, Packaging_Level: 'Item' }));
  });
  scenario('T04-23', 'ship_blank_unit', 'SHIPPING row with no SSCC', g('Reject', 'MISSING_NEEDED_FIELDS'), (f) => {
    f.flag('Unit_ID blank', () => f.ship(''));
  });
  shipRule('T04-24', 'permit_blank', 'Import permit blank on SHIPPING', NOT_SENT('Import_Sales_Permit_Ref'), { Import_Sales_Permit_Ref: '' });
  scenario('T04-25', 'ship_already_shipped', 'Ship the T04-03 package again', g('Flag', 'INVALID_DISPOSITION', 'guide: prior disposition must be active'), (f) => {
    f.flag('Package already in transit', () => f.ship(P['T04-03'].pallet));
  }, { needs: 'T04-03' });
  scenario('T04-26', 'ship_twice_same_file', 'One package shipped twice in one file', g('Flag', 'INVALID_DISPOSITION'), (f) => {
    f.ship(P['T04-26'].pallet);
    f.flag('Shipped on line 2', () => f.ship(P['T04-26'].pallet));
  }, { needs: 'T04-00 and its approvals' });
  scenario('T04-27', 'pack_into_shipped_package', 'A new case added to the shipped T04-03 package', g('Flag', 'INVALID_DISPOSITION', 'parent is in transit; no code named'), (f) => {
    const { kase } = f.caseOf();
    f.flag('Parent already shipped', () => f.box(kase, P['T04-03'].pallet));
  }, { needs: 'T04-03' });
  scenario('T04-28', 'child_in_transit', 'An item from the shipped T04-03 package packed into a new case', g('Flag', 'INVALID_DISPOSITION', 'child is in transit; no code named'), (f) => {
    f.flag('Child in transit', () => f.pack(P['T04-03'].serials[0], f.sscc()));
  }, { needs: 'T04-03' });
  scenario('T04-29', 'two_packages_one_reference', 'Two approved packages on one transaction reference', g('Accept'), (f) => {
    const ref = `INV-${RUN}${ch.tag}429`;
    f.ship(P['T04-29a'].pallet, { Transaction_Reference: ref });
    f.ship(P['T04-29b'].pallet, { Transaction_Reference: ref });
  }, { needs: 'T04-00 and its approvals' });

  // T6 rule coverage (codes not reached by another area)
  batch('T06-01', 'expiring_soon', `Expiry ${dayOffset(30)}, inside 90 days`, g('Flag', 'EXPIRING_SOON'), { Lot_Expiry_Date: dayOffset(30) });
  batch('T06-02', 'expiry_91_days', `Expiry ${dayOffset(91)}, just outside 90 days`, g('Accept'), { Lot_Expiry_Date: dayOffset(91) });
  batch('T06-03', 'stale_event_time', 'Event time 10 days ago', g('Flag', 'STALE_EVENT_TIME'), { Event_Timestamp: nairobi(now.getTime() - 10 * 86400_000) });
  scenario('T06-04', 'commission_for_destroy', '2 items commissioned, to be destroyed through the API before T06-05', g('Accept'), (f) => {
    saved.toDestroy = [f.commission(), f.commission()];
  });
  list.at(-1).after = [support.destroy(saved.toDestroy, 'destroy the 2 T06-04 items (run after uploading T06-04)')];
  scenario('T06-05', 'pack_destroyed_items', 'Pack the 2 destroyed T06-04 items into a case', g('Flag', 'INVALID_TERMINAL_STATE', 'SERIAL_ALREADY_DESTROYED is also plausible'), (f) => {
    const kase = f.sscc();
    for (const sn of saved.toDestroy) f.flag('Item is destroyed', () => f.pack(sn, kase));
  }, { needs: 'T06-04 and its destroy request' });

  // T7 field mapping
  shipRule('T07-01', 'mapping_probe_ship', 'Every shipping column filled with distinct values, to compare field by field with the twin', g('Accept'), { Sender_Custodian_GLN: LSP_GLN, Receiver_Custodian_GLN: DEPOT_GLN }, {
    manual: [
      'Open this CSV event and its twin in the API Logs payload view. Also open the T02-01 and T03-02 events (commissioning and packing).',
      'Check each column against the Field mapping sheet: GLN to SGLN, local time to UTC with the offset kept, CBV values, owner vs custodian.',
      'Any value L4 adds that is not in the CSV (a default reference, a default location, a generated serial) is a silent default: FAIL.',
    ],
  });

  // T8 grouping and order
  scenario('T08-01', 'shuffled_rows', 'A full hierarchy (6 items, 2 cases, 1 pallet) with rows shuffled; timestamps correct', g('Accept', '', 'guide 6.1.3: any order'), (f) => {
    const pallet = f.sscc();
    f.box(f.caseOf(3).kase, pallet);
    f.box(f.caseOf(3).kase, pallet);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const order = f.rows.map((r, i) => [rnd(), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    f.rows = order.map((i) => f.rows[i]);
    f.meta = order.map((i) => f.meta[i]);
  });
  scenario('T08-02a', 'spanning_files_commission', '10 items commissioned (the hierarchy finishes in T08-02b)', g('Accept'), (f) => {
    saved.span = Array.from({ length: 10 }, () => f.commission());
  });
  scenario('T08-02b', 'spanning_files_pack', 'The T08-02a items packed into 2 cases and 1 pallet', g('Accept'), (f) => {
    const pallet = f.sscc();
    for (const half of [saved.span.slice(0, 5), saved.span.slice(5)]) {
      const kase = f.sscc();
      half.forEach((sn) => f.pack(sn, kase));
      f.box(kase, pallet);
    }
  }, { needs: 'T08-02a processed' });
  scenario('T08-03a', 'split_files_commission', '200 items commissioned; upload T08-03b straight after, without waiting', g('Accept'), (f) => {
    saved.split = Array.from({ length: 200 }, () => f.commission());
  });
  scenario('T08-03b', 'split_files_pack', 'The T08-03a items packed into 20 cases and 2 pallets', g('Accept', '', 'no false UNCOMMISSIONED_CHILD from a processing race'), (f) => {
    for (let p = 0; p < 2; p++) {
      const pallet = f.sscc();
      for (let k = 0; k < 10; k++) {
        const kase = f.sscc();
        saved.split.slice((p * 10 + k) * 10, (p * 10 + k + 1) * 10).forEach((sn) => f.pack(sn, kase));
        f.box(kase, pallet);
      }
    }
  }, { needs: 'T08-03a uploaded seconds before' });
  scenario('T08-04', 'three_lots_interleaved', 'Three lots, rows interleaved', g('Accept'), (f) => {
    for (let i = 0; i < 3; i++) for (const sfx of ['', 'B', 'C']) f.commission(f.serial(), { Lot_Batch_Number: `${f.lot}${sfx}` });
  });

  // T9 duplicates
  scenario('T09-01', 'original', '5 items, 1 case, 1 pallet', g('Accept'), (f) => {
    const p = f.packageOf(5);
    saved.dupSerial = p.serials[0];
  });
  scenario('T09-02', 'same_file_again', 'Byte-identical copy of T09-01 (the twin re-sends the same eventIDs)', g('Reject', 'DUPLICATE_EVENT_ID', 'DUPLICATE_EVENT_PAYLOAD is also correct'), () => {}, { copyOf: 'T09-01', needs: 'T09-01 processed' });
  scenario('T09-03', 'retry_after_timeout', '5 items; upload twice in quick succession, as a retry after a timeout would', g('Accept', '', 'second submission must add nothing'), (f) => {
    for (let i = 0; i < 5; i++) f.commission();
  }, { twice: true });
  batch('T09-04', 'serial_repeated_across_files', 'A T09-01 serial commissioned again in a new file', g('Flag', 'INVALID_EVENT_SEQUENCE', 'no explicit rule for re-commissioning'), { Unit_ID: saved.dupSerial }, { needs: 'T09-01' });
  scenario('T09-05', 'epc_twice_in_one_event', 'Two identical pack rows: the same item into the same case at the same time', g('Reject', 'DUPLICATE_EPC_IN_EVENT'), (f) => {
    const kase = f.sscc();
    const sn = f.commission();
    f.pack(sn, kase);
    f.rows.push([...f.rows.at(-1)]);
    f.meta.push({});
    f.flagged.push({ line: f.rows.length + 1, why: 'Same EPC again in the same event' });
  }, { merge: 'parent' });

  // T10 partial failure (the bad row is a future event time, which both channels can carry)
  const futureRow = { Event_Timestamp: `${YEAR + 1}-01-01T08:15:00` };
  scenario('T10-01', 'one_bad_of_1', 'A file of 1 row, and it is bad', g('Reject', 'FUTURE_EVENT_TIME'), (f) => f.flag('Future event time', () => f.commission(f.serial(), futureRow)));
  const bulkWithBad = (n) => (f) => {
    for (let i = 0; i < n; i++) {
      if (i === Math.floor(n / 2)) f.flag('Future event time', () => f.commission(f.serial(), futureRow));
      else f.commission();
    }
  };
  scenario('T10-02', 'one_bad_of_100', '100 rows, row 51 bad', g('Reject', 'FUTURE_EVENT_TIME', 'the other 99 follow whatever the API does: 207 partial or 400 whole'), bulkWithBad(100));
  saved.hundred = list.at(-1).f;
  scenario('T10-03', 'one_bad_of_10000', '10,000 rows, row 5,001 bad', g('Reject', 'FUTURE_EVENT_TIME', 'same partial rule as T10-02'), bulkWithBad(10000));
  scenario('T10-04', 'resubmit_fixed_100', 'T10-02 with the bad row fixed, uploaded again', g('Accept', '', 'only the fixed row is new; the 99 must not be stored twice'), (f) => {
    // Same rows as T10-02; the bad row gets the time halfway between its neighbours.
    const src = saved.hundred;
    const bad = src.flagged[0].line - 2;
    f.rows = src.rows.map((r) => [...r]);
    f.rows[bad][col.Event_Timestamp] = nairobi(Date.parse(`${src.rows[bad - 1][col.Event_Timestamp]}+03:00`) + 500);
    f.meta = src.rows.map(() => ({}));
    f.flagged.push({ line: bad + 2, why: 'The fixed row: the only new event' });
  }, { needs: 'T10-02 processed' });

  // T11 identity
  batch('T11-01', 'other_partner_location', `Location GLN ${DIST_GLN}, which belongs to KEMSA (a distributor)`, g('Reject', '', 'a partner may not submit for another partner\'s GLN; no code named'), { BizLocation_GLN: DIST_GLN });
  batch('T11-02', 'other_partner_product', `GTIN ${OTHER_MAH_GTIN} (Xarelto, Bayer). Confirm it is not one of your products first`, g('Reject', '', 'a partner may not commission another partner\'s product; no code named'), { GTIN: OTHER_MAH_GTIN });
  scenario('T11-03', 'inspection_event', 'A manufacturer row claiming a PPB inspection (Event_Type INSPECTING)', g('Flag', 'UNAUTHORIZED_INSPECTING_EVENT'), (f) => {
    const { pallet } = f.packageOf();
    f.flag('Only PPB may submit inspections', () => f.add({
      Event_Type: 'INSPECTING', Identifier_Type: 'SSCC', Unit_ID: pallet, Packaging_Level: 'Package',
      Event_Timestamp: tick(), Event_TimeZone_Offset: '+03:00', BizLocation_GLN: GLN,
    }, { twinEvent: {
      type: 'ObjectEvent', eventTime: new Date(clockMs - 3 * 3600_000).toISOString(), eventTimeZoneOffset: '+03:00', epcList: [ssccUri(pallet)],
      action: 'OBSERVE', bizStep: 'inspecting', disposition: 'active', readPoint: { id: sglnUri(GLN) }, bizLocation: { id: sglnUri(GLN) },
    } }));
  });
  scenario('T11-04', 'identity_probe', '3 valid items, for the session and X-User-Id checks', g('Accept'), (f) => {
    for (let i = 0; i < 3; i++) f.commission();
  }, {
    manual: [
      'Upload it normally and check the stored events name your manufacturer as the submitter (API Logs / event detail).',
      'Expired session: sign in, wait for the session to expire (or delete the session cookie in DevTools), then upload. Expected: blocked with a sign-in prompt, nothing stored.',
      'Tampered X-User-Id: in DevTools, copy the upload request as fetch, change X-User-Id to another user\'s id, replay it. Expected: rejected (401/403), nothing stored, nothing attributed to the other user.',
    ],
  });

  // T12 batch loophole
  scenario('T12-01', 'blank_serials', '3 rows with GTIN, lot and expiry but no serial', g('Reject', 'MISSING_NEEDED_FIELDS'), (f) => {
    for (let i = 0; i < 3; i++) f.flag('No serial', () => f.commission(''));
  }, { ticket: 'Never turned into serialized events; no serials generated' });
  scenario('T12-02', 'dummy_serials', 'Placeholder serials: 0, NA, DUMMY, 000000', g('Accept', '', 'GS1 treats these as legal serials, so the API may accept them'), (f) => {
    for (const sn of ['0', 'NA', 'DUMMY', '000000']) f.flag('Placeholder serial', () => f.commission(`${sn}`, { Lot_Batch_Number: `${f.lot}${sn.slice(0, 2)}` }));
  }, { ticket: 'Never turned into serialized events; no serials generated. If L4 accepts them, raise it even if the API does too' });
  scenario('T12-03', 'one_serial_per_lot', '3 lots with one serial each', g('Accept'), (f) => {
    for (const sfx of ['A', 'B', 'C']) f.commission(f.serial(), { Lot_Batch_Number: `${f.lot}${sfx}` });
  }, { ticket: 'Same as the API; check no extra serials appear on any lot' });
  scenario('T12-04', 'quantity_only_rows', 'Rows with an extra Quantity column (100) and no serial', g('Reject'), (f) => {
    for (let i = 0; i < 2; i++) f.commission('');
  }, { raw: (l, h) => body(l.map((x) => `${x},100`), `${h},Quantity`), twinNa: 'a quantity-only row has no serial, so it has no EPCIS form', ticket: 'Never turned into serialized events; no serials generated' });

  // T13 file handling (CSV only, except the valid-format ones)
  const T13 = 'Rejected clearly, never repaired';
  const sci = (n) => Number(n).toExponential(4).replace(/\.?0+e/, 'e').replace('e+', 'E+');
  const dmy = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : d);
  const excel = (fix) => (f) => {
    const { pallet } = f.packageOf();
    f.rows = f.rows.map((r) => fix([...r]));
    return pallet;
  };
  const fmt = (id, slug, what, guide, raw, opts = {}) => scenario(id, slug, what, guide, opts.build || ((f) => f.controls()), { raw, ticket: T13, ...opts });
  scenario('T13-01', 'excel_saved', 'A small hierarchy as Excel saves it: GTIN 6.1611E+12, GLN without its leading zero, SSCC 6.164E+16, dates DD/MM/YYYY', g('Reject'),
    excel((r) => {
      if (r[col.GTIN]) r[col.GTIN] = sci(r[col.GTIN]);
      r[col.BizLocation_GLN] = r[col.BizLocation_GLN].replace(/^0/, '');
      for (const c of ['Unit_ID', 'Parent_ID']) if (/^\d{18}$/.test(r[col[c]])) r[col[c]] = sci(r[col[c]]);
      r[col.Lot_Manufacturing_Date] = dmy(r[col.Lot_Manufacturing_Date]);
      r[col.Lot_Expiry_Date] = dmy(r[col.Lot_Expiry_Date]);
      return r;
    }), { ticket: T13, twinNa: 'the API equivalent is the uncorrupted event' });
  scenario('T13-02', 'gtin_scientific', 'GTIN as 6.1611E+12 on every row', g('Reject'), excel((r) => {
    if (r[col.GTIN]) r[col.GTIN] = sci(r[col.GTIN]);
    return r;
  }), { ticket: T13, twinNa: 'the API equivalent is the uncorrupted event' });
  scenario('T13-03', 'gln_leading_zero_lost', 'Location GLN as 614141000012 (12 digits) on every row', g('Reject'), excel((r) => {
    r[col.BizLocation_GLN] = r[col.BizLocation_GLN].replace(/^0/, '');
    return r;
  }), { ticket: T13, twinNa: 'the API equivalent is the uncorrupted event' });
  scenario('T13-04', 'sscc_scientific', 'SSCCs as 6.164E+16', g('Reject'), excel((r) => {
    for (const c of ['Unit_ID', 'Parent_ID']) if (/^\d{18}$/.test(r[col[c]])) r[col[c]] = sci(r[col[c]]);
    return r;
  }), { ticket: T13, twinNa: 'the API equivalent is the uncorrupted event' });
  scenario('T13-05', 'dates_reformatted', 'Manufacture and expiry dates as DD/MM/YYYY on every row', g('Reject', 'INVALID_EXPIRY_FORMAT'), excel((r) => {
    r[col.Lot_Manufacturing_Date] = dmy(r[col.Lot_Manufacturing_Date]);
    r[col.Lot_Expiry_Date] = dmy(r[col.Lot_Expiry_Date]);
    return r;
  }), { ticket: T13, twinNa: 'the API equivalent is the uncorrupted event' });
  scenario('T13-06', 'event_time_reformatted', 'Event times as DD/MM/YYYY HH:MM, as Excel shows them', g('Reject'), excel((r) => {
    const t = r[col.Event_Timestamp];
    r[col.Event_Timestamp] = `${t.slice(8, 10)}/${t.slice(5, 7)}/${t.slice(0, 4)} ${t.slice(11, 16)}`;
    return r;
  }), { ticket: T13, twinNa: 'the API equivalent is the uncorrupted event' });
  fmt('T13-07', 'utf8_bom', 'Valid rows with a UTF-8 BOM (the "CSV UTF-8" save in Excel)', g('Accept'), (l, h) => `﻿${body(l, h)}`, { ticket: `${T13} (the ticket lists BOM; confirm whether a BOM really must fail)`, formatOk: true });
  fmt('T13-08', 'crlf_line_ends', 'Valid rows with Windows line ends', g('Accept'), (l, h) => body(l, h).replaceAll('\n', '\r\n'), { ticket: 'Accepted: CRLF is standard CSV', formatOk: true });
  fmt('T13-09', 'quoted_comma', 'Country "Korea, Republic of" in quotes', g('Accept'), (l, h) => body(l, h), { build: (f) => f.commission(f.serial(), { Country_of_Origin: 'Korea, Republic of' }), ticket: 'Accepted: quoting is standard CSV', formatOk: true });
  fmt('T13-10', 'blank_lines', 'Blank lines between and after rows', g('Accept'), (l, h) => `${h}\n${l[0]}\n\n${l[1]}\n\n\n`, { ticket: 'Accepted: no empty-row rejections', formatOk: true });
  fmt('T13-11', 'utf16', 'Valid rows saved as UTF-16', g('Reject'), (l, h) => Buffer.from(`﻿${body(l, h)}`, 'utf16le'));
  fmt('T13-12', 'latin1', 'Country "Côte d\'Ivoire" saved as Latin-1', g('Reject'), (l, h) => Buffer.from(body(l, h), 'latin1'), { build: (f) => f.commission(f.serial(), { Country_of_Origin: "Côte d'Ivoire" }) });
  fmt('T13-13', 'semicolon_delimited', 'Semicolons instead of commas', g('Reject'), (l, h) => body(l, h).replaceAll(',', ';'));
  const dropCol = (x) => x.split(',').filter((_, i) => i !== col.Lot_Expiry_Date).join(',');
  fmt('T13-14', 'column_missing', 'Lot_Expiry_Date column removed', g('Reject'), (l, h) => body(l.map(dropCol), dropCol(h)));
  const swap = (cells) => {
    const a = [...cells];
    [a[col.Lot_Manufacturing_Date], a[col.Lot_Expiry_Date]] = [a[col.Lot_Expiry_Date], a[col.Lot_Manufacturing_Date]];
    return a.join(',');
  };
  fmt('T13-15', 'columns_reordered', 'Manufacture and expiry columns swapped in header and data', g('Reject'), (l, h) => body(l.map((x) => swap(x.split(','))), swap(h.split(','))), { ticket: `${T13} (the ticket lists reordered columns)` });
  fmt('T13-16', 'column_renamed', 'Event_Type column renamed to Type', g('Reject'), (l, h) => body(l, h.replace('Event_Type', 'Type')));
  fmt('T13-17', 'column_extra', 'An extra Notes column', g('Reject'), (l, h) => body(l.map((x) => `${x},note`), `${h},Notes`), { ticket: `${T13}: every column must map to L5 or be marked not sent` });
  fmt('T13-18', 'header_lowercase', 'Header row in lower case', g('Reject'), (l, h) => body(l, h.toLowerCase()));
  fmt('T13-19', 'values_padded', 'Line 3 has spaces around every value', g('Reject'), (l, h) => body([l[0], l[1].split(',').map((x) => (x ? ` ${x} ` : x)).join(',')], h), { ticket: `${T13}: trimming is a repair` });
  fmt('T13-20', 'row_extra_field', 'Line 3 has 28 fields', g('Reject'), (l, h) => body([l[0], `${l[1]},EXTRA`, ...l.slice(2)], h), { build: (f) => { f.controls(); f.commission(); } });
  fmt('T13-21', 'row_missing_field', 'Line 3 has 26 fields', g('Reject'), (l, h) => body([l[0], l[1].replace(/,[^,]*$/, ''), ...l.slice(2)], h), { build: (f) => { f.controls(); f.commission(); } });
  fmt('T13-22', 'empty', 'A 0-byte file', g('Reject'), () => '', { build: () => {} });
  fmt('T13-23', 'header_only', 'Header row, no data', g('Reject'), (_, h) => `${h}\n`, { build: () => {} });
  fmt('T13-24', 'old_template_rows', 'The downloadable template\'s own sample rows, unchanged (old dates, 23-character lot, bad GLN check digits)', g('Reject'), () => TEMPLATE_TEXT, { build: () => {} });
  fmt('T13-25', 'binary_named_csv', 'Binary data named .csv', g('Reject'), () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(2040)]), { build: () => {} });
  fmt('T13-26', 'wrong_extension', 'Valid CSV content named .txt', g('Reject'), (l, h) => body(l, h), { ext: 'txt' });

  // T14 volume: commissioning only, one time per file, twin = one event per lot
  const volume = (n) => (f) => {
    const ts = tick();
    for (let i = 0; i < n; i++) f.commission(f.serial(), {}, ts);
  };
  scenario('T14-01', 'serials_1k', '1,000 serials, one lot', g('Accept'), volume(1000), { merge: 'lot' });
  scenario('T14-02', 'serials_5k', '5,000 serials, one lot', g('Accept'), volume(5000), { merge: 'lot' });
  scenario('T14-03', 'serials_10k', '10,000 serials, one lot', g('Accept'), volume(10000), { merge: 'lot' });
  scenario('T14-04', 'serials_50k', '50,000 serials, one lot (the guide\'s per-message maximum)', g('Accept'), volume(50000), { merge: 'lot' });
  scenario('T14-05', 'serials_50001', '50,001 serials, one lot', g('Reject', 'TOO_MANY_SERIALS'), volume(50001), { merge: 'lot' });
  // Size steps: rows padded through Transaction_Reference, which commissioning does not send.
  const sized = (bytes) => (f) => {
    const ts = tick();
    const pad = 'P'.repeat(900);
    let size = HEADER.length + 1;
    while (size < bytes) {
      f.commission(f.serial(), { Transaction_Reference: pad }, ts);
      size += line(f.rows.at(-1)).length + 1;
    }
    f.rows.pop();
    f.meta.pop();
  };
  for (const [id, slug, mb, guide] of [
    ['T14-06', 'size_1MB', 1_000_000, g('Accept')], ['T14-07', 'size_just_under_2MB', 1_990_000, g('Accept')],
    ['T14-08', 'size_just_over_2MiB', 2_150_000, g('Accept', '', 'the guide allows 10 MB async; the portal says 2 MB')],
    ['T14-09', 'size_5MB', 5_000_000, g('Accept', '', 'the guide allows 10 MB async')], ['T14-10', 'size_just_under_10MB', 9_900_000, g('Accept')],
    ['T14-11', 'size_just_over_10MiB', 10_600_000, g('Reject', 'MESSAGE_SIZE_EXCEEDED')],
  ]) {
    scenario(id, slug, `About ${(mb / 1e6).toFixed(2)} MB of valid commissioning rows (padded in a column commissioning does not send)`, guide, sized(mb), {
      twinNa: 'file size is specific to the CSV channel; judge it against the guide\'s 10 MB async limit', ticket: 'Record the real limit and any data loss',
    });
  }
  scenario('T14-12', 'concurrent_uploads', 'Upload T14-02 and T14-03 at the same time, in two browser tabs', g('Accept'), () => {}, {
    manual: ['Open two tabs on Bulk CSV. Start T14-02 in one and T14-03 in the other within a few seconds.', 'Each submission keeps its own status and counts; totals = 5,000 and 10,000 with nothing lost or mixed.'],
  });

  // T15 downstream
  shipRule('T15-01', 'ship_for_downstream', `Ship an approved package to the distributor (${DIST_GLN}), then receive and dispense it through the API`, g('Accept'), {}, {
    after: [
      support.distReceive(P['T15-01'].pallet, 'distributor receives the pallet'),
      support.distShip(P['T15-01'].pallet, 'distributor ships it to the facility'),
      support.facReceive(P['T15-01'].pallet, 'facility receives it'),
      support.dispense(P['T15-01'].serials[0], 'facility dispenses one item'),
    ],
    ticket: 'No false orphan or RECEIVING_WITHOUT_SHIPPING flags; verification status correct at each step',
  });

  // T16 recall and status
  shipRule('T16-01', 'ship_damaged_package', 'Ship a package that was reported damaged through the API', g('Flag', 'INVALID_DISPOSITION'), {}, {
    before: [support.damage(P['T16-01'].pallet, 'report the package damaged')],
  });
  shipRule('T16-02', 'ship_recalled_package', 'Ship a package whose lot PPB has recalled', g('Flag', 'RECALL_ACTIVE'), {}, {
    beforeManual: 'Ask PPB (regulator login) to recall this package\'s lot in the portal before uploading.',
    ticket: 'RECALL_ACTIVE or the correct flag appears; verification shows recalled',
  });

  // T18 audit and security
  scenario('T18-01', 'formula_injection', 'Country values =1+1, +1+1, -1+1, @SUM(1), =HYPERLINK("http://example.com")', g('Accept', '', 'the API stores text; the ticket wants the attack blocked in L4'), (f) => {
    for (const x of ['=1+1', '+1+1', '-1+1', '@SUM(1)', '=HYPERLINK("http://example.com")']) f.flag('Spreadsheet formula', () => f.commission(f.serial(), { Country_of_Origin: x }));
  }, { ticket: 'Attack blocked: rejected, or stored as inert text that never runs when exported to Excel' });
  batch('T18-02', 'html_injection', 'Country contains <img src=x onerror=alert(1)>', g('Accept', '', 'the API stores text; the ticket wants the attack blocked in L4'), { Country_of_Origin: '<img src=x onerror=alert(1)>' }, {
    ticket: 'Attack blocked: rejected, or shown as literal text everywhere',
  });
  scenario('T18-03', 'html_file_named_csv', 'An HTML page with a script, named .csv', g('Reject'), () => {}, {
    raw: () => '<!doctype html><html><body><script>alert(document.cookie)</script></body></html>\n', twinNa: 'not CSV', ticket: 'Rejected, nothing rendered',
  });
  scenario('T18-04', 'huge_single_cell', 'One row whose country cell is 1.5 MB', g('Reject'), (f) => f.commission(f.serial(), { Country_of_Origin: 'X'.repeat(1_500_000) }), {
    twinNa: 'a single oversized value; judge on L4 handling', ticket: 'Rejected cleanly, no crash or timeout',
  });
  scenario('T18-05', 'audit_and_isolation', 'File hash, uploader, row-to-event lineage, and other partners\' reports', g('Accept'), () => {}, {
    manual: [
      'For T02-01: the import record shows the file name, a file hash, the uploader and time.',
      'From one stored event, you can get back to the file and the row number that made it (and the other way round).',
      'Sign in as a different manufacturer (or ask the devs for one) and try to open this account\'s import reports by changing the ID in the URL. Expected: 403/404.',
    ],
  });

  list.pool = P;
  return list;
}

// --- build both channels ------------------------------------------------------------------------
const built = Object.fromEntries(Object.entries(CHANNELS).map(([k, ch]) => [k, defineScenarios(ch)]));
const csvList = built.csv;
const apiById = Object.fromEntries(built.api.map((s) => [s.id, s]));
const fileName = (s) => `${s.id}_${s.slug}.${s.ext || 'csv'}`;

function twinOf(s) {
  if (s.manual && !s.f.rows.length) return null;
  if (s.twinNa) return { na: s.twinNa };
  if (s.raw && !s.formatOk) return { na: 'a file-format problem has no API equivalent' };
  const src = s.copyOf ? apiById[s.copyOf] : apiById[s.id];
  const events = [];
  const rowNa = [];
  src.f.rows.forEach((r, i) => {
    const t = twinEvent(r, src.f.meta[i] || {}, 'api');
    if (t.na) rowNa.push({ line: i + 2, why: t.na });
    else events.push(t.event);
  });
  const merged = s.merge ? mergeEvents(events, s.merge) : events;
  return { doc: merged.length ? epcisDoc(merged) : null, rowNa, events: merged.length };
}

// --- write CSVs ---------------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
// Overwrite: earlier packs (this one or the older UI-rules pack) are removed first.
for (const n of fs.readdirSync(OUT)) {
  if (/^(\d{3}_|T\d\d-|000_)/.test(n) && fs.statSync(path.join(OUT, n)).isFile()) fs.unlinkSync(path.join(OUT, n));
}
const contents = new Map();
for (const s of csvList) {
  if (s.manual && !s.f.rows.length) continue;
  const src = s.copyOf ? csvList.find((x) => x.id === s.copyOf) : s;
  const lines = src.f.rows.map(line);
  const content = s.raw ? s.raw(lines, HEADER) : body(lines);
  contents.set(fileName(s), content);
}
for (const [name, content] of contents) fs.writeFileSync(path.join(OUT, name), content);

// --- Postman ------------------------------------------------------------------------------------
const ENDPOINT = {
  manufacturer: ['{{base_url}}/api/integration/manufacturer/events', '{{mfg_token}}'],
  distributor: ['{{base_url}}/api/integration/supplier/events', '{{dist_token}}'],
  facility: ['{{base_url}}/api/integration/facility/events', '{{fac_token}}'],
  dispense: ['{{base_url}}/api/integration/facility/events/dispense', '{{fac_token}}'],
};
const REPORT = `// Shows the outcome as test names, so one screenshot of the result holds the evidence.
let b = {};
try { b = pm.response.json(); } catch (e) { /* non-JSON body */ }
const codes = new Set();
const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (typeof x.code === 'string') codes.add(x.code); Object.values(x).forEach(walk); } };
walk(b);
pm.test('HTTP ' + pm.response.code + (b.status ? ' · ' + b.status : ''), () => {});
pm.test('codes: ' + ([...codes].join(', ') || 'none'), () => {});
pm.test('202 means flags arrive later: open API Logs for these eventIDs', () => {});`;
const request = (name, role, raw, description) => ({
  name,
  request: {
    method: 'POST',
    header: [{ key: 'Content-Type', value: 'application/ld+json' }, { key: 'X-API-Key', value: ENDPOINT[role][1] }],
    url: { raw: ENDPOINT[role][0], host: [ENDPOINT[role][0]] },
    body: { mode: 'raw', raw },
    description,
  },
  event: [{ listen: 'test', script: { type: 'text/javascript', exec: REPORT.split('\n') } }],
});
const supportDoc = (st) => JSON.stringify(epcisDoc([{ eventID: 'urn:uuid:{{$guid}}', eventTime: '{{now}}', ...st.event }]), null, 2);

const twinFolders = {};
const csvSupport = {};
for (const s of csvList) {
  const a = apiById[s.id];
  const area = AREAS[s.id.slice(0, 3)];
  const items = (twinFolders[area] ||= []);
  for (const st of a.before || []) items.push(request(`${s.id} · before · ${st.label}`, st.role, supportDoc(st), 'Run before the twin below.'));
  const t = twinOf(s);
  s.twin = t;
  if (t?.doc) {
    // Volume twins stay compact so the collection imports quickly.
    const raw = t.events > 100 ? JSON.stringify(t.doc) : JSON.stringify(t.doc, null, 2);
    items.push(request(`${s.id} · ${s.slug}`, 'manufacturer', raw, `API twin of ${fileName(s)}. ${s.what}.`));
    if (s.twice) items.push(request(`${s.id} · ${s.slug} · retry`, 'manufacturer', raw, 'The same document again, sent straight after the first.'));
  }
  for (const st of a.after || []) items.push(request(`${s.id} · after · ${st.label}`, st.role, supportDoc(st), 'Run after the twin above.'));
  for (const [when, steps] of [['before', s.before], ['after', s.after]]) {
    for (const st of steps || []) (csvSupport[area] ||= []).push(request(`${s.id} · ${when} the CSV upload · ${st.label}`, st.role, supportDoc(st), `CSV side: run ${when} uploading ${fileName(s)}.`));
  }
}
const collection = {
  info: {
    name: `TnT · CSV vs API parity (${RUN})`,
    description: `API twins for the CSV parity pack generated ${ymd}, run ${RUN}. Fill the collection variables (tokens, facility SGLN) before running. Run folders in order; one request per CSV.`,
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    { name: 'A · API twins (run in order)', item: Object.entries(twinFolders).filter(([, i]) => i.length).map(([name, item]) => ({ name, item })) },
    { name: 'B · Support requests for the CSV side', item: Object.entries(csvSupport).map(([name, item]) => ({ name, item })) },
  ],
  event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ["pm.variables.set('now', new Date().toISOString());"] } }],
  variable: [
    { key: 'base_url', value: 'https://tnt-demo.apeiro-digital.com' },
    { key: 'mfg_token', value: '' }, { key: 'dist_token', value: '' }, { key: 'fac_token', value: '' },
    { key: 'fac_sgln', value: '', description: 'Your facility partner\'s SGLN, e.g. urn:epc:id:sgln:0614141.00009.0' },
  ],
};
const POSTMAN = `000_TnT_CSV_API_Parity_${RUN}.postman_collection.json`;
for (const n of fs.readdirSync(OUT).filter((x) => x.endsWith('.postman_collection.json'))) fs.unlinkSync(path.join(OUT, n));
fs.writeFileSync(path.join(OUT, POSTMAN), JSON.stringify(collection, null, 2));

// --- expected text ------------------------------------------------------------------------------
const guideText = (gd) => `${gd.outcome}${gd.code ? ` ${gd.code}` : ''}${gd.note ? ` (${gd.note})` : ''}`;
const shortWhy = (why) => (/check digit/.test(why) ? 'wrong check digit, which an EPC URI cannot carry' : why);
function expected(s) {
  const t = s.twin;
  if (s.manual && !s.f.rows.length) return 'As in the steps.';
  if (!t || t.na) return `${s.ticket || 'Rejected clearly with the line number, never repaired'}. No API twin: ${t ? t.na : 'manual check'}.`;
  const why = [...new Set(t.rowNa.map((x) => shortWhy(x.why)))].join('; ');
  if (!t.doc) return `CSV only: the API cannot send line ${t.rowNa.map((x) => x.line).join(', ')} (${why}), so the CSV must reject it clearly, not repair it. Guide v0.2: ${guideText(s.guide)}.${s.ticket ? ` Ticket: ${s.ticket}.` : ''}`;
  const na = t.rowNa.length
    ? ` The API cannot send line ${t.rowNa.map((x) => x.line).join(', ')} (${[...new Set(t.rowNa.map((x) => shortWhy(x.why)))].join('; ')}), so the CSV must reject it, not repair it.`
    : '';
  return `Same result as the API twin.${na} Guide v0.2: ${guideText(s.guide)}.${s.ticket ? ` Ticket: ${s.ticket}.` : ''}`;
}

// --- approvals ----------------------------------------------------------------------------------
const approvals = [];
for (const [k, ch] of Object.entries(CHANNELS)) {
  for (const [key, action] of Object.entries(POOL_SPEC)) approvals.push({ channel: ch.name, key, sscc: built[k].pool[key].pallet, action });
}

// --- comments -----------------------------------------------------------------------------------
// Only what differs from the standard run (in the header) is listed per test.
const extraSteps = (s) => {
  const out = [];
  if (s.needs) out.push(`Needs ${s.needs} first.`);
  if (s.beforeManual) out.push(s.beforeManual);
  for (const st of s.before || []) out.push(`Before the CSV upload, run Postman B "${s.id} · before the CSV upload · ${st.label}".`);
  if (s.twice) out.push('Upload the CSV twice in quick succession, and send the twin twice ("retry" request).');
  if (s.id === 'T04-00') out.push('Then set every package\'s approval as in the matrix Approvals sheet (CSV and API rows).');
  for (const st of s.after || []) out.push(`After the CSV upload, run Postman B "${s.id} · after the CSV upload · ${st.label}".`);
  for (const m of s.manual || []) out.push(m);
  return out;
};
const comment = (s) => {
  const t = s.twin;
  const lines = [...new Set(s.f.flagged.map((x) => x.line))];
  const files = [
    contents.has(fileName(s)) ? `CSV {{${fileName(s)}}}${lines.length ? ` (line ${lines.join(', ')} under test)` : ''}` : null,
    t?.doc ? `API twin "${s.id} · ${s.slug}"` : null,
  ].filter(Boolean);
  const extra = extraSteps(s);
  return [
    `${s.id} · ${s.what}`,
    `*Files:* ${files.join(' · ') || 'manual check, no files'}`,
    ...(extra.length ? ['*Extra steps:*', ...extra.map((x) => `# ${x}`)] : []),
    `*Expected:* ${expected(s)}`,
    '*API result:* ',
    '*CSV result:* ',
    '*Verdict:* PASS / FAIL',
  ].join('\n');
};
const header = `h3. CSV vs API parity: per-test comments (run ${RUN}, generated ${nairobi(now.getTime())} Nairobi)

*Environment:* {{https://tnt-demo.apeiro-digital.com}} · *Postman:* {{${POSTMAN}}} · *Matrix:* {{000_PARITY_MATRIX.xlsx}}

*Standard run for every test:*
# *API:* in Postman folder A, send the requests that start with the test ID. Screenshot the response. If it is a 202, open Partner Portal > API Logs for those eventIDs and screenshot the flags.
# *CSV:* upload the CSV at Manufacturer > Batches > Bulk CSV. Screenshot the result and its Async submissions entry (rows accepted and rejected, codes, line numbers).
# Fill in the API and CSV results, attach both screenshots, and set the verdict.

*PASS rule:* the CSV gets the same status, error and flag codes, lifecycle state and stored events as its API twin; only event ID, timestamps and channel may differ. A test with no API twin passes when the CSV is rejected clearly, with the line number, and nothing is repaired.

----
`;
fs.writeFileSync(path.join(OUT, '000_TEST_COMMENTS.txt'), header + csvList.map(comment).join('\n\n----\n\n') + '\n');

// --- matrix -------------------------------------------------------------------------------------
const HARD = ['INVALID_XML_STRUCTURE', 'INVALID_JSON_STRUCTURE', 'INVALID_SBDH', 'MESSAGE_SIZE_EXCEEDED', 'TOO_MANY_SERIALS', 'INVALID_EXPIRY_FORMAT',
  'INVALID_GS1_IDENTIFIER', 'FUTURE_EVENT_TIME', 'MISSING_NEEDED_FIELDS', 'DUPLICATE_EVENT_ID', 'DUPLICATE_EVENT_PAYLOAD', 'DUPLICATE_EPC_IN_EVENT',
  'IMPOSSIBLE_SENSOR_VALUES', 'ERROR_DECLARATION_BEFORE_EVENT', 'INVALID_GTIN_CHECK_DIGIT', 'INVALID_GLN_CHECK_DIGIT', 'INVALID_SSCC_CHECK_DIGIT',
  'ERROR_DECLARATION_ORIGINAL_NOT_FOUND', 'ERROR_DECLARATION_CONTENT_MISMATCH', 'ERROR_DECLARATION_INVALID_REASON', 'ERROR_DECLARATION_CORRECTIVE_NOT_FOUND'];
const FLAGS = ['INVALID_LOT', 'INVENTORY_SIGHTING_MISMATCH', 'NO_REGULATORY_APPROVAL', 'EXPIRING_SOON', 'UNAUTHORIZED_INSPECTING_EVENT', 'SERIAL_ALREADY_DISPENSED',
  'SERIAL_ALREADY_DESTROYED', 'UNKNOWN_SGTIN', 'UNKNOWN_SGLN', 'INACTIVE_SGLN', 'INVALID_DISPOSITION', 'INVALID_BIZSTEP', 'INVALID_TERMINAL_STATE',
  'INVALID_PARENT_CHILD_RELATION', 'PARENT_NOT_FOUND', 'CHILD_ALREADY_AGGREGATED', 'INVALID_EVENT_SEQUENCE', 'SSCC_AT_DISPENSING', 'EXPIRED_PRODUCT',
  'RECALL_ACTIVE', 'RECEIVING_WITHOUT_SHIPPING', 'UNPACK_WITHOUT_AGGREGATION', 'STALE_EVENT_TIME', 'UNCOMMISSIONED_CHILD', 'SHIPPING_WITHOUT_COMMISSIONING',
  'INCOMPLETE_ERROR_DECLARATION', 'ERROR_DECLARATION_WITHOUT_REASON'];
const NA = {
  INVALID_XML_STRUCTURE: 'L4 sends JSON; there is no XML on the CSV path', INVALID_SBDH: 'XML-only header; not on the CSV path',
  IMPOSSIBLE_SENSOR_VALUES: 'The CSV template has no sensor columns',
  INVALID_BIZSTEP: 'Event_Type is a fixed list mapped by L4, so a CSV cannot choose a bizStep; unknown types are covered by T02-37/38/39',
  INACTIVE_SGLN: 'Needs a GLN that master data marks inactive; ask the devs or PPB for one',
  SSCC_AT_DISPENSING: 'Dispensing is a facility API event; the CSV template has no dispense type', SERIAL_ALREADY_DISPENSED: 'Dispensing is a facility API event; reached only through T15 support requests',
  RECEIVING_WITHOUT_SHIPPING: 'Receiving is a distributor/facility API event; checked as a must-not-appear flag in T15',
  UNPACK_WITHOUT_AGGREGATION: 'The CSV template has no unpack type', PARENT_NOT_FOUND: 'No CSV row references an existing parent by lookup; unknown parents surface as UNCOMMISSIONED_CHILD (T03-30)',
};
for (const c of [...HARD, ...FLAGS].filter((c) => c.startsWith('ERROR_DECLARATION') || c === 'INCOMPLETE_ERROR_DECLARATION')) NA[c] = 'The CSV template has no error-declaration columns; ask whether L4 offers corrections at all';
const coveredBy = (code) => csvList.filter((s) => s.guide.code === code).map((s) => s.id);

const wb = new ExcelJS.Workbook();
const sheet = (name, columns, rows) => {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  ws.getRow(1).font = { bold: true };
  ws.addRows(rows);
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { wrapText: true, vertical: 'top' }; });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: columns.length } };
  return ws;
};
sheet('Parity matrix', [
  ['ID', 'id', 9], ['Area', 'area', 16], ['What it tests', 'what', 48], ['CSV file', 'csv', 36], ['API twin', 'api', 26],
  ['Guide v0.2 prediction', 'guide', 34], ['Ticket expectation', 'ticket', 30], ['API result', 'apiResult', 26], ['CSV result', 'csvResult', 26],
  ['Match', 'match', 8], ['Evidence', 'evidence', 22], ['Verdict', 'verdict', 9], ['Notes', 'notes', 30],
], csvList.map((s) => ({
  id: s.id, area: AREAS[s.id.slice(0, 3)], what: s.what, csv: contents.has(fileName(s)) ? fileName(s) : '(manual)',
  api: s.twin?.doc ? `${s.id} · ${s.slug}` : s.twin?.na ? `N/A: ${s.twin.na}` : '(manual)', guide: guideText(s.guide), ticket: s.ticket || '',
  apiResult: s.twin?.doc ? '' : 'N/A', notes: s.twin?.rowNa?.length ? `Lines without an API form: ${s.twin.rowNa.map((x) => x.line).join(', ')}` : '',
})));
sheet('Rule coverage (T6)', [['Code', 'code', 40], ['Guide v0.2 type', 'type', 16], ['Covered by', 'by', 40], ['N/A reason', 'na', 70]],
  [...HARD.map((c) => ['Hard reject', c]), ...FLAGS.map((c) => ['Flag', c])].map(([type, code]) => {
    const by = coveredBy(code);
    return { code, type, by: by.join(', '), na: by.length ? '' : NA[code] || 'Not reached by a CSV scenario: raise with the devs' };
  }));
sheet('Field mapping (T7)', [['CSV column', 'c', 28], ['EPCIS field in the API twin', 'e', 60], ['Check in the L4-generated event', 'n', 60]], [
  ['Event_Type', 'COMMISSIONING > ObjectEvent ADD commissioning/active; AGGREGATION > AggregationEvent ADD packing/active; SHIPPING > ObjectEvent OBSERVE shipping/in_transit', 'CBV short tokens, not URNs (JSON-LD)'],
  ['Identifier_Type + GTIN + Unit_ID', 'epcList / childEPCs: urn:epc:id:sgtin:<prefix>.<indicator+itemRef>.<serial> or urn:epc:id:sscc:<prefix>.<ext+serialRef>', 'No check digits in URIs; serial characters percent-escaped; company prefix split'],
  ['Parent_ID', 'parentID (SSCC URI)', ''],
  ['Packaging_Level', 'not sent', 'Must be marked "not sent" in the L4 mapping'],
  ['Event_Timestamp + Event_TimeZone_Offset', 'eventTime in UTC ending Z; eventTimeZoneOffset as given', 'Local time converted, offset kept separately'],
  ['BizLocation_GLN', 'readPoint.id and bizLocation.id: urn:epc:id:sgln:<prefix>.<location>.0', ''],
  ['Lot_Batch_Number', 'ilmd cbvmda:lotNumber', ''], ['Lot_Expiry_Date', 'ilmd cbvmda:itemExpirationDate', 'YYYY-MM-DD as given'],
  ['Lot_Manufacturing_Date', 'not sent', 'No field in the guide\'s profile: must be marked "not sent", or mapped and documented'],
  ['Manufacturing_Origin', 'not sent (decides whether the MAH sourceList is needed)', ''],
  ['Country_of_Origin', 'ilmd cbvmda:countryOfOrigin as ISO 3166 alpha-2 (Germany > DE)', 'Check whether L4 converts names or sends them raw'],
  ['Import_Sales_Permit_Ref', 'not sent', 'No field in the guide\'s profile: must be marked "not sent", or mapped and documented'],
  ['Sender_Owner_GLN', 'sourceList owning_party (commissioning: the foreign MAH)', ''], ['Sender_Custodian_GLN', 'sourceList possessing_party', 'Owner vs custodian must not be swapped or merged'],
  ['Receiver_Owner_GLN', 'destinationList owning_party', ''], ['Receiver_Custodian_GLN', 'destinationList possessing_party', 'Owner vs custodian must not be swapped or merged'],
  ['Sender/Receiver names, *_Location_Name, LSP_Name', 'not sent (master data)', ''], ['LSP_GLN', 'not sent', 'No carrier slot in the profile: must be marked "not sent"'],
  ['Transaction_Type + Transaction_Reference', 'bizTransactionList [{type, bizTransaction: urn:epcglobal:cbv:bt:<sender GLN>:<reference>}]', 'A blank reference must not be filled in silently'],
].map(([c, e, n]) => ({ c, e, n })));
sheet('Approvals', [['Channel', 'channel', 10], ['For test', 'key', 12], ['Package SSCC', 'sscc', 24], ['Regulator action', 'action', 18], ['Done', 'done', 8]], approvals);
await wb.xlsx.writeFile(path.join(OUT, '000_PARITY_MATRIX.xlsx'));

// --- how to run ---------------------------------------------------------------------------------
const outcomes = (o) => csvList.filter((s) => !(s.manual && !s.f.rows.length) && s.guide.outcome === o).length;
fs.writeFileSync(path.join(OUT, '000_HOW_TO_RUN.md'), `# CSV vs API parity pack (run ${RUN})

Generated ${nairobi(now.getTime())} Nairobi for tnt-demo. Regenerate with \`node scripts/csv/make-csv-parity-pack.mjs\`.

| File | What it is |
|---|---|
| \`000_TEST_COMMENTS.txt\` | One Jira comment per test, in run order. Copy a block, follow its steps, fill in the results, paste it into Jira. |
| \`000_PARITY_MATRIX.xlsx\` | The parity matrix (definition of done), plus rule coverage (T6), field mapping (T7) and the approvals list. |
| \`${POSTMAN}\` | API twins (folder A) and the API requests the CSV side needs (folder B). |
| \`T..-.._*.csv\` | One CSV per test. |

${csvList.length} tests, ${contents.size} files. Guide v0.2 predicts ${outcomes('Accept')} accept, ${outcomes('Flag')} accept with a flag and ${outcomes('Reject')} reject; the API result is what counts.

1. Import the Postman collection. Set \`mfg_token\`, \`dist_token\`, \`fac_token\` and \`fac_sgln\` in its variables.
2. Work through \`000_TEST_COMMENTS.txt\` from the top. Each test: run its API twin, upload its CSV, compare, fill in the matrix row.
3. After T04-00, set the approvals in the Approvals sheet (both channels) before any other T04, T07, T15 or T16 test.
4. Run both channels of a test on the same day. Event times start ${nairobi(CLOCK_START)}; after 7 days both sides start getting STALE_EVENT_TIME, so regenerate if the pack is older than about 5 days.
5. Never open the CSVs in Excel. Saving rewrites GTINs, SSCCs, GLNs and dates (that is what T13 tests).
`);

// --- self-check ---------------------------------------------------------------------------------
const problems = [];
const seen = new Map();
for (const s of csvList.filter((x) => !x.raw && !x.copyOf)) {
  const flaggedLines = new Set(s.f.flagged.map((x) => x.line));
  if (/^T13-0[1-6]/.test(s.id)) continue;
  s.f.rows.forEach((r, i) => {
    const ln = i + 2;
    if (r.length !== COLS.length) problems.push(`${s.id} line ${ln}: ${r.length} columns`);
    if (flaggedLines.has(ln) || ['T02-34', 'T10-04', 'T09-05'].includes(s.id)) return;
    if (r[col.Event_Timestamp] > nairobi(now.getTime())) problems.push(`${s.id} line ${ln}: future timestamp`);
    if (r[col.Lot_Batch_Number].length > 20) problems.push(`${s.id} line ${ln}: lot over 20`);
    if (r[col.Event_Type] === 'COMMISSIONING') {
      const key = `${r[col.GTIN]}|${r[col.Unit_ID]}`;
      if (seen.has(key) && !['T02-35', 'T09-04'].includes(s.id)) problems.push(`${key} in ${s.id} also in ${seen.get(key)}`);
      seen.set(key, s.id);
    }
  });
}
// The two channels must never share a serial, or one would trip the other's duplicate checks.
const PLACEHOLDERS = new Set(['', '0', 'NA', 'DUMMY', '000000']);
const csvSerials = new Set(csvList.flatMap((s) => s.f.rows.map((r) => r[col.Unit_ID])));
for (const s of built.api.filter((x) => !x.id.startsWith('T13'))) { // T13 mangles IDs on purpose
  for (const r of s.f.rows) if (!PLACEHOLDERS.has(r[col.Unit_ID]) && csvSerials.has(r[col.Unit_ID])) problems.push(`${s.id}: CSV and API share ${r[col.Unit_ID]}`);
}
const twinCount = csvList.filter((s) => s.twin?.doc).length;
console.log(`Wrote ${contents.size} files to ${OUT} (run ${RUN}); ${twinCount} API twins; ${approvals.length} approvals`);
if (problems.length) {
  console.error(`SELF-CHECK FAILED (${problems.length}):\n  ${problems.slice(0, 25).join('\n  ')}`);
  process.exit(1);
}
console.log('Self-check passed.');
