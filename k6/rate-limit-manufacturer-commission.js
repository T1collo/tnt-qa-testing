// RATE-LIMIT VERIFICATION — Manufacturer Commission (ObjectEvent), JSON-LD
//
// Per the QA workbook (API-VAL-016): manufacturer tier budget is documented as 5,000-10,000
// req/min (83-166 req/s). This sustains a fixed arrival rate - not VU-ramping like the stress
// test - because rate limits are about requests/time, not concurrency, and
// constant-arrival-rate is k6's executor for exactly that.
//
// Caveat worth knowing before reading results: the stress test already found this endpoint's
// completed throughput plateaus around ~35-40 req/s well below the documented tier floor, with
// requests queuing into multi-second latency past that point. So a "clean 429" may not be what
// we see - we may instead see the same queuing/timeout behavior stress testing found, before
// ever reaching the request VOLUME needed to trip a per-minute counter. Both outcomes are
// meaningful: a clean 429 means rate limiting works as documented; queuing/crashes without a
// 429 would suggest the budget isn't actually enforced before the system falls over instead.
//
// Run:
//   k6 run -e MANUFACTURER_API_TOKEN=xxx k6/rate-limit-manufacturer-commission.js
//
// Useful overrides:
//   -e BASE_URL=https://tnt-demo.apeiro-digital.com
//   -e TARGET_RPS=150      # requests/sec to sustain (150 rps = 9,000/min, inside the documented band)
//   -e DURATION=90s        # how long to sustain it
//   -e MAX_VUS=300         # ceiling on VUs k6 can spin up to sustain the rate if responses are slow
//   -e DEBUG=1             # log every non-2xx response's status/body

import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { newRunId, commissionPayload, authHeaders } from './lib/epcis.js';

const BASE_URL = (__ENV.BASE_URL || 'https://tnt-demo.apeiro-digital.com').replace(/\/+$/, '');
const API_TOKEN = __ENV.MANUFACTURER_API_TOKEN;
if (!API_TOKEN) {
  throw new Error('MANUFACTURER_API_TOKEN is required, e.g. -e MANUFACTURER_API_TOKEN=xxx');
}

const TARGET_RPS = Number(__ENV.TARGET_RPS || 150);
const DURATION = __ENV.DURATION || '90s';
const MAX_VUS = Number(__ENV.MAX_VUS || 300);

const RUN_ID = newRunId();

const commissionDuration = new Trend('commission_duration', true);
const successCount = new Counter('outcome_success');
const rateLimitedCount = new Counter('outcome_rate_limited'); // 429
const crashCount = new Counter('outcome_unhandled_crash'); // 5xx other than 429/503
const networkErrorCount = new Counter('outcome_network_error');
const otherCount = new Counter('outcome_other_unexpected');

export const options = {
  scenarios: {
    sustained_rate: {
      executor: 'constant-arrival-rate',
      rate: TARGET_RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.min(50, MAX_VUS),
      maxVUs: MAX_VUS,
    },
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
  } else if (res.status === 429) {
    rateLimitedCount.add(1);
  } else if (res.status === 201 || res.status === 202) {
    successCount.add(1);
  } else if (res.status >= 500) {
    crashCount.add(1);
  } else {
    otherCount.add(1);
  }

  if (__ENV.DEBUG && res.status !== 201 && res.status !== 202) {
    console.log(`DEBUG status=${res.status} body=${res.body}`);
  }
}
