// LOAD TEST - Distributor/Facility Receive (ObjectEvent), JSON-LD
//
// Companion to load-manufacturer-commission.js for the downstream custody events.
// Originally written against trackiq, where no manufacturer key was issued and the
// supplier/facility routes are the only ingestion surface available.
//
// Run:
//   k6 run -e API_TOKEN=$DISTRIBUTOR_API_TOKEN -e ROLE=supplier k6/load-supplier-receive.js
//
// Overrides:
//   -e BASE_URL=https://tnt-demo.apeiro-digital.com   # host root, no trailing slash
//   -e ROLE=supplier|facility                        # which integration route
//   -e TARGET_VUS=10 -e RAMP_UP=20s -e HOLD=60s -e RAMP_DOWN=10s
//   -e P95_MS=800 -e P99_MS=1500

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { newRunId, receivePayload, authHeaders } from './lib/epcis.js';

const BASE_URL = (__ENV.BASE_URL || 'https://tnt-demo.apeiro-digital.com').replace(/\/+$/, '');
const API_TOKEN = __ENV.API_TOKEN;
if (!API_TOKEN) {
  throw new Error('API_TOKEN is required, e.g. -e API_TOKEN=trk_test_xxx');
}
const ROLE = __ENV.ROLE || 'supplier';
const TARGET_VUS = Number(__ENV.TARGET_VUS || 10);
const P95_MS = Number(__ENV.P95_MS || 800);
const P99_MS = Number(__ENV.P99_MS || 1500);

const RUN_ID = newRunId();

const unexpectedStatus = new Rate('unexpected_status');
const receiveDuration = new Trend('receive_duration', true);
const serverError = new Counter('outcome_server_error');
const accepted = new Counter('outcome_accepted');
const duplicate = new Counter('outcome_duplicate');

export const options = {
  stages: [
    { duration: __ENV.RAMP_UP || '20s', target: TARGET_VUS },
    { duration: __ENV.HOLD || '60s', target: TARGET_VUS },
    { duration: __ENV.RAMP_DOWN || '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: [`p(95)<${P95_MS}`, `p(99)<${P99_MS}`],
    unexpected_status: ['rate<0.01'],
  },
};

export default function () {
  const payload = receivePayload(RUN_ID, __VU, __ITER, ROLE === 'facility' ? 'facility' : 'supplier');

  const res = http.post(`${BASE_URL}/api/integration/${ROLE}/events`, payload, {
    headers: authHeaders(API_TOKEN),
    tags: { name: 'receive' },
  });

  receiveDuration.add(res.timings.duration);

  if (res.status >= 500) serverError.add(1);
  else if (res.status === 409) duplicate.add(1);
  else if (res.status === 201 || res.status === 202) accepted.add(1);

  const statusOk = check(res, {
    'status is 201 or 202': (r) => r.status === 201 || r.status === 202,
    'body reports success': (r) => {
      try {
        return JSON.parse(r.body).success === true;
      } catch {
        return false;
      }
    },
  });
  unexpectedStatus.add(!statusOk);
  if (__ENV.DEBUG) {
    console.log(`DEBUG status=${res.status} body=${res.body}`);
  }
}
