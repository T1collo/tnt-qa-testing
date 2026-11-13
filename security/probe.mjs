// High-level security probe for the TnT Partner EPCIS API.
//
// Works against either environment:
//   node security/probe.mjs                  # default target (tnt-demo)
//   node security/probe.mjs --target=trackiq
//
// Write-light: the only records it creates are events under its own throwaway
// identifier range, so it can be re-run against a demo environment without
// colliding with, or mutating, anyone else's data.
//
// Out: security/results/probe-<target>-<ts>.json + a console summary
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// Minimal .env reader - avoids pulling dotenv into an ESM script in a CJS package.
// First definition wins, matching dotenv, so a duplicated key is not silently
// overwritten by a later one.
const env = { ...process.env };
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch {
  // .env is optional - tokens may come from the real environment instead.
}

// Both environments serve the API from the HOST ROOT. On tnt-demo, "/new" proxies to a
// separate backend with its own key store; on trackiq, "/new" 301-redirects to the root.
const PROFILES = {
  'tnt-demo': {
    base: 'https://tnt-demo.apeiro-digital.com',
    tokens: {
      manufacturer: env.MANUFACTURER_API_TOKEN,
      distributor: env.DISTRIBUTOR_API_TOKEN,
      facility: env.FACILITY_API_TOKEN,
    },
    // A path on this host that is served by a different backend environment.
    foreignEnvPath: '/new',
  },
  trackiq: {
    base: (env.TRACKIQ_BASE_URL || 'https://trackiq.apeiro-digital.com').replace(/\/+$/, ''),
    tokens: {
      manufacturer: env.TRACKIQ_MANUFACTURER_API_TOKEN,
      distributor: env.TRACKIQ_DISTRIBUTOR_API_TOKEN,
      facility: env.TRACKIQ_FACILITY_API_TOKEN,
    },
    foreignEnvPath: null,
  },
};

const targetArg = (process.argv.find((a) => a.startsWith('--target=')) || '').split('=')[1];
const TARGET = targetArg || 'tnt-demo';
const profile = PROFILES[TARGET];
if (!profile) {
  console.error(`Unknown target "${TARGET}". Known: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}
const BASE = profile.base.replace(/\/+$/, '');
const TOKENS = profile.tokens;
const ENDPOINT = { manufacturer: 'manufacturer', distributor: 'supplier', facility: 'facility' };

// A token from the *other* environment, for the cross-environment isolation check.
const FOREIGN_TOKEN = Object.values(PROFILES[TARGET === 'trackiq' ? 'tnt-demo' : 'trackiq'].tokens)
  .find(Boolean);

const ROLES_WITH_TOKENS = Object.keys(TOKENS).filter((r) => TOKENS[r]);
if (!ROLES_WITH_TOKENS.length) {
  console.error(`No API tokens configured for target "${TARGET}".`);
  process.exit(1);
}
// Input-validation and data-protection checks run against one role. Prefer manufacturer
// (the commissioning entry point); otherwise use whichever role has a key.
const PRIMARY = ROLES_WITH_TOKENS.includes('manufacturer') ? 'manufacturer' : ROLES_WITH_TOKENS[0];

const results = [];
function record(id, category, title, expected, actual, pass, severity, evidence) {
  results.push({
    id, category, title, expected, actual,
    status: pass ? 'PASS' : 'FAIL',
    severity: pass ? '-' : severity,
    evidence,
  });
  console.log(`${(pass ? 'PASS' : 'FAIL').padEnd(4)} ${id.padEnd(22)} ${title}`);
  if (!pass) console.log(`     expected: ${expected}\n     actual:   ${actual}\n     evidence: ${evidence}`);
}
function skip(id, title, why) {
  results.push({ id, category: 'skipped', title, expected: '', actual: '', status: 'SKIPPED', severity: '-', evidence: why });
  console.log(`SKIP ${id.padEnd(22)} ${title}\n     ${why}`);
}

const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const short = (s, n = 200) => String(s).replace(/\s+/g, ' ').slice(0, n);

function commission({ lot = 'SECPROBE', epc = null, extra = {} } = {}) {
  const now = new Date().toISOString();
  const s = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-15);
  return {
    '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
    type: 'EPCISDocument', schemaVersion: '2.0', creationDate: now,
    epcisBody: { eventList: [{
      type: 'ObjectEvent', eventID: `urn:uuid:sec-${uniq()}`, eventTime: now,
      eventTimeZoneOffset: '+03:00',
      epcList: [epc || `urn:epc:id:sgtin:0123456.305512.${s}`],
      action: 'ADD', bizStep: 'commissioning', disposition: 'active',
      readPoint: { id: 'urn:epc:id:sgln:0123456.22222.0' },
      bizLocation: { id: 'urn:epc:id:sgln:0123456.22222.0' },
      ilmd: { 'cbvmda:lotNumber': lot, 'cbvmda:itemExpirationDate': '2028-01-01' },
      ...extra,
    }] },
  };
}

// Receiving docs for the distributor/facility endpoints. The SSCC serial is randomised
// per call because the API deduplicates on content hash (EPC+bizStep+disposition+
// readPoint) as well as on eventID - a fixed SSCC would 409 on the second call and the
// result would say nothing about the control under test.
function receive(kind, { lot = 'SECPROBE', epc = null, extra = {} } = {}) {
  const now = new Date().toISOString();
  const prefix = kind === 'distributor' ? '0614141' : '0619999';
  const serial = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
  const loc = kind === 'distributor' ? '0619999.00002.0' : '0618888.00001.0';
  return {
    '@context': ['https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld'],
    type: 'EPCISDocument', schemaVersion: '2.0', creationDate: now,
    epcisBody: { eventList: [{
      type: 'ObjectEvent', eventID: `urn:uuid:sec-${uniq()}`, eventTime: now,
      eventTimeZoneOffset: '+00:00', action: 'OBSERVE', bizStep: 'receiving',
      disposition: 'active',
      epcList: [epc || `urn:epc:id:sscc:${prefix}.${serial}`],
      readPoint: { id: `urn:epc:id:sgln:${loc}` },
      bizLocation: { id: `urn:epc:id:sgln:${loc}` },
      ilmd: { 'cbvmda:lotNumber': lot },
      ...extra,
    }] },
  };
}

const bodyFor = {
  manufacturer: (o) => commission(o),
  distributor: (o) => receive('distributor', o),
  facility: (o) => receive('facility', o),
};
// The body shape the input-validation checks use, matched to the primary role.
const primaryBody = (o) => bodyFor[PRIMARY](o);

async function post(role, body, { token = TOKENS[role], headers = {}, raw = null } = {}) {
  const url = `${BASE}/api/integration/${ENDPOINT[role]}/events`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
        ...(token ? { 'X-API-Key': token } : {}),
        ...headers,
      },
      body: raw !== null ? raw : JSON.stringify(body),
    });
    return { status: res.status, body: await res.text(), headers: res.headers, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: String(e), headers: new Headers(), ms: Date.now() - t0 };
  }
}

console.log(`\nTnT Partner API - security probe`);
console.log(`Target:  ${TARGET}  (${BASE})`);
console.log(`Roles:   ${ROLES_WITH_TOKENS.join(', ')}${ROLES_WITH_TOKENS.length < 3 ? '   [missing: ' + Object.keys(TOKENS).filter((r) => !TOKENS[r]).join(', ') + ']' : ''}`);
console.log(`Primary: ${PRIMARY}\n${'-'.repeat(72)}`);

// ------------------------------------------------------------- AUTHENTICATION
console.log('\n[ Authentication ]');
{
  const r = await post(PRIMARY, primaryBody(), { token: null });
  record('TNT-SEC-AUTH-001', 'Authentication', 'Unauthenticated event submission is rejected',
    '401', String(r.status), r.status === 401, 'Critical', short(r.body));
}
{
  const r = await post(PRIMARY, primaryBody(), { token: 'not-a-real-token' });
  record('TNT-SEC-AUTH-002', 'Authentication', 'Malformed API key is rejected',
    '401', String(r.status), r.status === 401, 'Critical', short(r.body));
}

// The JWT-specific forgery checks only mean something if the environment issues JWTs.
// trackiq uses opaque trk_test_* keys, where there is no client-side signature to forge.
const primaryToken = TOKENS[PRIMARY];
const isJwt = /^[\w-]+\.[\w-]+\.[\w-]*$/.test(primaryToken);
if (isJwt) {
  {
    const payload = primaryToken.split('.')[1];
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const r = await post(PRIMARY, primaryBody(), { token: `${noneHeader}.${payload}.` });
    record('TNT-SEC-AUTH-003', 'Authentication', 'JWT "alg: none" downgrade is rejected',
      '401', String(r.status), r.status === 401, 'Critical', short(r.body));
  }
  {
    const [h, p] = primaryToken.split('.');
    const otherSig = (Object.values(TOKENS).find((t) => t && t !== primaryToken) || primaryToken).split('.')[2];
    const r = await post(PRIMARY, primaryBody(), { token: `${h}.${p}.${otherSig}` });
    record('TNT-SEC-AUTH-004', 'Authentication', 'Token with a mismatched signature is rejected',
      '401', String(r.status), r.status === 401, 'Critical', short(r.body));
  }
  {
    const [h, , s] = primaryToken.split('.');
    const otherPayload = (Object.values(TOKENS).find((t) => t && t !== primaryToken) || primaryToken).split('.')[1];
    const r = await post(PRIMARY, primaryBody(), { token: `${h}.${otherPayload}.${s}` });
    record('TNT-SEC-AUTH-006', 'Authentication', 'Tampered token payload (swapped partner id) is rejected',
      '401', String(r.status), r.status === 401, 'Critical', short(r.body));
  }
} else {
  for (const [id, title] of [
    ['TNT-SEC-AUTH-003', 'JWT "alg: none" downgrade is rejected'],
    ['TNT-SEC-AUTH-004', 'Token with a mismatched signature is rejected'],
    ['TNT-SEC-AUTH-006', 'Tampered token payload (swapped partner id) is rejected'],
  ]) skip(id, title, 'not applicable - this environment issues opaque keys, not JWTs (no client-side signature to forge)');
  // Opaque keys have their own weakness: guessability. Check the format is unguessable
  // and that a near-miss of a real key is refused.
  const mutated = primaryToken.slice(0, -1) + (primaryToken.slice(-1) === 'a' ? 'b' : 'a');
  const r = await post(PRIMARY, primaryBody(), { token: mutated });
  record('TNT-SEC-AUTH-011', 'Authentication', 'Key differing by one character is rejected (no prefix matching)',
    '401', String(r.status), r.status === 401, 'Critical', short(r.body));
}
{
  if (FOREIGN_TOKEN) {
    const r = await post(PRIMARY, primaryBody(), { token: FOREIGN_TOKEN });
    record('TNT-SEC-AUTH-005', 'Authentication', "Token from the other TnT environment is rejected",
      '401', String(r.status), r.status === 401, 'High', short(r.body));
  } else {
    skip('TNT-SEC-AUTH-005', 'Token from the other TnT environment is rejected', 'no token available for the other environment');
  }
}
{
  if (profile.foreignEnvPath) {
    const res = await fetch(`${BASE}${profile.foreignEnvPath}/api/integration/${ENDPOINT[PRIMARY]}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json', 'X-API-Key': primaryToken },
      body: JSON.stringify(primaryBody()),
    });
    const body = await res.text();
    record('TNT-SEC-AUTH-012', 'Authentication', `This env's token is rejected on the ${profile.foreignEnvPath} backend`,
      '401', String(res.status), res.status === 401, 'High', short(body));
  } else {
    skip('TNT-SEC-AUTH-012', 'Cross-backend path isolation', `no separate backend path on ${TARGET}`);
  }
}

// -------------------------------------------------------------- AUTHORIZATION
console.log('\n[ Authorization - cross-role matrix ]');
// Every available partner key is tried against every partner endpoint. Only the diagonal
// should be accepted; anything off-diagonal is a privilege-escalation path, which in a
// track-and-trace system means one supply-chain tier can forge another tier's custody
// events. A 400 (schema rejected) means auth and authz both passed - the key owns the route.
const matrix = {};
let idx = 1;
for (const holder of ROLES_WITH_TOKENS) {
  matrix[holder] = {};
  for (const target of Object.keys(ENDPOINT)) {
    const r = await post(target, bodyFor[target](), { token: TOKENS[holder] });
    matrix[holder][target] = r.status;
    const id = `TNT-SEC-AUTHZ-${String(idx).padStart(3, '0')}`;
    if (holder === target) {
      const ok = [200, 201, 202, 400, 409].includes(r.status);
      record(id, 'Authorization', `${holder} key is accepted on its own endpoint`,
        '2xx (or 400/409 - past authz)', String(r.status), ok, 'High', short(r.body));
    } else {
      record(id, 'Authorization', `${holder} key CANNOT post to the ${target} endpoint`,
        '401/403', String(r.status), r.status === 401 || r.status === 403, 'Critical', short(r.body));
    }
    idx++;
  }
}

// --------------------------------------------------- INPUT VALIDATION / INJECTION
console.log('\n[ Input validation & injection ]');
const STACK_RE = /node_modules|\.js:\d+|\bat\s+[A-Za-z$_][\w.$]*\s*\(|SyntaxError.*position/i;
{
  const r = await post(PRIMARY, null, { raw: '{"type":"EPCISDocument", BROKEN' });
  const leaks = STACK_RE.test(r.body);
  record('TNT-SEC-INP-001', 'Input', 'Malformed JSON returns 4xx without an internal stack trace',
    '4xx, no stack trace', `${r.status}${leaks ? ' + internal detail leaked' : ''}`,
    r.status >= 400 && r.status < 500 && !leaks, 'Medium', short(r.body));
}
{
  const r = await post(PRIMARY, { type: 'EPCISDocument' });
  record('TNT-SEC-INP-002', 'Input', 'EPCIS document with no epcisBody is rejected',
    '400/422', String(r.status), r.status >= 400 && r.status < 500, 'Medium', short(r.body));
}
{
  const r = await post(PRIMARY, primaryBody({ epc: 'not-an-epc-at-all' }));
  record('TNT-SEC-INP-003', 'Input', 'Structurally invalid EPC identifier is rejected',
    '400/422', String(r.status), r.status >= 400 && r.status < 500, 'High', short(r.body));
}
{
  const r = await post(PRIMARY, primaryBody({ lot: '<script>alert(document.domain)</script>' }));
  const reflected = r.body.includes('<script>');
  record('TNT-SEC-INP-004', 'Input', 'Script payload in lotNumber is not reflected unescaped',
    'rejected, or accepted and escaped', `${r.status}${reflected ? ' + reflected unescaped' : ''}`,
    !reflected, 'High', short(r.body));
}
{
  const r = await post(PRIMARY, primaryBody({ lot: "SECPROBE'; DROP TABLE epcis_events; --" }));
  const dbLeak = /syntax error|SQLSTATE|postgres|psql|sequelize|prisma|ORA-\d|SQLITE_/i.test(r.body);
  record('TNT-SEC-INP-005', 'Input', 'SQL metacharacters in lotNumber surface no database error',
    'no DB error text', `${r.status}${dbLeak ? ' + DB error leaked' : ''}`, !dbLeak, 'Critical', short(r.body));
}
{
  const r = await post(PRIMARY, primaryBody({ lot: 'A'.repeat(100000) }));
  const leaks = STACK_RE.test(r.body);
  record('TNT-SEC-INP-006', 'Input', '100k-character field is handled without a 5xx or stack trace',
    'non-5xx, no stack trace', `${r.status}${leaks ? ' + stack trace' : ''}`,
    r.status !== 0 && r.status < 500 && !leaks, 'Medium', short(r.body));
}
{
  const r = await post(PRIMARY, primaryBody({
    extra: { partnerId: 'someone-else', tenantId: 'other-tenant', isVerified: true, role: 'admin' },
  }));
  record('TNT-SEC-INP-007', 'Input', 'Unexpected privileged fields do not cause a server error',
    'non-5xx', String(r.status), r.status !== 0 && r.status < 500, 'High', short(r.body));
}
{
  const big = primaryBody();
  const one = big.epcisBody.eventList[0];
  big.epcisBody.eventList = Array.from({ length: 5000 }, (_, i) => ({
    ...one,
    eventID: `urn:uuid:sec-bulk-${uniq()}-${i}`,
    epcList: [PRIMARY === 'manufacturer'
      ? `urn:epc:id:sgtin:0123456.305512.${`${Date.now()}${i}`.slice(-15)}`
      : `urn:epc:id:sscc:0614141.${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`],
  }));
  const r = await post(PRIMARY, big);
  record('TNT-SEC-INP-008', 'Input', '5,000-event batch is bounded rather than crashing the endpoint',
    'non-5xx', `${r.status} in ${r.ms}ms`, r.status !== 0 && r.status < 500, 'Medium', short(r.body));
}
{
  const r = await post(PRIMARY, primaryBody(), { headers: { 'Content-Type': 'text/plain' } });
  record('TNT-SEC-INP-009', 'Input', 'Wrong Content-Type is handled cleanly',
    'non-5xx', String(r.status), r.status !== 0 && r.status < 500, 'Low', short(r.body));
}
{
  const doc = primaryBody();
  const a = await post(PRIMARY, doc);
  const b = await post(PRIMARY, doc);
  const bothAccepted = a.status < 300 && b.status < 300;
  record('TNT-SEC-INP-010', 'Input', 'Duplicate eventID replay is rejected, not silently re-recorded',
    'second submission rejected or deduped', `first=${a.status} second=${b.status}`,
    !bothAccepted, 'High', `first: ${short(a.body, 100)} || second: ${short(b.body, 100)}`);
}
{
  // Backdating is the direction that matters for a custody ledger: a predated event makes
  // stock of unknown provenance look like it was in legitimate custody all along.
  const past = primaryBody();
  past.epcisBody.eventList[0].eventTime = '1990-01-01T00:00:00.000Z';
  const rp = await post(PRIMARY, past);
  record('TNT-SEC-INTEG-014', 'Integrity', 'Backdated eventTime (1990) is rejected or flagged',
    '400/422', String(rp.status), rp.status >= 400 && rp.status < 500, 'Medium', short(rp.body));

  const future = primaryBody();
  future.epcisBody.eventList[0].eventTime = '2031-01-01T00:00:00.000Z';
  const rf = await post(PRIMARY, future);
  record('TNT-SEC-INTEG-005', 'Integrity', 'Future-dated eventTime is rejected',
    '400/422', String(rf.status), rf.status >= 400 && rf.status < 500, 'Medium', short(rf.body));
}

// ------------------------------------------------------ TRANSPORT / DATA PROTECTION
console.log('\n[ Transport & data protection ]');
const WEB_ROUTES = ['/', '/login', '/scanner'];
{
  const missingByRoute = {};
  for (const route of WEB_ROUTES) {
    const res = await fetch(BASE + route, { redirect: 'manual' });
    const h = Object.fromEntries(res.headers);
    missingByRoute[route] = ['strict-transport-security', 'x-frame-options', 'x-content-type-options', 'content-security-policy']
      .filter((k) => !h[k]);
  }
  const anyMissing = Object.values(missingByRoute).some((m) => m.length);
  record('TNT-SEC-DATA-001', 'Data protection', 'Baseline security headers present on all public web routes',
    'HSTS + XFO + nosniff + CSP on every route',
    anyMissing ? Object.entries(missingByRoute).filter(([, m]) => m.length).map(([r, m]) => `${r}: missing ${m.join('/')}`).join(' | ') : 'all present',
    !anyMissing, 'Medium', JSON.stringify(missingByRoute));
}
{
  const r = await post(PRIMARY, primaryBody());
  const h = Object.fromEntries(r.headers);
  record('TNT-SEC-DATA-002', 'Data protection', 'API responses do not disclose framework/version banners',
    'no x-powered-by, no versioned Server', `x-powered-by=${h['x-powered-by'] || 'none'} server=${h.server || 'none'}`,
    !h['x-powered-by'] && !/\d/.test(h.server || ''), 'Low', short(JSON.stringify(h), 300));
  const rl = Object.entries(h).filter(([k]) => /ratelimit/i.test(k));
  if (rl.length) console.log(`     (advertised rate limit: ${rl.map(([k, v]) => `${k}=${v}`).join(' ')})`);
}
{
  const url = `${BASE}/api/integration/${ENDPOINT[PRIMARY]}/events?api_key=${encodeURIComponent(primaryToken)}`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/ld+json' }, body: JSON.stringify(primaryBody()),
  });
  record('TNT-SEC-DATA-003', 'Data protection', 'API key supplied in the URL query string is NOT accepted',
    '401', String(res.status), res.status === 401, 'High', short(await res.text()));
}
{
  const res = await fetch(`${BASE}/api/integration/${ENDPOINT[PRIMARY]}/events`, {
    method: 'GET', headers: { 'X-API-Key': primaryToken },
  });
  const body = await res.text();
  const dump = /"epcList"|"eventID"|"epcisBody"/i.test(body);
  record('TNT-SEC-DATA-004', 'Data protection', 'Ingestion endpoint does not serve an event dump over GET',
    '404/405, no event data', `${res.status}${dump ? ' + event data returned' : ''}`,
    !dump, 'High', short(body));
}
{
  const res = await fetch(`${BASE}/api/integration/${ENDPOINT[PRIMARY]}/events`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' },
  });
  const acao = res.headers.get('access-control-allow-origin');
  const acac = res.headers.get('access-control-allow-credentials');
  const bad = acao === 'https://evil.example.com' || (acao === '*' && acac === 'true');
  record('TNT-SEC-DATA-005', 'Data protection', 'CORS does not reflect an arbitrary origin',
    'no ACAO, or an allowlisted one', `ACAO=${acao || 'none'} ACAC=${acac || 'none'}`,
    !bad, 'Medium', `preflight status=${res.status}`);
}
{
  // Plain HTTP: either a redirect to HTTPS, or no listener at all. A 200 over cleartext
  // would be the failure.
  let actual;
  let pass;
  try {
    const res = await fetch(`http://${new URL(BASE).host}/`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const loc = res.headers.get('location') || '';
    actual = `${res.status} -> ${loc || 'no redirect'}`;
    pass = res.status >= 300 && res.status < 400 && loc.startsWith('https://');
  } catch {
    actual = 'no cleartext listener (connection failed)';
    pass = true;
  }
  record('TNT-SEC-DATA-011', 'Data protection', 'Plain HTTP is redirected to HTTPS or not served',
    '301/302 to https, or refused', actual, pass, 'Medium', '');
}

// --------------------------------------------------------------- RATE LIMITING
console.log('\n[ Rate limiting ]');
{
  const N = 60;
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: N }, () => post(PRIMARY, primaryBody())));
  const elapsed = (Date.now() - t0) / 1000;
  const codes = rs.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
  const throttled = (codes['429'] || 0) > 0;
  const broke = Object.keys(codes).some((c) => Number(c) >= 500 || Number(c) === 0);
  record('TNT-SEC-RATE-001', 'Rate limiting', `Burst of ${N} concurrent writes is absorbed or throttled, never 5xx`,
    'no 5xx / no dropped connections', `${JSON.stringify(codes)} in ${elapsed.toFixed(1)}s`,
    !broke, 'High', throttled ? '429 returned - throttling active' : 'no 429 seen at this burst size');
}
{
  const rs = await Promise.all(Array.from({ length: 30 }, () =>
    post(PRIMARY, primaryBody(), { token: 'invalid-token-brute-force' })));
  const codes = rs.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
  const throttled = (codes['429'] || 0) > 0;
  record('TNT-SEC-RATE-002', 'Rate limiting', 'Repeated invalid-key attempts are throttled (credential brute force)',
    'some 429 after repeated failures', JSON.stringify(codes), throttled, 'Medium',
    throttled ? 'backoff observed' : 'every attempt answered without backoff');
}

// --------------------------------------------------------------------- OUTPUT
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(HERE, 'results');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `probe-${TARGET}-${stamp}.json`);
fs.writeFileSync(outFile, JSON.stringify({
  target: TARGET, base: BASE, ranAt: new Date().toISOString(),
  rolesTested: ROLES_WITH_TOKENS, primaryRole: PRIMARY, matrix, results,
}, null, 2));

const failed = results.filter((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'SKIPPED');
console.log(`\n${'-'.repeat(72)}`);
console.log('Cross-role matrix (rows = key holder, cols = endpoint):');
console.log(''.padEnd(15) + Object.keys(ENDPOINT).map((k) => k.padEnd(14)).join(''));
for (const [holder, row] of Object.entries(matrix)) {
  console.log(holder.padEnd(15) + Object.keys(ENDPOINT).map((t) => String(row[t]).padEnd(14)).join(''));
}
console.log(`\n${results.length} checks - ${results.length - failed.length - skipped.length} pass, ${failed.length} fail, ${skipped.length} skipped`);
for (const f of failed) console.log(`  ${f.severity.padEnd(8)} ${f.id}  ${f.title}`);
console.log(`\nwritten: ${path.relative(ROOT, outFile).replace(/\\/g, '/')}`);
