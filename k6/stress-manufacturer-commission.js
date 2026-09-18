// STRESS TEST — Manufacturer Commission (ObjectEvent), JSON-LD
//
// Ramps well past the load test's proven-healthy volume (10 VUs) to find where the
// commissioning endpoint actually breaks, and - more importantly - HOW it breaks.
//
// The pass/fail signal here is deliberately different from the load test: we do NOT expect
// latency/error-free behavior at extreme volume, and http_req_failed is left unconstrained.
// What we DO care about is whether failures are graceful (429 rate-limited, 503 unavailable)
// or a raw unhandled crash (500 with no useful detail, or a network-level failure) - the
// former is a system behaving as designed under pressure, the latter is a defect. See
// k6/lib/epcis.js for the confirmed-working payload shape this reuses.
//
// Run:
//   k6 run -e MANUFACTURER_API_TOKEN=xxx k6/stress-manufacturer-commission.js
//
// Useful overrides (all optional, sane defaults below):
//   -e BASE_URL=https://tnt-demo.apeiro-digital.com
//   -e STAGE_VUS=25,75,150       # comma-separated VU targets for each ramp step
//   -e STEP_DURATION=30s         # time to ramp into (and hold at) each step
//   -e HOLD=1m                   # hold time at the final (highest) step
//   -e RAMP_DOWN=30s
//   -e DEBUG=1                   # log every non-2xx response's status/body

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { newRunId, commissionPayload, authHeaders } from './lib/epcis.js';

const BASE_URL = (__ENV.BASE_URL || 'https://tnt-demo.apeiro-digital.com').replace(/\/+$/, '');
const API_TOKEN = __ENV.MANUFACTURER_API_TOKEN;
if (!API_TOKEN) {
  throw new Error('MANUFACTURER_API_TOKEN is required, e.g. -e MANUFACTURER_API_TOKEN=xxx');
}

const STAGE_VUS = (__ENV.STAGE_VUS || '25,75,150').split(',').map(Number);
const STEP_DURATION = __ENV.STEP_DURATION || '30s';
const HOLD = __ENV.HOLD || '1m';
const RAMP_DOWN = __ENV.RAMP_DOWN || '30s';

const RUN_ID = newRunId();

const commissionDuration = new Trend('commission_duration', true);
const successCount = new Counter('outcome_success');
const gracefulDegradedCount = new Counter('outcome_graceful_degradation'); // 429 / 503
const crashCount = new Counter('outcome_unhandled_crash'); // any other 5xx, or a malformed 2xx body
const networkErrorCount = new Counter('outcome_network_error'); // request never got a response at all
const otherCount = new Counter('outcome_other_unexpected'); // any other status (4xx validation etc.)

const stages = STAGE_VUS.map((target, i) => ({
  duration: STEP_DURATION,
  target,
})).concat([
  { duration: HOLD, target: STAGE_VUS[STAGE_VUS.length - 1] },
  { duration: RAMP_DOWN, target: 0 },
]);

export const options = {
  stages,
  thresholds: {
    // The one hard requirement of a stress test: it may slow down or start rejecting
    // requests under pressure, but it must not crash. Any unhandled 5xx fails this.
    outcome_unhandled_crash: ['count==0'],
  },
};

export default function () {
  const payload = commissionPayload(RUN_ID, __VU, __ITER);

  const res = http.post(`${BASE_URL}/api/integration/manufacturer/events`, payload, {
    headers: authHeaders(API_TOKEN),
    tags: { name: 'commission' },
  });

  commissionDuration.add(res.timings.duration);

  if (res.status === 0) {
    networkErrorCount.add(1);
  } else if (res.status === 201 || res.status === 202) {
    let bodyOk = false;
    try {
      bodyOk = JSON.parse(res.body).success === true;
    } catch {
      bodyOk = false;
    }
    if (bodyOk) {
      successCount.add(1);
    } else {
      // Got an "accepted" status but a body that doesn't match the confirmed shape -
      // treat as a crash-adjacent anomaly, not a clean success.
      crashCount.add(1);
    }
  } else if (res.status === 429 || res.status === 503) {
    gracefulDegradedCount.add(1);
  } else if (res.status >= 500) {
    crashCount.add(1);
  } else {
    otherCount.add(1);
  }

  check(res, { 'did not crash (no unhandled 5xx)': (r) => r.status < 500 || r.status === 503 });

  if (__ENV.DEBUG && res.status !== 201 && res.status !== 202) {
    console.log(`DEBUG status=${res.status} body=${res.body}`);
  }
}
