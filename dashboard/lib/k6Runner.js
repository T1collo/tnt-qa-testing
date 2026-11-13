// Starts the k6 load tests (k6/*.js in the repo root) from the dashboard and streams their
// output. Shaped like playwrightRunner: one run at a time, a process-wide registry, results
// mirrored into runStore so the run shows up in history, Logs and Audit like any other.
//
// k6 reports nothing per request worth listing, so a run's results are built once it ends,
// from the --summary-export JSON: one row per threshold the script declares, plus the checks
// that need the whole run's output (rate-limit tier, cross-request ID uniqueness) and one
// row of measured throughput/latency for the record.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PROJECT_ROOT } = require('./paths');
const audit = require('./auditDb');
const { createRun, restartRun, finishRun, setResults, documentsDir } = require('./runStore');

const K6_DIR = path.join(PROJECT_ROOT, 'k6');
const MAX_LOG_LINES = 400;
// k6 exits 99 when a threshold is crossed - the run itself completed.
const THRESHOLDS_FAILED = 99;

const registry =
  globalThis.__tntK6Runs ||
  (globalThis.__tntK6Runs = { runs: new Map(), bus: new EventEmitter(), activeId: null });
registry.bus.setMaxListeners(50);

// Dashboard role names -> the integration route (and k6 ROLE) each one uses.
const ROUTE_FOR_ROLE = { manufacturer: 'manufacturer', distributor: 'supplier', facility: 'facility' };
const TOKEN_ENV = { manufacturer: 'MANUFACTURER_API_TOKEN', distributor: 'DISTRIBUTOR_API_TOKEN', facility: 'FACILITY_API_TOKEN' };

// Each test the form offers. `fields` are the only knobs a request can turn; each is clamped
// to its range here, so nothing from the request reaches k6 except these numbers.
const TESTS = {
  load: {
    label: 'Load',
    detail: 'Ramps to a steady number of virtual users and holds it. Fails on p95/p99 latency or more than 1% errors.',
    file: (role) => (role === 'manufacturer' ? 'load-manufacturer-commission.js' : 'load-supplier-receive.js'),
    testId: (role) => ({ manufacturer: 'TNT-PERF-017', distributor: 'TNT-PERF-010', facility: 'TNT-PERF-011' })[role],
    fields: [
      { key: 'vus', label: 'Virtual users', min: 1, max: 100, default: 10 },
      { key: 'holdSec', label: 'Hold (seconds)', min: 10, max: 600, default: 60 },
    ],
    env: (f) => ({ TARGET_VUS: f.vus, HOLD: `${f.holdSec}s` }),
    seconds: (f, role) => f.holdSec + (role === 'manufacturer' ? 60 : 30), // ramp up + down per script
  },
  stress: {
    label: 'Stress',
    detail: 'Steps up through three loads to the peak. Slowing down or answering 429/503 is allowed; any other 5xx fails it.',
    file: () => 'stress-manufacturer-commission.js',
    testId: () => 'TNT-PERF-018',
    fields: [
      { key: 'peakVus', label: 'Peak virtual users', min: 3, max: 300, default: 150 },
      { key: 'holdSec', label: 'Hold at peak (seconds)', min: 10, max: 600, default: 60 },
    ],
    env: (f) => ({
      STAGE_VUS: [Math.ceil(f.peakVus / 6), Math.ceil(f.peakVus / 2), f.peakVus].join(','),
      HOLD: `${f.holdSec}s`,
    }),
    seconds: (f) => f.holdSec + 3 * 30 + 30,
  },
  'rate-limit': {
    label: 'Rate limit',
    detail: 'Sends a fixed number of requests per second. Over the role’s tier it expects 429s; at any rate it must not crash.',
    file: () => 'rate-limit-manufacturer-commission.js',
    testId: () => 'TNT-PERF-022',
    fields: [
      { key: 'rps', label: 'Requests per second', min: 1, max: 300, default: 25 },
      { key: 'durationSec', label: 'Duration (seconds)', min: 10, max: 600, default: 90 },
    ],
    env: (f) => ({ TARGET_RPS: f.rps, DURATION: `${f.durationSec}s` }),
    seconds: (f) => f.durationSec,
  },
  integrity: {
    label: 'Data integrity',
    detail: 'Fires a fixed number of events concurrently and checks every response acknowledges exactly the ID it sent.',
    file: () => 'data-integrity-manufacturer-commission.js',
    testId: () => 'K6-INTEGRITY',
    fields: [
      { key: 'requests', label: 'Total requests', min: 10, max: 2000, default: 300 },
      { key: 'vus', label: 'Virtual users', min: 1, max: 100, default: 30 },
    ],
    env: (f) => ({ TOTAL_REQUESTS: f.requests, VUS: f.vus }),
    seconds: () => null,
  },
};

function k6Binary() {
  return process.env.K6_BIN || 'k6';
}

// The catalogue the Run page renders, and whether k6 can be started at all.
function listTests() {
  return new Promise((resolve) => {
    const tests = Object.entries(TESTS).map(([id, t]) => ({
      id,
      label: t.label,
      detail: t.detail,
      fields: t.fields,
    }));
    const child = spawn(k6Binary(), ['version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () =>
      resolve({ tests, k6: null, error: 'k6 is not installed or not on PATH (set K6_BIN to its full path).' })
    );
    child.on('close', (code) =>
      resolve(code === 0 ? { tests, k6: out.trim().split(/\s+/).slice(0, 2).join(' ') } : { tests, k6: null, error: 'k6 version check failed.' })
    );
  });
}

function clampFields(test, input) {
  const values = {};
  for (const f of test.fields) {
    const n = Math.round(Number(input?.[f.key]));
    values[f.key] = Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.default;
  }
  return values;
}

function publish(run, event) {
  if (event.type === 'result') {
    run.results.push(event.result);
    audit.recordResult(run.id, event.result);
  }
  if (event.type === 'log') {
    run.logs.push(event.line);
    if (run.logs.length > MAX_LOG_LINES) run.logs.shift();
    audit.recordLog(run.id, 'output', event.line);
  }
  registry.bus.emit(run.id, event);
}

// `tests`: one or more { test, fields }, run one after another in catalogue order under a
// single run - never at once, which would skew each test's latency and rate-limit numbers.
// `rerunOf`: run again under that run's id (its previous attempt is archived) instead of a new run.
function startRun({ tests: requested, role, token, baseUrl, health = null, rerunOf = null }) {
  if (!ROUTE_FOR_ROLE[role]) throw Object.assign(new Error(`Unknown role "${role}"`), { status: 400 });
  const list = Array.isArray(requested) ? requested : [];
  for (const t of list) {
    if (!TESTS[t?.test]) throw Object.assign(new Error(`Unknown load test "${t?.test}"`), { status: 400 });
  }
  const plan = Object.keys(TESTS)
    .filter((key) => list.some((t) => t.test === key))
    .map((key) => {
      const values = clampFields(TESTS[key], list.find((t) => t.test === key).fields);
      return { key, test: TESTS[key], values, script: TESTS[key].file(role) };
    });
  if (!plan.length) throw Object.assign(new Error('Pick at least one load test'), { status: 400 });
  if (registry.activeId) throw Object.assign(new Error('A load test is already in progress.'), { status: 409 });

  const config = {
    role: 'load',
    eventTypes: null,
    baseUrl,
    documentMode: plan.map((p) => p.key).join('+'),
    health,
    consignment: {
      partnerRole: role,
      tests: plan.map((p) => ({ test: p.key, script: `k6/${p.script}`, fields: p.values })),
    },
  };
  let storeRun;
  if (rerunOf) {
    storeRun = restartRun(rerunOf, 'load', config);
    if (!storeRun) throw Object.assign(new Error(`Run ${rerunOf} not found or not a load-test run`), { status: 404 });
  } else {
    storeRun = createRun({ id: `k6_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, ...config });
  }

  const run = {
    id: storeRun.id,
    status: 'running',
    total: null,
    results: [],
    logs: [],
    startedAt: storeRun.startedAt,
    health,
    baseUrl,
    integrity: [],
    sent: [],
    samples: [],
    rateLimit: null,
  };
  registry.runs.set(run.id, run);
  registry.activeId = run.id;

  const dir = documentsDir(run.id);
  fs.mkdirSync(dir, { recursive: true });

  // The key travels as an environment variable, not an argument, so it never appears in a
  // process listing. Keys loaded from the repo's .env are dropped: a run uses the key typed on
  // the form, as every other run does.
  const baseEnv = { ...process.env };
  for (const name of Object.values(TOKEN_ENV)) delete baseEnv[name];
  Object.assign(baseEnv, { ROLE: ROUTE_FOR_ROLE[role], API_TOKEN: token, [TOKEN_ENV[role]]: token, BASE_URL: baseUrl });

  const errors = [];
  const finish = (status) => {
    if (run.status !== 'running') return;
    const error = status === 'stopped' ? 'Stopped from the dashboard' : errors.length ? errors.join(' ') : null;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    delete run.child;
    registry.activeId = null;
    setResults(run.id, run.results);
    finishRun(run.id, { status, error });
    publish(run, { type: 'done', status, error });
  };

  // One k6 process per selected test, each with its own summary, console and events-sent
  // files. A test k6 could not run is reported and the sequence carries on with the next.
  const runStep = (index) => {
    if (run.stopped) return finish('stopped');
    if (index >= plan.length) return finish(errors.length === plan.length ? 'error' : 'complete');
    const { key, test, values, script } = plan[index];
    const summaryFile = path.join(dir, `k6-summary-${key}.json`);
    const consoleFile = path.join(dir, `k6-console-${key}.log`);
    for (const file of [summaryFile, consoleFile]) fs.rmSync(file, { force: true });
    Object.assign(run, { integrity: [], sent: [], samples: [], rateLimit: null });

    const child = spawn(
      k6Binary(),
      ['run', '--no-color', `--summary-export=${summaryFile}`, `--console-output=${consoleFile}`, path.join(K6_DIR, script)],
      {
        cwd: PROJECT_ROOT,
        env: { ...baseEnv, ...Object.fromEntries(Object.entries(test.env(values)).map(([k, v]) => [k, String(v)])) },
        windowsHide: true,
      }
    );
    run.child = child;
    publish(run, {
      type: 'log',
      line: `${plan.length > 1 ? `[${index + 1}/${plan.length}] ` : ''}k6 run k6/${script} — ${test.label.toLowerCase()} as ${role}, ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    });

    let buffer = '';
    let banner = true;
    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n|\r/);
      buffer = lines.pop();
      for (const line of lines) {
        // Skip k6's ASCII logo; everything from the execution summary on is worth showing.
        if (banner && !/^\s*execution:/.test(line)) continue;
        banner = false;
        handleLine(run, line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let done = false;
    const stepDone = (error) => {
      if (done) return;
      done = true;
      if (buffer) handleLine(run, buffer);
      if (error) errors.push(`${test.label}: ${error}`);
      readConsole(run, consoleFile, path.join(dir, `k6-events-sent-${key}.txt`));
      for (const result of buildResults(key, role, values, summaryFile, run)) {
        // Unique per test, so several tests' rows never collide in one run.
        const stepKey = result.stepKey.replace(/^k6:/, `k6:${key}:`);
        const eventType = plan.length > 1 ? `${test.label} — ${result.eventType}` : result.eventType;
        publish(run, { type: 'result', result: { ...result, stepKey, eventType, path: [result.testId, eventType] } });
      }
      runStep(index + 1);
    };
    child.on('error', (err) =>
      stepDone(err.code === 'ENOENT' ? 'k6 is not installed or not on PATH (set K6_BIN to its full path).' : err.message)
    );
    child.on('close', (code) => {
      if (run.stopped || code === 0 || code === THRESHOLDS_FAILED) stepDone(null);
      else stepDone(`k6 exited with code ${code} — see the output below.`);
    });
  };
  runStep(0);

  const estimates = plan.map((p) => p.test.seconds(p.values, role));
  const seconds = estimates.every((s) => typeof s === 'number') ? estimates.reduce((a, b) => a + b, 0) : null;
  return { run, seconds };
}

// The scripts' console.log output (k6/lib/epcis.js track(), INTEGRITY, RATELIMIT), which
// k6 writes to its own file as logfmt: msg="..." with Go-style escaping.
function readConsole(run, file, sentFile) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return;
  }
  const MAX_SAMPLES = 10;
  const MAX_PER_STATUS = 3;
  const perStatus = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const quoted = raw.match(/\bmsg="((?:[^"\\]|\\.)*)"/);
    if (!quoted) continue;
    let msg;
    try {
      msg = JSON.parse(`"${quoted[1]}"`);
    } catch {
      msg = quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    const sent = msg.match(/^SENT (\S+) (\S+) (\d+)$/);
    if (sent) {
      run.sent.push(`${sent[1]}  ${sent[2]}  ${sent[3]}`);
      continue;
    }
    if (msg.startsWith('SAMPLE ')) {
      // A few per status, so one kind of failure cannot crowd out another.
      try {
        const sample = JSON.parse(msg.slice(7));
        perStatus.set(sample.status, (perStatus.get(sample.status) || 0) + 1);
        if (run.samples.length < MAX_SAMPLES && perStatus.get(sample.status) <= MAX_PER_STATUS) run.samples.push(sample);
      } catch {
        // a truncated sample is not worth showing
      }
      continue;
    }
    const integrity = msg.match(/^INTEGRITY submitted=(\S+) status=(\d+) acked=(\S+)$/);
    if (integrity) {
      run.integrity.push({ submitted: integrity[1], status: Number(integrity[2]), acked: integrity[3] === 'NONE' ? [] : integrity[3].split('|') });
      continue;
    }
    const limit = msg.match(/^RATELIMIT role=\S+ (.*)$/);
    if (limit) {
      run.rateLimit = Object.fromEntries([...limit[1].matchAll(/([\w-]+)=(\S+)/g)].map((m) => [m[1].toLowerCase(), m[2]]));
      publish(run, { type: 'log', line: msg });
    }
  }
  // Every event the run sent, kept with the run for tracing in the Events Explorer.
  run.sentFile = sentFile;
  if (run.sent.length) {
    fs.writeFileSync(
      sentFile,
      `# eventID  EPC  HTTP status\n${run.sent.join('\n')}\n`,
      'utf-8'
    );
  }
}

function handleLine(run, line) {
  // "default [ 42% ] ..." repeats the "running (...)" line beside it; one is enough.
  if (/^\s*\w+\s+(?:[✓✗↓]\s+)?\[\s*\d+%\s*\]/.test(line)) return;
  if (line.trim()) publish(run, { type: 'log', line });
}

const ms = (v) => (typeof v === 'number' ? `${Math.round(v)} ms` : '—');

// Plain-English name for a k6 threshold expression on a metric.
function thresholdLabel(metric, expr) {
  const m = expr.match(/^(p\((\d+(?:\.\d+)?)\)|avg|max|min|med|rate|count)\s*(<=|>=|==|<|>)\s*([\d.]+)$/);
  if (!m) return `${metric} ${expr}`;
  const [, stat, pct, op, value] = m;
  if (metric === 'http_req_duration' && pct) return `p${pct} latency ${op} ${value} ms`;
  if (stat === 'rate' && /failed|unexpected/.test(metric))
    return `${metric === 'http_req_failed' ? 'Failed requests' : 'Unexpected responses'} ${op} ${Number(value) * 100}%`;
  if (metric === 'outcome_unhandled_crash') return 'No unhandled 5xx (crash) responses';
  if (metric.startsWith('checks')) return 'Every response acknowledges exactly its own event ID';
  return `${metric} ${expr}`;
}

function measured(metric, expr, data) {
  const pct = expr.match(/^p\((\d+(?:\.\d+)?)\)/);
  if (pct) return ms(data[`p(${pct[1]})`]);
  if (expr.startsWith('rate')) return `${((data.value ?? data.rate ?? 0) * 100).toFixed(2)}% (${data.passes ?? 0} of ${(data.passes ?? 0) + (data.fails ?? 0)})`;
  if (expr.startsWith('count')) return `${data.count ?? 0}`;
  return JSON.stringify(data);
}

function row(testId, role, key, label, { ok, skipped = false, expected, actual, reason, url }) {
  return {
    testId,
    stepKey: `k6:${key}`,
    eventType: label,
    path: [testId, label],
    role,
    ok,
    skipped,
    ...(ok || skipped ? {} : { reason }),
    variants: [
      { variant: 'k6', method: 'K6', url, status: null, ok, durationMs: null, expected, actual, reason: ok ? undefined : reason, ...(skipped ? { error: reason } : {}) },
    ],
  };
}

function buildResults(testKey, role, values, summaryFile, run) {
  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(summaryFile, 'utf-8'));
  } catch {
    return []; // k6 never got as far as a summary - the run's error says why
  }
  const test = TESTS[testKey];
  const testId = test.testId(role);
  const url = `${ROUTE_FOR_ROLE[role]} · POST ${run.baseUrl}/api/integration/${ROUTE_FOR_ROLE[role]}/events`;
  const metrics = summary.metrics || {};
  const results = [];

  for (const [metric, data] of Object.entries(metrics)) {
    for (const [expr, crossed] of Object.entries(data.thresholds || {})) {
      const label = thresholdLabel(metric, expr);
      const actual = measured(metric, expr, data);
      results.push(
        row(testId, role, `${metric}:${expr}`, label, {
          ok: !crossed,
          expected: `${metric} ${expr}`,
          actual,
          reason: `${label} did not hold — measured ${actual}.`,
          url,
        })
      );
    }
  }

  const count = (name) => metrics[name]?.count ?? 0;
  if (testKey === 'rate-limit') {
    const crashes = count('outcome_unhandled_crash');
    results.push(
      row(testId, role, 'no-crash', 'No unhandled 5xx (crash) responses', {
        ok: crashes === 0,
        expected: 'Every response is 2xx, 429 or 503',
        actual: `${crashes} unhandled 5xx`,
        reason: `${crashes} request${crashes === 1 ? '' : 's'} got an unhandled 5xx instead of a 429.`,
        url,
      })
    );
    const limit = Number(run.rateLimit?.['x-ratelimit-limit']);
    // The window is shared with every other client on the key, so the budget is what the
    // first response said was left (plus that request), not the full tier.
    const remaining = Number(run.rateLimit?.['x-ratelimit-remaining']);
    const budget = Number.isFinite(remaining) ? remaining + 1 : limit;
    const limited = count('outcome_rate_limited');
    const sent = count('http_reqs');
    // What actually reached the API in one minute: a slow endpoint sends fewer than asked.
    const perMinute = values.durationSec <= 60 ? sent : Math.round((sent * 60) / values.durationSec);
    const overTier = Number.isFinite(limit) && limit > 0 && perMinute > budget;
    results.push(
      row(testId, role, 'tier-429', `429 once over the ${Number.isFinite(limit) ? `${limit.toLocaleString('en')}/min` : 'documented'} tier`, {
        ok: overTier && limited > 0,
        skipped: !overTier,
        expected: Number.isFinite(limit)
          ? `More than ${limit.toLocaleString('en')} requests in a minute are answered 429 (tier ${run.rateLimit['x-ratelimit-tier'] || role})`
          : 'The API reports its tier in X-Ratelimit-* headers',
        actual: `${limited} of ${sent} requests answered 429`,
        reason: overTier
          ? `${perMinute.toLocaleString('en')} requests reached the API in a minute against ${budget.toLocaleString('en')} left in the ${limit.toLocaleString('en')}/min tier, but none was rate-limited.`
          : Number.isFinite(limit)
            ? `Only ${perMinute.toLocaleString('en')} requests reached the API in a minute, within the ${budget.toLocaleString('en')} left in the ${limit.toLocaleString('en')}/min tier${
                sent < values.rps * Math.min(values.durationSec, 60) ? ' (the API could not take the requested rate)' : ''
              }. Run for at least 60 s, above ${Math.ceil(budget / 60)} req/s, to test enforcement.`
            : 'The first response carried no X-Ratelimit-* headers, so the tier is unknown.',
        url,
      })
    );
  }

  if (testKey === 'integrity') {
    const ok2xx = run.integrity.filter((r) => r.status === 201 || r.status === 202);
    const seen = new Map();
    for (const r of ok2xx) for (const id of r.acked) seen.set(id, (seen.get(id) || 0) + 1);
    const dupes = [...seen.values()].filter((n) => n > 1).length;
    results.push(
      row(testId, role, 'unique-acks', 'No event ID acknowledged for more than one request', {
        ok: dupes === 0 && ok2xx.length > 0,
        expected: 'Each acknowledged ID appears once across the whole run',
        actual: `${ok2xx.length} acknowledged, ${dupes} ID${dupes === 1 ? '' : 's'} handed back more than once`,
        reason: ok2xx.length === 0 ? 'No request was acknowledged, so uniqueness could not be checked.' : `${dupes} event IDs were acknowledged for more than one request.`,
        url,
      })
    );
  }

  // Measured numbers for the record; no pass/fail of their own.
  const d = metrics.http_req_duration || {};
  const reqs = metrics.http_reqs || {};
  const outcomes = Object.entries(metrics)
    .filter(([k, v]) => k.startsWith('outcome_') && v.count)
    .map(([k, v]) => `${k.replace('outcome_', '').replace(/_/g, ' ')} ${v.count}`);
  results.push(
    row(testId, role, 'measured', 'Throughput and latency (measured)', {
      ok: true,
      expected: 'Recorded as the baseline for this role and profile — no limit of its own',
      actual: [
        `${reqs.count ?? 0} requests at ${(reqs.rate ?? 0).toFixed(1)} req/s, peak ${metrics.vus_max?.value ?? '—'} VUs`,
        `latency median ${ms(d.med)}, p90 ${ms(d['p(90)'])}, p95 ${ms(d['p(95)'])}, max ${ms(d.max)}`,
        outcomes.length ? `outcomes: ${outcomes.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      url,
    })
  );

  // Sampled requests open as tabs on every row (document, EPCs, event IDs, response - all
  // copyable, as on API runs). The full list of events sent goes on the measured row only:
  // a stress run sends thousands, and the whole list is in k6-events-sent.txt regardless.
  const exchanges = run.samples.map((s) => ({
    variant: `${s.status === 201 || s.status === 202 ? 'Sample' : 'Failed'} · ${s.status}`,
    method: 'POST',
    url: s.url,
    status: s.status,
    ok: s.status === 201 || s.status === 202,
    durationMs: s.durationMs,
    requestBody: s.request,
    responseBody: s.response,
  }));
  const MAX_TRACKED_LINES = 2000;
  return results.map((r) => ({
    ...r,
    ...(exchanges.length ? { exchanges } : {}),
    ...(r.stepKey === 'k6:measured' && run.sent.length
      ? {
          tracking: {
            total: run.sent.length,
            lines: run.sent.slice(0, MAX_TRACKED_LINES),
            file: run.sentFile,
          },
        }
      : {}),
  }));
}

function stopRun(id) {
  const run = registry.runs.get(id);
  if (!run || !run.child) return false;
  run.stopped = true;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    // SIGINT lets k6 stop gracefully and still write its summary.
    run.child.kill('SIGINT');
  }
  return true;
}

function getRun(id) {
  return registry.runs.get(id) || null;
}

function subscribe(id, listener) {
  registry.bus.on(id, listener);
  return () => registry.bus.off(id, listener);
}

module.exports = { listTests, startRun, stopRun, getRun, subscribe, TESTS };
