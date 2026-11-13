// L5 happy-path regression, driven through the dashboard's own API so every run lands in the
// run history, Dashboard chart, Logs and Connections views.
//
// Happy path = valid, well-formed events for every role; pass = 2xx with no error code.
// Warnings are recorded but do not fail a step - the unregistered-master-data family is known
// noise on this environment.
//
// Manufacturer runs are opt-in via --with-manufacturer: only pass it once gate0.mjs shows the
// key alive. Without it, manufacturer steps are left out rather than sent - a 401 from a dead
// key would otherwise be reported as a platform failure.
//
// Run: node --env-file=.env scripts/regression/happy-path.mjs --dashboard=http://localhost:3010 [--with-manufacturer] [N ...]
import fs from 'node:fs';
import path from 'node:path';

const DASH = (process.argv.find((a) => a.startsWith('--dashboard='))?.slice(12) || 'http://localhost:3010').replace(/\/+$/, '');
const OUT_DIR = path.resolve('reports/regression/2026-09-16/happy-path');
const REGISTERED_GTIN = '18904179702187'; // Amtel 5/80 - product registered in master data
const MANUFACTURER_ALIVE = process.argv.includes('--with-manufacturer');

const tokens = {
  distributor: process.env.DISTRIBUTOR_API_TOKEN,
  facility: process.env.FACILITY_API_TOKEN,
  ...(MANUFACTURER_ALIVE ? { manufacturer: process.env.MANUFACTURER_API_TOKEN } : {}),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(endpoint, body) {
  const res = await fetch(`${DASH}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${endpoint} refused: ${res.status} ${json.error}`);
  return json.runId;
}

async function waitFor(runId, timeoutMs = 15 * 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const run = await fetch(`${DASH}/api/runs/${runId}`).then((r) => r.json());
    if (run.status && run.status !== 'running') return run;
    await sleep(3000);
  }
  throw new Error(`run ${runId} did not finish in time`);
}

const errorCode = (variant) => {
  try {
    const body = JSON.parse(variant.responseBody || '');
    return body.code || null;
  } catch {
    return 'non-JSON';
  }
};

function summarise(label, run) {
  const rows = [];
  for (const r of run.results || []) {
    for (const v of r.variants || []) {
      rows.push({
        label: r.eventType,
        testId: r.testId,
        variant: v.variant,
        status: v.status,
        code: errorCode(v),
        ok: v.ok,
        setup: v.setup ? `${v.setup.label} ${v.setup.status}` : '',
      });
    }
    if (!r.variants?.length) rows.push({ label: r.eventType, testId: r.testId, variant: '-', status: '-', code: r.error, ok: false });
  }
  const passed = rows.filter((x) => x.ok).length;
  console.log(`\n=== ${label}  (${run.id})  ${passed}/${rows.length} passed ===`);
  for (const x of rows) {
    console.log(
      `  ${x.ok ? 'PASS' : 'FAIL'} ${String(x.status).padEnd(4)} ${String(x.variant).padEnd(8)} ${String(x.label).slice(0, 40).padEnd(40)} ${x.code && !x.ok ? x.code : ''} ${x.setup}`
    );
  }
  return { label, runId: run.id, passed, total: rows.length, rows };
}

const manufacturerSuites = MANUFACTURER_ALIVE
  ? [
      { label: 'Manufacturer suite · fresh data', endpoint: '/api/run', body: { role: 'manufacturer', apiToken: tokens.manufacturer, freshData: true } },
      { label: 'Manufacturer suite · registered product', endpoint: '/api/run', body: { role: 'manufacturer', apiToken: tokens.manufacturer, freshData: true, product: REGISTERED_GTIN } },
    ]
  : [];

const plan = [
  ...manufacturerSuites,
  { label: 'Distributor suite · fresh data', endpoint: '/api/run', body: { role: 'distributor', apiToken: tokens.distributor, freshData: true } },
  { label: 'Facility suite · fresh data', endpoint: '/api/run', body: { role: 'facility', apiToken: tokens.facility, freshData: true } },
  { label: 'Distributor suite · registered product', endpoint: '/api/run', body: { role: 'distributor', apiToken: tokens.distributor, freshData: true, product: REGISTERED_GTIN } },
  { label: 'Facility suite · registered product', endpoint: '/api/run', body: { role: 'facility', apiToken: tokens.facility, freshData: true, product: REGISTERED_GTIN } },
  { label: 'Journey · split', endpoint: '/api/e2e', body: { tokens, documentMode: 'split', serialCount: 2 } },
  { label: 'Journey · combined', endpoint: '/api/e2e', body: { tokens, documentMode: 'combined', serialCount: 2 } },
  { label: 'Journey · split · registered product', endpoint: '/api/e2e', body: { tokens, documentMode: 'split', serialCount: 2, product: REGISTERED_GTIN } },
  { label: 'Journey · combined · registered product', endpoint: '/api/e2e', body: { tokens, documentMode: 'combined', serialCount: 2, product: REGISTERED_GTIN } },
];

const only = process.argv.filter((a) => /^\d+$/.test(a)).map(Number);
fs.mkdirSync(OUT_DIR, { recursive: true });
const summaries = [];
for (const [i, step] of plan.entries()) {
  if (only.length && !only.includes(i + 1)) continue;
  try {
    const runId = await start(step.endpoint, step.body);
    const run = await waitFor(runId);
    summaries.push(summarise(step.label, run));
  } catch (err) {
    console.log(`\n=== ${step.label}  ERROR: ${err.message}`);
    summaries.push({ label: step.label, error: err.message });
  }
}
const file = path.join(OUT_DIR, `summary-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(summaries, null, 2));
console.log(`\n-> ${path.relative(process.cwd(), file)}`);
