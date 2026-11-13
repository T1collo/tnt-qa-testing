// Decides how the journey's events are packed into EPCIS documents before they are sent.
//
// Three strategies, all built from the same step definitions and the same minted identifier
// set, so they can never drift in what they actually claim to submit:
//
//   split     one document per event (the original behaviour)
//   combined  one document per contiguous same-role run of the journey
//   oversize  a limits probe that deliberately breaches the documented message ceilings
//
// Why "combined" cannot simply be one document for everything: the endpoint AND the API key
// are both role-scoped, so a document can only ever carry events for a single partner. And
// guide §2.6.1 puts dispensing on its own synchronous endpoint, so it always travels alone.
// Batching contiguous runs (rather than merging all of a role's steps) keeps the journey in
// the order the guide lays it out - grouping purely by role would hoist the return legs
// ahead of the dispense that precedes them.
const crypto = require('crypto');

const DOCUMENT_MODES = ['split', 'combined', 'oversize'];

// Guide §6.1.1: TOO_MANY_SERIALS above 50,000 serials per message; MESSAGE_SIZE_EXCEEDED
// above 10 MB for an asynchronous submission.
const SERIAL_LIMIT = 50_000;
const ASYNC_SIZE_LIMIT = 10 * 1024 * 1024;

function newDocument(creationDate = new Date().toISOString()) {
  return {
    '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate,
    epcisBody: { eventList: [] },
  };
}

// Merges the events of several single-event documents into one envelope. Each event keeps
// its own eventTime, so temporal order inside the batch still reflects the journey even
// though everything arrives in a single request.
function mergeDocuments(documents) {
  const merged = newDocument();
  const first = documents[0];
  if (first?.['@context']) merged['@context'] = first['@context'];
  if (first?.schemaVersion) merged.schemaVersion = first.schemaVersion;
  for (const doc of documents) {
    for (const event of doc.epcisBody?.eventList || []) merged.epcisBody.eventList.push(event);
  }
  return merged;
}

// The XML counterpart of mergeDocuments: the first document's envelope with every
// document's <EventList> contents placed inside it, in order.
function mergeXmlDocuments(xmls) {
  const inner = (xml) => (xml.match(/<EventList>([\s\S]*?)<\/EventList>/) || [])[1] || '';
  return xmls[0].replace(/<EventList>[\s\S]*?<\/EventList>/, () => `<EventList>${xmls.map(inner).join('')}</EventList>`);
}

// A prepared entry carries either a JSON-LD `document` or an XML string (`xml` + `eventCount`).
const bodyOf = (entry) => (entry.xml !== undefined ? entry.xml : JSON.stringify(entry.document));
const eventCountOf = (entry) => (entry.xml !== undefined ? entry.eventCount : entry.document.epcisBody.eventList.length);
const contentTypeOf = (entry) => (entry.xml !== undefined ? 'application/xml' : 'application/ld+json');

// Contiguous runs of the same role, with any synchronous step forced into a group of its own.
function groupContiguous(prepared) {
  const groups = [];
  for (const entry of prepared) {
    const last = groups[groups.length - 1];
    const canJoin =
      last &&
      !entry.step.sync &&
      !last.sync &&
      last.role === entry.step.role;
    if (canJoin) last.entries.push(entry);
    else groups.push({ role: entry.step.role, sync: Boolean(entry.step.sync), entries: [entry] });
  }
  return groups;
}

/**
 * @param {object} args
 * @param {Array} args.prepared  [{ step, index, document, endpoint }] in journey order
 * @param {string} args.mode     one of DOCUMENT_MODES
 * @returns {Array} planned requests, each carrying the steps it speaks for
 */
function planRequests({ prepared, mode }) {
  if (mode === 'split') {
    return prepared.map((entry, i) => ({
      batchId: `d${i + 1}`,
      role: entry.step.role,
      endpoint: entry.endpoint,
      sync: Boolean(entry.step.sync),
      // Each entry's own document, untouched.
      body: bodyOf(entry),
      contentType: contentTypeOf(entry),
      eventCount: eventCountOf(entry),
      members: [{ step: entry.step, index: entry.index, eventOffset: 0 }],
    }));
  }

  if (mode === 'combined') {
    return groupContiguous(prepared).map((group, i) => {
      const isXml = group.entries[0].xml !== undefined;
      let eventOffset = 0;
      const members = group.entries.map((entry) => {
        const member = { step: entry.step, index: entry.index, eventOffset };
        eventOffset += eventCountOf(entry);
        return member;
      });
      return {
        batchId: `b${i + 1}`,
        role: group.role,
        endpoint: group.entries[0].endpoint,
        sync: group.sync,
        body: isXml
          ? mergeXmlDocuments(group.entries.map((e) => e.xml))
          : JSON.stringify(mergeDocuments(group.entries.map((e) => e.document))),
        contentType: contentTypeOf(group.entries[0]),
        eventCount: eventOffset,
        members,
      };
    });
  }

  throw new Error(`planRequests does not handle mode "${mode}"`);
}

function digits(n) {
  let out = '';
  for (let i = 0; i < n; i += 1) out += Math.floor(Math.random() * 10);
  return out;
}

// The oversize probe is not a journey - it is two deliberate breaches of the documented
// ceilings, mapped onto the two workbook rows that describe them and have never been run:
// API-MFG-COMM-EDGE-008 (50,000 serials) and API-MFG-COMM-EDGE-009 (10 MB).
function planOversizeProbe({ baseUrl, roleEndpoints }) {
  const endpoint = `${baseUrl}${roleEndpoints.manufacturer}`;
  const commissioning = (epcList, lot) => ({
    type: 'ObjectEvent',
    eventID: `urn:uuid:${crypto.randomUUID()}`,
    eventTime: new Date(Date.now() - 60_000).toISOString(),
    eventTimeZoneOffset: '+03:00',
    epcList,
    action: 'ADD',
    bizStep: 'commissioning',
    disposition: 'active',
    readPoint: { id: 'urn:epc:id:sgln:0614141.00001.0' },
    bizLocation: { id: 'urn:epc:id:sgln:0614141.00001.0' },
    ilmd: { 'cbvmda:lotNumber': lot },
  });

  // One serial past the documented ceiling - enough to trip the rule, small enough that the
  // size limit is not what rejects it.
  const overSerials = new Array(SERIAL_LIMIT + 1);
  for (let i = 0; i < overSerials.length; i += 1) {
    overSerials[i] = `urn:epc:id:sgtin:0614141.000111.${String(i).padStart(9, '0')}`;
  }
  const serialsDoc = newDocument();
  serialsDoc.epcisBody.eventList.push(commissioning(overSerials, `BATCH-LIMIT-${digits(4)}`));

  // Padded past 10 MB while staying under the serial ceiling, so the size rule is the only
  // one in play. The padding rides in the lot number, which is free-form text.
  const sizeDoc = newDocument();
  const padSerials = new Array(1000);
  for (let i = 0; i < padSerials.length; i += 1) {
    padSerials[i] = `urn:epc:id:sgtin:0614141.000111.${String(i).padStart(9, '0')}`;
  }
  const event = commissioning(padSerials, `BATCH-LIMIT-${digits(4)}`);
  event.ilmd['cbvmda:lotNumber'] = `BATCH-LIMIT-${'X'.repeat(ASYNC_SIZE_LIMIT + 512 * 1024)}`;
  sizeDoc.epcisBody.eventList.push(event);

  return [
    {
      batchId: 'limit-serials',
      role: 'manufacturer',
      endpoint,
      sync: false,
      body: JSON.stringify(serialsDoc),
      eventCount: 1,
      members: [
        {
          step: {
            key: 'limit-serials',
            role: 'manufacturer',
            phase: 'limits',
            label: `Over ${SERIAL_LIMIT.toLocaleString()} serials`,
            testId: 'API-MFG-COMM-EDGE-008',
            path: ['Limits probe', 'Serial ceiling'],
          },
          index: 0,
          eventOffset: 0,
        },
      ],
      // A breach is supposed to be refused, so a 4xx is the pass condition here.
      expectRejection: true,
    },
    {
      batchId: 'limit-size',
      role: 'manufacturer',
      endpoint,
      sync: false,
      body: JSON.stringify(sizeDoc),
      eventCount: 1,
      members: [
        {
          step: {
            key: 'limit-size',
            role: 'manufacturer',
            phase: 'limits',
            label: 'Over 10 MB payload',
            testId: 'API-MFG-COMM-EDGE-009',
            path: ['Limits probe', 'Message size'],
          },
          index: 1,
          eventOffset: 0,
        },
      ],
      expectRejection: true,
    },
  ];
}

module.exports = {
  DOCUMENT_MODES,
  SERIAL_LIMIT,
  ASYNC_SIZE_LIMIT,
  planRequests,
  planOversizeProbe,
  groupContiguous,
  mergeDocuments,
};
