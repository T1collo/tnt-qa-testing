// DATA INTEGRITY — Manufacturer Commission (ObjectEvent), JSON-LD
//
// Scope note: this checks integrity at the synchronous ACKNOWLEDGMENT layer only
// (the partner API host root). It does NOT confirm the event was
// actually persisted/queryable afterward - the partner API is POST-only with no read
// endpoint, and cross-checking against the separate admin Events Explorer UI (tnt-demo) is
// explicitly out of scope for this test suite. What this DOES catch: an event being
// acknowledged with the wrong ID, a dropped ID (event_ids missing what was submitted), or
// the same ID being handed back for more than one request (a collision/caching bug) - all
// under concurrent pressure, since processing_mode is ASYNC and a naive implementation could
// plausibly cross wires between concurrent requests.
//
// Run:
//   k6 run -e MANUFACTURER_API_TOKEN=xxx k6/data-integrity-manufacturer-commission.js
//
// Then check for cross-request duplicate/missing IDs:
//   k6 run ... > k6/data-integrity-run.log 2>&1
//   node k6/check-data-integrity-log.js k6/data-integrity-run.log
//
// Useful overrides:
//   -e BASE_URL=https://tnt-demo.apeiro-digital.com
//   -e TOTAL_REQUESTS=300   # total commission events to send
//   -e VUS=30               # concurrent VUs sharing that total (concurrency pressure)

import http from 'k6/http';
import { check } from 'k6';
import { newRunId, commissionPayload, authHeaders } from './lib/epcis.js';

const BASE_URL = (__ENV.BASE_URL || 'https://tnt-demo.apeiro-digital.com').replace(/\/+$/, '');
const API_TOKEN = __ENV.MANUFACTURER_API_TOKEN;
if (!API_TOKEN) {
  throw new Error('MANUFACTURER_API_TOKEN is required, e.g. -e MANUFACTURER_API_TOKEN=xxx');
}

const TOTAL_REQUESTS = Number(__ENV.TOTAL_REQUESTS || 300);
const VUS = Number(__ENV.VUS || 30);

const RUN_ID = newRunId();

export const options = {
  scenarios: {
    integrity_burst: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: TOTAL_REQUESTS,
      maxDuration: '5m',
    },
  },
  thresholds: {
    // Every single response must ack exactly the one ID that specific request submitted -
    // no exceptions, this is a correctness check, not a performance one.
    'checks{check:ack matches submitted eventID exactly}': ['rate==1'],
  },
};

export default function () {
  const eventID = `urn:uuid:loadtest-${RUN_ID}-${__VU}-${__ITER}`;
  const payload = commissionPayload(RUN_ID, __VU, __ITER);
  // commissionPayload builds its own eventID internally using the same RUN_ID/VU/ITER
  // scheme, so re-derive it identically here rather than re-parsing the JSON string back out.

  const res = http.post(`${BASE_URL}/api/integration/manufacturer/events`, payload, {
    headers: authHeaders(API_TOKEN),
    tags: { name: 'commission' },
  });

  let ackIds = [];
  let parsedOk = false;
  try {
    const body = JSON.parse(res.body);
    if (body.success === true && Array.isArray(body.event_ids)) {
      ackIds = body.event_ids;
      parsedOk = true;
    }
  } catch {
    parsedOk = false;
  }

  check(res, {
    'request succeeded (201/202)': (r) => r.status === 201 || r.status === 202,
    'response body parsed with success:true': () => parsedOk,
    'ack matches submitted eventID exactly': () => ackIds.length === 1 && ackIds[0] === eventID,
  });

  // Structured line for the post-run cross-request uniqueness check (see
  // check-data-integrity-log.js) - stdout is process-wide even though each VU runs in its
  // own isolated JS runtime, so this is the simplest way to get per-request data out of k6.
  console.log(
    `INTEGRITY submitted=${eventID} status=${res.status} acked=${ackIds.join('|') || 'NONE'}`
  );
}
