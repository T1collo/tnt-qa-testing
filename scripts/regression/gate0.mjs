// Gate 0 for an L5 regression pass: is the environment reachable, how far is its clock from
// ours, and is each partner token still alive? Nothing is stored - an empty body is rejected
// by schema validation, which is exactly what separates a live key (400) from a dead one (401).
//
// Run: node --env-file=.env scripts/regression/gate0.mjs
const BASE = (process.env.API_BASE_URL || 'https://tnt-demo.apeiro-digital.com').replace(/\/+$/, '');

const ROLES = [
  { role: 'manufacturer', token: process.env.MANUFACTURER_API_TOKEN, route: '/api/integration/manufacturer/events' },
  { role: 'distributor', token: process.env.DISTRIBUTOR_API_TOKEN, route: '/api/integration/supplier/events' },
  { role: 'facility', token: process.env.FACILITY_API_TOKEN, route: '/api/integration/facility/events' },
];

let blocked = false;

const t0 = Date.now();
try {
  const res = await fetch(BASE, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
  const serverDate = res.headers.get('date');
  const skewMs = serverDate ? Date.parse(serverDate) - Date.now() : null;
  console.log(`reachable   ${BASE}  HTTP ${res.status} in ${Date.now() - t0}ms`);
  // The Date header only has 1-second resolution, so treat this as a coarse reading.
  console.log(`clock skew  ${skewMs === null ? 'unknown' : `${(skewMs / 1000).toFixed(1)}s (server minus local)`}`);
} catch (err) {
  console.log(`UNREACHABLE ${BASE} - ${err.message}`);
  blocked = true;
}

for (const { role, token, route } of ROLES) {
  if (!token) {
    console.log(`token ${role.padEnd(12)} MISSING from .env`);
    blocked = true;
    continue;
  }
  const res = await fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ld+json', 'X-API-Key': token },
    body: '{}',
  });
  const text = await res.text();
  let code = '';
  try { code = JSON.parse(text).code || JSON.parse(text).message || ''; } catch { /* non-JSON */ }
  // 400 = key accepted, body rejected (alive). 401 = key refused. Anything else is noted.
  const verdict = res.status === 400 ? 'ALIVE' : res.status === 401 ? 'DEAD' : 'UNEXPECTED';
  if (verdict !== 'ALIVE') blocked = true;
  console.log(`token ${role.padEnd(12)} ${verdict.padEnd(10)} HTTP ${res.status} ${String(code).slice(0, 70)}`);
}

console.log(blocked ? '\nGATE 0: BLOCKED' : '\nGATE 0: PASS');
process.exit(blocked ? 1 : 0);
