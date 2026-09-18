// End-to-end multi-role journey: one consignment walked from manufacturer commissioning all
// the way to dispensing at a facility, using all three partner API keys in sequence.
//
// Why this exists separately from the per-role suite: the Postman collection fires each
// request with its own hard-coded identifiers, so nothing actually chains. Its Commission
// event commissions urn:epc:id:sgtin:6161102974997.CW2278, but its Pack event aggregates
// 0614141.000111.0000001/2 - serials that were never commissioned. Per the onboarding guide
// §3.1.2.1 ("every child EPC in an Aggregation event must have a prior Commissioning event
// recorded in the Hub") that combination can never be a clean pass. Dispense had the same
// break, referencing the commissioned serial rather than what the facility unpacked.
//
// So this mints one coherent identifier set per run and substitutes it across every step,
// producing a chain the platform can actually validate end to end.
const crypto = require('crypto');
const { loadCollection, findNode, normaliseSglns } = require('./postmanRunner');
const { planRequests, planOversizeProbe, DOCUMENT_MODES } = require('./documentPlan');
const { defaultProduct, findProduct } = require('./productRegistry');

const ROLE_ENDPOINTS = {
  manufacturer: '/api/integration/manufacturer/events',
  distributor: '/api/integration/supplier/events',
  facility: '/api/integration/facility/events',
};

// Guide §2.6.1 / §3.3.3: dispensing is the one synchronous step and has its own endpoint.
// Posting it to the async route is rejected outright with USE_DISPENSE_ENDPOINT.
const DISPENSE_ENDPOINT = '/api/integration/facility/events/dispense';

// The journey, in the order the guide lays it out across §3.1 -> §3.2 -> §3.3.
const FLOW_STEPS = [
  { key: 'mfg-commission', role: 'manufacturer', label: 'Commission', testId: 'API-MFG-COMM-001', path: ['Manufacturer Events', 'Commission (ObjectEvent)'] },
  { key: 'mfg-pack', role: 'manufacturer', label: 'Pack items into case', testId: 'API-MFG-PACK-001', path: ['Manufacturer Events', 'Pack (AggregationEvent)'] },
  { key: 'mfg-pack-sscc', role: 'manufacturer', label: 'Pack cases onto pallet', testId: 'API-MFG-PACK-002', path: ['Manufacturer Events', 'Pack SSCC into SSCC (AggregationEvent)'] },
  { key: 'mfg-ship', role: 'manufacturer', label: 'Ship to distributor', testId: 'API-MFG-SHIP-001', path: ['Manufacturer Events', 'Ship (ObjectEvent)'] },
  { key: 'dist-receive', role: 'distributor', label: 'Receive pallet', testId: 'API-DIST-RECV-001', path: ['Distributor Events', 'Receive (ObjectEvent)'] },
  { key: 'dist-unpack', role: 'distributor', label: 'Unpack pallet', testId: 'API-DIST-UNPACK-002', path: ['Distributor Events', 'Unpack (AggregationEvent)'] },
  { key: 'dist-pack', role: 'distributor', label: 'Repack into case', testId: 'API-DIST-PACK-001', path: ['Distributor Events', 'Pack (AggregationEvent)'] },
  { key: 'dist-ship', role: 'distributor', label: 'Ship to facility', testId: 'API-DIST-SHIP-001', path: ['Distributor Events', 'Ship (ObjectEvent)'] },
  { key: 'fac-receive', role: 'facility', label: 'Receive case', testId: 'API-FAC-RECV-001', path: ['Facility Events', 'Receive (ObjectEvent)'] },
  { key: 'fac-unpack', role: 'facility', label: 'Unpack case', testId: 'API-FAC-UNPACK-002', path: ['Facility Events', 'Unpack (AggregationEvent)'] },
  { key: 'fac-dispense', role: 'facility', label: 'Dispense', testId: 'API-FAC-DISP-001', path: ['Facility Events', 'Dispense (ObjectEvent - SGTIN only)'], sync: true },

  // Reverse logistics (§4.2). A return uses the SAME `shipping` bizStep as a forward
  // shipment - the direction is carried entirely by disposition=returned and the inversion
  // of sourceList/destinationList - so the only way to prove the platform tells them apart
  // is to walk the goods back up the chain the way it walked them down.
  { key: 'fac-return-ship', role: 'facility', phase: 'return', label: 'Return shipment', testId: 'API-SPEC-RET-001', path: ['Special Events', 'Facility', 'Return Shipping (shipping / returned)'] },
  { key: 'dist-return-recv', role: 'distributor', phase: 'return', label: 'Receive return', testId: 'API-SPEC-RET-002', path: ['Special Events', 'Distributor', 'Return Receiving (receiving / returned)'] },
  { key: 'dist-return-ship', role: 'distributor', phase: 'return', label: 'Return shipment', testId: 'API-SPEC-RET-001', path: ['Special Events', 'Distributor', 'Return Shipping (shipping / returned)'] },
  { key: 'mfg-return-recv', role: 'manufacturer', phase: 'return', label: 'Receive return', testId: 'API-SPEC-RET-002', path: ['Special Events', 'Manufacturer', 'Return Receiving (receiving / returned)'] },

  // Terminal state (§4.3). The guide requires recall to be a TWO-stage process - a Recall
  // Initiation (disposition -> recalled) and only then a Destruction Completion
  // (disposition -> destroyed), "never combined into one". The collection ships no Recall
  // Initiation request, so this step necessarily submits destruction without the initiation
  // that should precede it. Reported rather than papered over.
  { key: 'mfg-destroy', role: 'manufacturer', phase: 'terminal', label: 'Destruction', testId: 'API-SPEC-RECALL-003', path: ['Special Events', 'Manufacturer', 'Destruction (destroying / destroyed)'] },
];

// The identifiers baked into the collection, in the roles they play in the journey.
const TEMPLATE = {
  sgtin1: 'urn:epc:id:sgtin:0614141.000111.0000001',
  sgtin2: 'urn:epc:id:sgtin:0614141.000111.0000002',
  // Commission and Dispense both use this third, unrelated serial - the break in the chain.
  strayCommissionSgtin: 'urn:epc:id:sgtin:6161102974997.CW2278',
  caseA: 'urn:epc:id:sscc:0614141.0000000001',
  caseB: 'urn:epc:id:sscc:0614141.0000001001',
  caseC: 'urn:epc:id:sscc:0614141.0000001002',
  pallet: 'urn:epc:id:sscc:0614141.0000005000',
  distCase: 'urn:epc:id:sscc:0619999.0000000100',
  lot: 'BATCH-20260805-CR6X59',
  expiry: '2027-07-15',
};

function digits(n) {
  let out = '';
  for (let i = 0; i < n; i += 1) out += Math.floor(Math.random() * 10);
  return out;
}

// SSCC EPC URIs need GCP + serial reference to total exactly 17 digits (the API rejects
// anything else with INVALID_GS1_IDENTIFIER).
function sscc(gcp) {
  return `urn:epc:id:sscc:${gcp}.${digits(17 - gcp.length)}`;
}

// Guide 6.1.1: TOO_MANY_SERIALS above 50,000 serials in one message. Anything at or below
// that is a legitimate consignment size, so the caller picks - two serials is the smallest
// batch that still exercises multi-child aggregation, which is why it is the default.
const DEFAULT_SERIAL_COUNT = 2;
const MAX_SERIAL_COUNT = 50_000;

function clampSerialCount(requested) {
  // null/undefined/empty mean "not specified", which is the default rather than one serial.
  if (requested === null || requested === undefined || requested === '') return DEFAULT_SERIAL_COUNT;
  const n = Number(requested);
  if (!Number.isFinite(n)) return DEFAULT_SERIAL_COUNT;
  return Math.max(1, Math.min(MAX_SERIAL_COUNT, Math.trunc(n)));
}

// Accepts one product reference or a list, so a consignment can mix products. Unknown
// references are dropped; with none left the registry default is used.
function resolveProducts(productRefs) {
  const refs = Array.isArray(productRefs) ? productRefs : productRefs ? [productRefs] : [];
  const seen = new Set();
  const products = [];
  for (const ref of refs) {
    const product = findProduct(ref);
    if (product && !seen.has(product.gtin)) {
      seen.add(product.gtin);
      products.push(product);
    }
  }
  return products.length ? products : [defaultProduct()];
}

// `serialCount` is per product. With several products the per-product count is capped so
// the whole consignment stays within the 50,000-serial message limit.
function mintIdentifiers(serialCount = DEFAULT_SERIAL_COUNT, productRefs = null) {
  const products = resolveProducts(productRefs);
  const count = Math.min(clampSerialCount(serialCount), Math.floor(MAX_SERIAL_COUNT / products.length));
  const tag = crypto.randomBytes(3).toString('hex').toUpperCase();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // Serial uniqueness has to hold across runs as well as within one, because the platform
  // dedupes on business content and a repeated serial would collide with an earlier
  // consignment. An 8-digit slice of the clock scopes the run; the index scopes the item.
  const runSeed = String(Date.now()).slice(-8);

  // Guide 3.1.1.1 keeps one lot per commissioning event, so each product is its own line
  // with its own lot and is commissioned by its own event. Later steps carry every serial.
  const lines = products.map((product, p) => {
    const serials = new Array(count);
    for (let i = 0; i < count; i += 1) {
      // The product index is part of the serial: the portal's serial registry treats a serial
      // value as unique across products, so two lines sharing "...00000" collide there.
      serials[i] = `${product.sgtinPrefix}.${runSeed}${p}${String(i).padStart(5, '0')}`;
    }
    return {
      product: {
        productId: product.productId,
        gtin: product.gtin,
        brand: product.brand,
        generic: product.generic,
        sgtinPrefix: product.sgtinPrefix,
      },
      lot: products.length === 1 ? `LOT-${today}-${tag}` : `LOT-${today}-${tag}-${p + 1}`,
      // Null keeps the collection's expiry; a portal batch replaces both lot and expiry.
      expiry: null,
      batchSource: 'minted',
      serials,
    };
  });
  const serials = lines.flatMap((line) => line.serials);

  return {
    tag,
    // First product and lot, kept for single-product consumers; `lines` is authoritative.
    product: lines[0].product,
    products: lines.map((line) => line.product),
    lines,
    serialCount: serials.length,
    serialsPerProduct: count,
    serials,
    // Kept for the textual substitution map, which still swaps the collection's two
    // hard-coded serials; the authoritative list is `serials`.
    sgtin1: serials[0],
    sgtin2: serials[1] ?? serials[0],
    caseA: sscc('0614141'),
    caseB: sscc('0614141'),
    caseC: sscc('0614141'),
    pallet: sscc('0614141'),
    distCase: sscc('0619999'),
    lot: lines[0].lot,
    expiry: null,
  };
}

// Swaps each line's minted lot for the batch the portal created (lot = batch number, and
// the batch's expiry). Lines whose batch failed keep their minted lot and say so.
function applyPortalBatches(ids, batchResults) {
  ids.lines.forEach((line, i) => {
    const batch = batchResults[i];
    if (!batch?.ok) return;
    line.lot = batch.batchNo;
    line.expiry = batch.expiry;
    line.batchSource = 'portal';
    line.batchId = batch.batchId;
  });
  ids.lot = ids.lines[0].lot;
  ids.expiry = ids.lines[0].expiry;
  return ids;
}

// Straight textual substitution of the template identifiers for the minted ones. Applied to
// the raw body so it works for the JSON-LD variant without needing to know each event shape.
function substitute(raw, ids) {
  let out = raw;
  const map = [
    [TEMPLATE.strayCommissionSgtin, ids.sgtin1],
    [TEMPLATE.sgtin1, ids.sgtin1],
    [TEMPLATE.sgtin2, ids.sgtin2],
    [TEMPLATE.pallet, ids.pallet],
    [TEMPLATE.caseB, ids.caseB],
    [TEMPLATE.caseC, ids.caseC],
    [TEMPLATE.caseA, ids.caseA],
    [TEMPLATE.distCase, ids.distCase],
    [TEMPLATE.lot, ids.lot],
    ...(ids.expiry ? [[TEMPLATE.expiry, ids.expiry]] : []),
  ];
  for (const [from, to] of map) out = out.split(from).join(to);
  return out;
}

// Structural fixes that a string swap can't express, plus fresh IDs and timestamps.
// `offsetMinutes` walks backwards from now so the chain is temporally ordered and recent -
// the platform flags STALE_EVENT_TIME beyond 7 days, and the collection's dates are months old.
// Which field each step uses to carry serials. The two SSCC-to-SSCC aggregation steps also
// have a childEPCs array, but it holds cases and pallets - writing serials into those would
// change what the step tests, so they are deliberately absent here.
const SERIAL_FIELDS = {
  'mfg-commission': 'epcList',
  'mfg-pack': 'childEPCs',
  'dist-pack': 'childEPCs',
  'fac-unpack': 'childEPCs',
  'fac-dispense': 'epcList',
  // Reverse logistics and the terminal state carry the same consignment back up the chain.
  // Without these the collection's single hard-coded serial leaked through, so a 200-serial
  // batch would ship 200 and then return and destroy exactly one - the consignment stopped
  // being traceable at the point it turned around.
  'fac-return-ship': 'epcList',
  'dist-return-recv': 'epcList',
  'dist-return-ship': 'epcList',
  'mfg-return-recv': 'epcList',
  'mfg-destroy': 'epcList',
};

// Structural fixes that a string swap cannot express, plus fresh IDs and timestamps.
// `offsetMinutes` walks backwards from now so the chain is temporally ordered and recent -
// the platform flags STALE_EVENT_TIME beyond 7 days, and the collection's dates are months old.
function prepareDocument(rawJson, step, ids, offsetMinutes) {
  // Journey steps are happy-path by definition, so malformed example locations are repaired.
  const doc = JSON.parse(normaliseSglns(substitute(rawJson, ids)));
  const eventTime = new Date(Date.now() - offsetMinutes * 60_000).toISOString();
  doc.creationDate = new Date().toISOString();

  // A mixed consignment is commissioned with one event per product line, each with its lot.
  const perLine = step.key === 'mfg-commission' && ids.lines?.length > 1;
  if (perLine && doc.epcisBody?.eventList) {
    doc.epcisBody.eventList = doc.epcisBody.eventList.flatMap((event) =>
      ids.lines.map((line) => {
        let text = JSON.stringify(event).split(ids.lot).join(line.lot);
        // Every line carries its own expiry: its portal batch's, or the collection's.
        text = text.split(ids.expiry || TEMPLATE.expiry).join(line.expiry || TEMPLATE.expiry);
        return { ...JSON.parse(text), epcList: line.serials };
      })
    );
  }

  const serialField = SERIAL_FIELDS[step.key];
  for (const event of doc.epcisBody?.eventList || []) {
    event.eventID = `urn:uuid:${crypto.randomUUID()}`;
    event.eventTime = eventTime;

    // Guide 3.1.2.1: every child EPC aggregated later must have been commissioned, and
    // 3.1.1.1 keeps one lot per commissioning event. Writing the same list everywhere is
    // what keeps the consignment coherent from commissioning through to dispensing.
    if (serialField && !perLine) event[serialField] = ids.serials;
  }
  return doc;
}

function endpointFor(step, baseUrl) {
  return `${baseUrl}${step.sync ? DISPENSE_ENDPOINT : ROLE_ENDPOINTS[step.role]}`;
}

function describeResponse(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed.code) return parsed.code;
    if (parsed.success) {
      const warnings = (parsed.warnings || []).map((w) => w.code);
      return warnings.length ? `accepted (${warnings.join(', ')})` : 'accepted';
    }
    return parsed.message || 'no code';
  } catch {
    return 'unparseable response';
  }
}

// Splits a batch response back out to the steps it spoke for.
//
// `event_ids` comes back in submission order, so position maps an event to its step. Warnings
// do NOT carry an event id or index - they arrive as one flat list for the whole document -
// so a warning is attributed to a step by matching the identifiers that step owns. That is a
// heuristic, not something the API tells us, and it is labelled as inferred downstream.
function attributeToMembers(request, outcome, ids) {
  let parsed = null;
  try {
    parsed = JSON.parse(outcome.responseBody || '');
  } catch {
    // Non-JSON body; every member just inherits the batch outcome.
  }
  const eventIds = parsed?.event_ids || [];
  const warnings = parsed?.warnings || [];

  // Which minted identifiers each step is expected to touch, used to place warnings.
  const ownedBy = (step) => {
    const owned = [];
    if (step.key === 'mfg-commission') {
      owned.push(...ids.serials, ...(ids.lines || []).map((line) => line.lot));
    }
    if (step.key === 'mfg-pack') owned.push(ids.caseA, ...ids.serials);
    if (step.key === 'mfg-pack-sscc') owned.push(ids.pallet, ids.caseB, ids.caseC, ids.caseA);
    if (['mfg-ship', 'dist-receive', 'dist-unpack'].includes(step.key)) owned.push(ids.pallet);
    if (['dist-pack', 'dist-ship', 'fac-receive'].includes(step.key)) owned.push(ids.distCase);
    if (['fac-unpack', 'fac-dispense'].includes(step.key)) owned.push(...ids.serials);
    return owned.filter(Boolean);
  };

  // A warning is only pinned to a step when exactly one step in the batch could own the
  // identifier it names. Commission and Pack both legitimately reference the same serials,
  // so a naive "does this step own the id" test hands Pack's UNCOMMISSIONED_CHILD to
  // Commission. Ambiguous and unmatched warnings belong to the document, not to a step.
  const owners = request.members.map((member) => ({ member, owned: ownedBy(member.step) }));
  const pinned = new Map(request.members.map((m) => [m.step.key, []]));
  const documentLevel = [];

  for (const warning of warnings) {
    const text = String(warning.message || '');
    const matches = owners.filter((o) => o.owned.some((id) => text.includes(id)));
    if (matches.length === 1) pinned.get(matches[0].member.step.key).push(warning.code);
    else documentLevel.push(warning.code);
  }

  return request.members.map((member, i) => ({
    member,
    eventId: eventIds[member.eventOffset] ?? null,
    warnings: pinned.get(member.step.key) || [],
    // Reported once per document rather than repeated against every member.
    unattributedWarnings: i === 0 ? documentLevel : [],
  }));
}

// Runs the whole journey. Every request is attempted even after a failure: knowing that
// commissioning broke AND that the downstream steps then flagged UNKNOWN_SGTIN is the point
// of an end-to-end run - stopping at the first error hides the cascade.
//
// Guide 2.6.2: every step except dispensing is processed asynchronously and "processing may
// be completed after the initial response", so the chain pauses between requests.
//
// Measured caveat: against tnt-demo the pause made no difference. Runs at settleMs 0 and 4000
// returned byte-identical warning sets, so UNCOMMISSIONED_CHILD / UNKNOWN_SGTIN /
// NO_REGULATORY_APPROVAL on a freshly minted consignment are NOT a timing artefact - the
// serials simply are not in that environment's master-data registry, and commissioning alone
// does not add them. A genuinely clean journey needs pre-provisioned master data.
async function runEndToEnd(
  {
    tokens,
    baseUrl,
    settleMs = 1000,
    documentMode = 'split',
    serialCount = DEFAULT_SERIAL_COUNT,
    products = null,
    // Pre-minted by the caller when it wants to record the consignment before firing.
    identifiers = null,
  },
  onProgress
) {
  if (!DOCUMENT_MODES.includes(documentMode)) {
    throw new Error(`Unknown documentMode "${documentMode}"`);
  }
  const collection = loadCollection();
  const ids = identifiers || mintIdentifiers(serialCount, products);

  let requests;
  const gaps = [];
  if (documentMode === 'oversize') {
    requests = planOversizeProbe({ baseUrl, roleEndpoints: ROLE_ENDPOINTS });
  } else {
    const prepared = [];
    for (let i = 0; i < FLOW_STEPS.length; i += 1) {
      const step = FLOW_STEPS[i];
      const node = findNode(collection.item, [...step.path, 'JSON-LD']);
      if (!node) {
        gaps.push({ step, index: i });
        continue;
      }
      prepared.push({
        step,
        index: i,
        endpoint: endpointFor(step, baseUrl),
        document: prepareDocument(node.request.body.raw, step, ids, FLOW_STEPS.length - i),
      });
    }
    requests = planRequests({ prepared, mode: documentMode });
  }

  const steps = [];
  const totalSteps = requests.reduce((n, r) => n + r.members.length, 0) + gaps.length;

  // A step with no collection node never reaches a request; report it in place.
  for (const gap of gaps) {
    const result = {
      ...gap.step,
      index: gap.index + 1,
      of: totalSteps,
      ok: false,
      summary: `collection node not found: ${gap.step.path.join(' > ')}`,
      documentMode,
    };
    steps.push(result);
    if (onProgress) onProgress(result);
  }

  for (let r = 0; r < requests.length; r += 1) {
    const request = requests[r];
    const token = tokens[request.role];

    let outcome;
    if (!token) {
      outcome = { ok: false, skipped: true, summary: `no ${request.role} token supplied` };
    } else {
      const startedAt = Date.now();
      try {
        const res = await fetch(request.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/ld+json', 'X-API-Key': token },
          body: request.body,
        });
        const text = await res.text().catch(() => '');
        const success = res.status >= 200 && res.status < 300;
        outcome = {
          // A limits probe passes by being refused - a 2xx there means the ceiling is not
          // enforced, which is itself the finding.
          ok: request.expectRejection ? res.status >= 400 && res.status < 500 : success,
          status: res.status,
          summary: describeResponse(text),
          responseBody: text,
          durationMs: Date.now() - startedAt,
          url: request.endpoint,
        };
      } catch (err) {
        outcome = {
          ok: false,
          summary: `network error: ${err.message}`,
          durationMs: Date.now() - startedAt,
          url: request.endpoint,
        };
      }
    }

    for (const attribution of attributeToMembers(request, outcome, ids)) {
      const { member } = attribution;
      const result = {
        ...member.step,
        index: member.index + 1,
        of: totalSteps,
        ...outcome,
        documentMode,
        batchId: request.batchId,
        batchSize: request.members.length,
        batchEventCount: request.eventCount,
        // The exact document sent (a limits probe or a skipped step has none worth keeping).
        requestBody: outcome.skipped ? undefined : request.body,
        eventId: attribution.eventId,
        attributedWarnings: attribution.warnings,
        unattributedWarnings: attribution.unattributedWarnings,
      };
      steps.push(result);
      if (onProgress) onProgress(result);
    }

    const isLast = r === requests.length - 1;
    if (!isLast && settleMs > 0 && !outcome.skipped) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
  }

  return {
    identifiers: ids,
    documentMode,
    serialCount: ids.serialCount,
    steps,
    requests: requests.map((req) => ({
      batchId: req.batchId,
      role: req.role,
      eventCount: req.eventCount,
      stepCount: req.members.length,
      sync: req.sync,
    })),
    ok: steps.every((s) => s.ok),
    completedSteps: steps.filter((s) => s.ok).length,
    totalSteps: steps.length,
    requestCount: requests.length,
  };
}

for (const step of FLOW_STEPS) if (!step.phase) step.phase = 'forward';

module.exports = {
  runEndToEnd,
  DEFAULT_SERIAL_COUNT,
  MAX_SERIAL_COUNT,
  clampSerialCount,
  FLOW_STEPS,
  mintIdentifiers,
  applyPortalBatches,
  prepareDocument,
  ROLE_ENDPOINTS,
  DISPENSE_ENDPOINT,
  DOCUMENT_MODES,
};
