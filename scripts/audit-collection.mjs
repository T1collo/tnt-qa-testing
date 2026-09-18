// Static conformance audit of the Postman collection against the Taifacare Technical
// Onboarding Guide v0.2 and the GS1 EPC URI rules it cites.
//
// Pure analysis - reads the collection, fires nothing. Run: node scripts/audit-collection.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const COLLECTION = path.join(ROOT, 'Kenya TNT - Partner API Partner.postman_collection.json');

const findings = [];
function finding(severity, rule, where, detail) {
  findings.push({ severity, rule, where, detail });
}

// --- GS1 EPC URI shapes (guide §2.2, and the check-digit rules it defers to) -------------
// SGTIN: <gcp>.<indicator+itemRef>.<serial>, gcp+itemRef = 13 digits.
// SSCC:  <gcp>.<serialRef>, gcp+serialRef = 17 digits (the 18th is the check digit, which
//        the URI form omits).
// SGLN:  <gcp>.<locationRef>.<extension>, gcp+locationRef = 12 digits.
function auditIdentifier(uri, where) {
  const sgtin = uri.match(/^urn:epc:id:sgtin:([^.]*)\.([^.]*)\.(.*)$/);
  if (sgtin) {
    const [, gcp, item] = sgtin;
    if (!/^\d+$/.test(gcp) || !/^\d+$/.test(item)) {
      finding('HIGH', 'GS1 SGTIN', where, `${uri} — company prefix and item reference must be numeric`);
    } else if (gcp.length + item.length !== 13) {
      finding('HIGH', 'GS1 SGTIN', where, `${uri} — prefix+itemRef is ${gcp.length + item.length} digits, must be 13`);
    }
    return;
  }
  if (/^urn:epc:id:sgtin:/.test(uri)) {
    finding('HIGH', 'GS1 SGTIN', where, `${uri} — malformed, expected <gcp>.<itemRef>.<serial>`);
    return;
  }
  const sscc = uri.match(/^urn:epc:id:sscc:([^.]*)\.(.*)$/);
  if (sscc) {
    const [, gcp, ref] = sscc;
    if (!/^\d+$/.test(gcp) || !/^\d+$/.test(ref)) {
      finding('HIGH', 'GS1 SSCC', where, `${uri} — must be numeric`);
    } else if (gcp.length + ref.length !== 17) {
      finding('HIGH', 'GS1 SSCC', where, `${uri} — ${gcp.length + ref.length} digits, must be 17`);
    }
    return;
  }
  const sgln = uri.match(/^urn:epc:id:sgln:([^.]*)\.([^.]*)\.(.*)$/);
  if (sgln) {
    const [, gcp, loc] = sgln;
    if (gcp.length + loc.length !== 12) {
      finding('MEDIUM', 'GS1 SGLN', where, `${uri} — prefix+locationRef is ${gcp.length + loc.length} digits, must be 12`);
    }
    return;
  }
  if (/^urn:epc:id:sgln:/.test(uri)) {
    finding('MEDIUM', 'GS1 SGLN', where, `${uri} — malformed, expected <gcp>.<locRef>.<ext>`);
  }
}

// --- Per-event rules straight out of the guide -------------------------------------------
function auditEvent(event, where) {
  const biz = event.bizStep || '';
  const disp = event.disposition || '';

  // §6.1.1 MISSING_NEEDED_FIELDS - fields mandated for every event.
  for (const field of ['eventID', 'eventTime', 'eventTimeZoneOffset', 'action', 'bizStep']) {
    if (!event[field]) finding('HIGH', 'Mandatory field', where, `missing ${field}`);
  }

  // §6.1.1 FUTURE_EVENT_TIME - hard reject beyond 5 minutes ahead of server time.
  if (event.eventTime && new Date(event.eventTime).getTime() > Date.now() + 5 * 60_000) {
    finding('HIGH', '§6.1.1 FUTURE_EVENT_TIME', where, `eventTime ${event.eventTime} is in the future`);
  }

  // §3.3.3 - dispensing takes SGTINs only, never an SSCC.
  if (biz === 'dispensing') {
    if (disp !== 'dispensed') finding('HIGH', '§3.3.3 dispensing', where, `disposition is "${disp}", must be dispensed`);
    if (event.action !== 'OBSERVE') finding('HIGH', '§3.3.3 dispensing', where, `action is "${event.action}", must be OBSERVE`);
    for (const epc of event.epcList || []) {
      if (epc.includes(':sscc:')) finding('HIGH', '§3.3.3 dispensing', where, `SSCC ${epc} in epcList — SGTINs only`);
    }
    if (!event.epcList?.length && !event.quantityList?.length) {
      finding('HIGH', '§3.3.3 dispensing', where, 'needs epcList or quantityList');
    }
  }

  // §4.2.1 - a return is a shipping/receiving event distinguished only by disposition, so
  // the source/destination inversion and the RMA reference are what carry the meaning.
  if (disp === 'returned') {
    for (const field of ['sourceList', 'destinationList', 'bizTransactionList']) {
      if (!event[field]?.length) finding('HIGH', '§4.2.1 returns', where, `missing ${field} (mandatory for returns)`);
    }
    const destTypes = (event.destinationList || []).map((d) => d.type || '');
    if (!destTypes.some((t) => t.includes('location'))) {
      finding('MEDIUM', '§4.2.1 returns', where, 'destinationList must include an sdt:location entry');
    }
    if (!destTypes.some((t) => t.includes('owning_party'))) {
      finding('MEDIUM', '§4.2.1 returns', where, 'destinationList must include an sdt:owning_party entry');
    }
  }

  // §3.1.1.1 Lot Integrity - one lot per commissioning event, and §6.1.1 expiry format.
  if (biz === 'commissioning') {
    const ilmd = event.ilmd || {};
    const expiry = ilmd['cbvmda:itemExpirationDate'];
    if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      finding('HIGH', '§6.1.1 INVALID_EXPIRY_FORMAT', where, `itemExpirationDate "${expiry}" must be YYYY-MM-DD`);
    }
    if (!ilmd['cbvmda:lotNumber']) {
      finding('MEDIUM', '§3.1.1.1 lot integrity', where, 'commissioning event carries no ilmd lotNumber');
    }
  }

  // Aggregation events need both ends of the relationship.
  if (event.type === 'AggregationEvent') {
    if (!event.parentID) finding('HIGH', '§3.1.2 aggregation', where, 'missing parentID');
    if (!event.childEPCs?.length && !event.childQuantityList?.length) {
      finding('HIGH', '§3.1.2 aggregation', where, 'missing childEPCs');
    }
  }

  for (const epc of [...(event.epcList || []), ...(event.childEPCs || [])]) auditIdentifier(epc, where);
  if (event.parentID) auditIdentifier(event.parentID, where);
  for (const key of ['readPoint', 'bizLocation']) {
    if (event[key]?.id) auditIdentifier(event[key].id, where);
  }
}

// --- Walk the collection ------------------------------------------------------------------
const collection = JSON.parse(fs.readFileSync(COLLECTION, 'utf8'));
let jsonEvents = 0;
let requests = 0;

(function walk(items, trail) {
  for (const item of items || []) {
    const here = [...trail, item.name];
    if (item.request) {
      requests += 1;
      const where = here.join(' > ');
      const raw = item.request.body?.raw;
      const isJson = (item.request.header || []).some((h) => /ld\+json/.test(h.value || ''));
      const url = item.request.url?.raw || '';

      // §2.5.1 - EPCIS submissions authenticate with X-API-Key.
      if (!(item.request.header || []).some((h) => h.key === 'X-API-Key')) {
        finding('HIGH', '§2.5.1 authentication', where, 'request sends no X-API-Key header');
      }
      // §2.6.1 / §3.3.3 - dispensing has its own synchronous endpoint.
      if (/dispens/i.test(where) && !/\/dispense$/.test(url)) {
        finding('HIGH', '§2.6.1 sync dispense', where, `posts to ${url}, must use /events/dispense`);
      }
      if (!/dispens/i.test(where) && /\/dispense$/.test(url)) {
        finding('HIGH', '§2.6.2 async', where, 'non-dispensing event posted to the synchronous dispense endpoint');
      }

      if (isJson && raw) {
        let doc;
        try {
          doc = JSON.parse(raw);
        } catch {
          finding('HIGH', '§6.1.1 INVALID_JSON_STRUCTURE', where, 'body is not valid JSON');
          continue;
        }
        // §2.4 - EPCIS 2.0 JSON-LD requires the GS1 context.
        if (!doc['@context']) finding('HIGH', '§2.4 JSON-LD context', where, 'missing @context');
        if (doc.schemaVersion && doc.schemaVersion !== '2.0') {
          finding('MEDIUM', '§2.4 schema version', where, `schemaVersion ${doc.schemaVersion} for a JSON-LD body`);
        }
        for (const event of doc.epcisBody?.eventList || []) {
          jsonEvents += 1;
          auditEvent(event, where);
        }
      }
    } else {
      walk(item.item, here);
    }
  }
})(collection.item, []);

// --- Report -------------------------------------------------------------------------------
const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule));

console.log(`Collection audit — ${requests} requests, ${jsonEvents} JSON-LD events checked\n`);
if (findings.length === 0) {
  console.log('No conformance issues found.');
} else {
  let lastRule = '';
  for (const f of findings) {
    if (f.rule !== lastRule) {
      console.log(`\n[${f.severity}] ${f.rule}`);
      lastRule = f.rule;
    }
    console.log(`   ${f.where}`);
    console.log(`      ${f.detail}`);
  }
  console.log(`\n${findings.length} finding(s).`);
}
