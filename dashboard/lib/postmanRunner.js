// Fires requests straight out of "Kenya TNT - Partner API Partner.postman_collection.json"
// for a given role, using the testIdMap.js manifest to know which collection nodes to run.
// Deliberately doesn't pull in `newman` - we don't need a full Postman runtime, just to walk
// the JSON tree and substitute {{base_url}} / {{api_key}}.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { forRole } = require('./testIdMap');
const { PROJECT_ROOT } = require('./paths');

const COLLECTION_PATH = path.join(
  PROJECT_ROOT,
  'Kenya TNT - Partner API Partner.postman_collection.json'
);

// Cached, but keyed on the file's mtime: the collection is an editable artifact (fixing a
// malformed identifier, correcting an endpoint), and a cache held for the life of the
// process meant those edits silently didn't take effect until someone restarted the server.
let collectionCache = null;
let collectionMtimeMs = null;
function loadCollection() {
  const { mtimeMs } = fs.statSync(COLLECTION_PATH);
  if (!collectionCache || mtimeMs !== collectionMtimeMs) {
    collectionCache = JSON.parse(fs.readFileSync(COLLECTION_PATH, 'utf-8'));
    collectionMtimeMs = mtimeMs;
  }
  return collectionCache;
}

// Walks collection.item by folder/request name at each level.
function findNode(items, segments) {
  let level = items;
  let node = null;
  for (const name of segments) {
    node = (level || []).find((n) => n.name === name);
    if (!node) return null;
    level = node.item;
  }
  return node;
}

function resolveVars(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, key) => (key in vars ? vars[key] : `{{${key}}}`));
}

// The collection hard-codes one eventID per request, so the API answers every re-run with
// 409 DUPLICATE_EVENT_ID and nothing downstream is ever exercised. Minting a fresh UUID per
// fire makes the suite repeatable. Matches the JSON-LD ("eventID": "...") and XML
// (<eventID>...</eventID>) spellings, since each request ships both variants.
//
// This does NOT defeat 409 DUPLICATE_EVENT_PAYLOAD: that one keys on business content
// (SSCC+bizStep+disposition+readPoint), and the API's own guidance is that such retries
// must reuse the original eventID. Clearing those needs per-run business data, which would
// change what the test asserts - deliberately out of scope here.
function freshenEventIds(body) {
  if (typeof body !== 'string') return body;
  // Every identifier that names an event - in an eventID field or referenced elsewhere, such as
  // an error declaration's correctiveEventIDs - is mapped once and replaced everywhere, so
  // references between events survive the renaming.
  const ids = new Set();
  for (const m of body.matchAll(/"eventID"\s*:\s*"([^"]+)"/g)) ids.add(m[1]);
  for (const m of body.matchAll(/<eventID>\s*([^<\s]+)\s*<\/eventID>/g)) ids.add(m[1]);
  for (const m of body.matchAll(/urn:uuid:[0-9A-Za-z-]+/g)) ids.add(m[0]);
  // Longest first, so an ID that happens to prefix another is never replaced inside it.
  let out = body;
  for (const id of [...ids].sort((a, b) => b.length - a.length)) {
    out = out.split(id).join(`urn:uuid:${crypto.randomUUID()}`);
  }
  return out;
}

// Opt-in "fresh data" mode for happy-path runs. Without it the collection's fixed serials
// and SSCCs make every repeat run a 409 DUPLICATE_EVENT_PAYLOAD, so a regression can only ever
// prove the first submission worked. With it, each request gets its own serials, SSCCs and
// timestamps, so a valid event is judged on whether it is valid - not on whether it is new.
//
// Mappings are per request body: a parent SSCC and the child that references it stay linked,
// and the JSON-LD and XML variants each get their own set so they cannot collide.
const DEFAULT_SGTIN_PREFIX = 'urn:epc:id:sgtin:0614141.000111';
let serialCounter = 0;

function freshSerial() {
  serialCounter = (serialCounter + 1) % 100000;
  return `${String(Date.now()).slice(-8)}${String(serialCounter).padStart(5, '0')}`;
}

function freshDigits(n) {
  let out = '';
  for (let i = 0; i < n; i += 1) out += Math.floor(Math.random() * 10);
  return out;
}

// Location codes the collection's examples get wrong - urn:epc:id:sgln:10000000.00009.0 (13
// digits) and urn:epc:id:sgln:8888888.888888 (no extension) - are replaced with a valid one.
// A happy path must send valid data; a malformed location combined with a real product also
// crashes commissioning (HTTP 500), which is reported as its own finding, not as a happy-path
// failure. Valid locations are left exactly as they are.
const FALLBACK_SGLN = 'urn:epc:id:sgln:0614141.00001.0';

function isValidSgln(uri) {
  const m = uri.match(/^urn:epc:id:sgln:(\d+)\.(\d*)\.([0-9A-Za-z]+)$/);
  return Boolean(m) && m[1].length + m[2].length === 12;
}

function normaliseSglns(body) {
  if (typeof body !== 'string') return body;
  return body.replace(/urn:epc:id:sgln:[0-9A-Za-z.]+/g, (uri) => (isValidSgln(uri) ? uri : FALLBACK_SGLN));
}

function freshenBusinessData(body, { sgtinPrefix } = {}) {
  if (typeof body !== 'string') return body;
  const seen = new Map();
  const remember = (from, make) => {
    if (!seen.has(from)) seen.set(from, make());
    return seen.get(from);
  };

  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

  return normaliseSglns(body)
    // SGTINs. The collection includes a malformed two-part serial (whole GTIN as prefix, no
    // serial segment); a happy path must send valid identifiers, so anything that is not a
    // well-formed 13-digit prefix is replaced with a valid one.
    .replace(/urn:epc:id:sgtin:[0-9A-Za-z.]+/g, (uri) =>
      remember(uri, () => {
        const m = uri.match(/^urn:epc:id:sgtin:(\d+)\.(\d+)\.[0-9A-Za-z]+$/);
        const wellFormed = m && m[1].length + m[2].length === 13;
        const prefix = sgtinPrefix || (wellFormed ? `urn:epc:id:sgtin:${m[1]}.${m[2]}` : DEFAULT_SGTIN_PREFIX);
        return `${prefix}.${freshSerial()}`;
      }))
    // SSCCs keep their company prefix and get a fresh reference padded to 17 digits.
    .replace(/urn:epc:id:sscc:(\d+)\.\d+/g, (uri, gcp) =>
      remember(uri, () => `urn:epc:id:sscc:${gcp}.${freshDigits(17 - gcp.length)}`))
    // Recent, ordered timestamps: events 10 minutes ago, declarations now. The collection's
    // dates are months old, which only adds STALE_EVENT_TIME noise.
    .replace(/("eventTime"\s*:\s*")[^"]*(")/g, (_, a, b) => `${a}${at(10)}${b}`)
    .replace(/(<eventTime>)[^<]*(<\/eventTime>)/g, (_, a, b) => `${a}${at(10)}${b}`)
    .replace(/("declarationTime"\s*:\s*")[^"]*(")/g, (_, a, b) => `${a}${at(0)}${b}`)
    .replace(/(<declarationTime>)[^<]*(<\/declarationTime>)/g, (_, a, b) => `${a}${at(0)}${b}`)
    .replace(/("creationDate"\s*:\s*")[^"]*(")/g, (_, a, b) => `${a}${at(0)}${b}`)
    .replace(/(creationDate=")[^"]*(")/g, (_, a, b) => `${a}${at(0)}${b}`);
}

// An error declaration re-submits the ORIGINAL event's eventID with an errorDeclaration block
// (guide 6.4). Fresh IDs mean that original no longer exists, so the happy path submits it
// first - the same document with the declaration removed.
function hasErrorDeclaration(body) {
  return typeof body === 'string' && /errorDeclaration/.test(body);
}

function withoutErrorDeclaration(body) {
  if (body.trimStart().startsWith('{')) {
    const doc = JSON.parse(body);
    for (const event of doc.epcisBody?.eventList || []) delete event.errorDeclaration;
    return JSON.stringify(doc);
  }
  return body
    .replace(/<errorDeclaration>[\s\S]*?<\/errorDeclaration>/g, '')
    .replace(/<baseExtension>\s*<\/baseExtension>/g, '');
}

// For an incorrect_data declaration, the event(s) it names in correctiveEventIDs: a copy of
// the declared event under the corrective ID, without the declaration, and with its business
// transaction reference marked as corrected - the "incorrect data" being fixed.
function correctiveEvents(body) {
  if (body.trimStart().startsWith('{')) {
    const doc = JSON.parse(body);
    const out = [];
    for (const event of doc.epcisBody?.eventList || []) {
      for (const id of event.errorDeclaration?.correctiveEventIDs || []) {
        const fixed = JSON.parse(JSON.stringify(event));
        delete fixed.errorDeclaration;
        fixed.eventID = id;
        for (const bt of fixed.bizTransactionList || []) bt.bizTransaction = `${bt.bizTransaction}-CORRECTED`;
        out.push(JSON.stringify({ ...doc, epcisBody: { eventList: [fixed] } }));
      }
    }
    return out;
  }
  const ids = [...body.matchAll(/<correctiveEventID>\s*([^<\s]+)\s*<\/correctiveEventID>/g)].map((m) => m[1]);
  return ids.map((id) =>
    withoutErrorDeclaration(body)
      .replace(/(<eventID>)[^<]*(<\/eventID>)/, `$1${id}$2`)
      .replace(/(<bizTransaction[^>]*>)\s*([^<\s]+)\s*(<\/bizTransaction>)/g, '$1$2-CORRECTED$3')
  );
}

function buildRequest(requestNode, vars) {
  const req = requestNode.request;
  const method = req.method;
  const url = resolveVars(req.url.raw, vars);
  const headers = {};
  for (const h of req.header || []) {
    headers[h.key] = resolveVars(h.value, vars);
  }
  let body =
    req.body && req.body.mode === 'raw'
      ? freshenEventIds(resolveVars(req.body.raw, vars))
      : undefined;
  if (body && vars.__freshData) body = freshenBusinessData(body, { sgtinPrefix: vars.__sgtinPrefix });
  return { method, url, headers, body };
}

// Fires the JSON-LD and XML variant under a request-folder node ("Commission (ObjectEvent)"
// etc. each contain two children named "JSON-LD" and "XML").
async function fireVariants(requestFolderNode, vars, onProgress) {
  const variants = requestFolderNode.item || [];
  const results = [];
  for (const variant of variants) {
    const built = buildRequest(variant, vars);
    const startedAt = Date.now();
    let status = null;
    let responseBody = null;
    let error = null;
    let setup = null;
    try {
      if (vars.__freshData && hasErrorDeclaration(built.body)) {
        const original = await fetch(built.url, {
          method: built.method,
          headers: built.headers,
          body: withoutErrorDeclaration(built.body),
        });
        setup = { label: 'original event', status: original.status };
        const corrective = [];
        for (const correctiveBody of correctiveEvents(built.body)) {
          const res = await fetch(built.url, {
            method: built.method,
            headers: built.headers,
            body: correctiveBody,
          });
          corrective.push(res.status);
        }
        if (corrective.length) {
          setup.label = `original ${original.status}, corrective`;
          setup.status = corrective.join('/');
        }
        // Async registration was measured at several seconds; declaring against an event the
        // platform has not stored yet would test timing, not the declaration.
        await new Promise((resolve) => setTimeout(resolve, 6000));
      }
      const res = await fetch(built.url, {
        method: built.method,
        headers: built.headers,
        body: built.body,
      });
      status = res.status;
      responseBody = await res.text().catch(() => '');
    } catch (e) {
      error = e.message;
    }
    const durationMs = Date.now() - startedAt;
    const ok = error ? false : status >= 200 && status < 300;
    const result = {
      variant: variant.name,
      method: built.method,
      url: built.url,
      requestHeaders: redactHeaders(built.headers),
      requestBody: built.body,
      status,
      responseBody,
      error,
      durationMs,
      ok,
      ...(setup ? { setup } : {}),
    };
    results.push(result);
    if (onProgress) onProgress(result);
  }
  return results;
}

function redactHeaders(headers) {
  const redacted = { ...headers };
  if (redacted['X-API-Key']) redacted['X-API-Key'] = '***';
  return redacted;
}

// Runs every mapped test for `role`, optionally filtered to `eventTypes` (defaults to all).
// `apiToken` is only ever used in-memory to build the request headers - never persisted.
// Calls onProgress(perTestResult) as each Test ID finishes so the caller can stream live updates.
async function runForRole(
  { role, apiToken, baseUrl, eventTypes, freshData = false, sgtinPrefix = null, sgtinPrefixes = null },
  onProgress
) {
  const collection = loadCollection();
  const entries = forRole(role).filter((m) => !eventTypes || eventTypes.includes(m.eventType));
  // Double-underscore keys are runner options, never collection variables.
  const vars = { base_url: baseUrl, api_key: apiToken, __freshData: freshData, __sgtinPrefix: sgtinPrefix };
  // Several products rotate one per request, so each event still carries a single product
  // (and so a single lot) while the run as a whole covers them all.
  const prefixes = sgtinPrefixes?.length ? sgtinPrefixes : null;

  const perTestResults = [];
  for (const [n, entry] of entries.entries()) {
    if (prefixes) vars.__sgtinPrefix = prefixes[n % prefixes.length];
    const node = findNode(collection.item, entry.path);
    if (!node) {
      const missing = {
        testId: entry.testId,
        eventType: entry.eventType,
        path: entry.path,
        variants: [],
        ok: false,
        error: `Collection node not found for path: ${entry.path.join(' > ')}`,
      };
      perTestResults.push(missing);
      if (onProgress) onProgress(missing);
      continue;
    }
    const variantResults = await fireVariants(node, vars);
    const testResult = {
      testId: entry.testId,
      eventType: entry.eventType,
      path: entry.path,
      variants: variantResults,
      ok: variantResults.length > 0 && variantResults.every((v) => v.ok),
    };
    perTestResults.push(testResult);
    if (onProgress) onProgress(testResult);
  }
  return perTestResults;
}

module.exports = {
  runForRole,
  loadCollection,
  findNode,
  freshenEventIds,
  freshenBusinessData,
  normaliseSglns,
  isValidSgln,
  withoutErrorDeclaration,
  correctiveEvents,
};
