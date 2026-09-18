// Starts the browser (L4) Playwright suite from the dashboard and streams its progress.
//
// Kept apart from runStore on purpose: those runs are API requests, and the Logs page
// renders every stored result as a curl repro, which means nothing for a browser test.
// Playwright keeps its own history in playwright-report/ and test-results/results.json.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PROJECT_ROOT } = require('./paths');
const audit = require('./auditDb');

const CLI = path.join(PROJECT_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const REPORTER = path.join(PROJECT_ROOT, 'tests', 'helpers', 'live-reporter.js');
const MARKER = '@@PW@@';
const MAX_LOG_LINES = 400;

// One registry for the whole process. Route modules can be instantiated separately in dev,
// so it hangs off globalThis rather than module scope.
const registry =
  globalThis.__tntPlaywrightRuns ||
  (globalThis.__tntPlaywrightRuns = { runs: new Map(), bus: new EventEmitter(), activeId: null });
registry.bus.setMaxListeners(50);

function childEnv(extra) {
  // DOTENV_CONFIG_QUIET stops dotenv's banner landing in the output we parse.
  return { ...process.env, DOTENV_CONFIG_QUIET: 'true', PLAYWRIGHT_HTML_OPEN: 'never', FORCE_COLOR: '0', ...extra };
}

let specCache = null;

// Spec files and how many tests each holds, from Playwright's own --list.
function listSpecs() {
  if (specCache) return Promise.resolve(specCache);
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CLI)) {
      reject(new Error('Playwright is not installed in the project root (npm install).'));
      return;
    }
    const child = spawn(process.execPath, [CLI, 'test', '--list', '--reporter=json'], {
      cwd: PROJECT_ROOT,
      env: childEnv(),
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', () => {
      try {
        const json = JSON.parse(out.slice(out.indexOf('{')));
        const count = (suite) =>
          (suite.specs || []).length + (suite.suites || []).reduce((n, s) => n + count(s), 0);
        specCache = (json.suites || []).map((suite) => ({ file: suite.file, tests: count(suite) }));
        resolve(specCache);
      } catch {
        reject(new Error(`Could not list Playwright tests. ${err.trim().split('\n')[0] || ''}`.trim()));
      }
    });
  });
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

function toResult(e) {
  const skipped = e.status === 'skipped';
  return {
    // Tests without a workbook ID (qtest) fall back to their spec name, not Playwright's hash.
    testId: e.testId || String(e.path?.[0] || 'test').replace(/\.spec\.[jt]s$/, ''),
    stepKey: e.id,
    eventType: e.title,
    path: e.path,
    role: 'browser',
    ok: e.outcome === 'expected' && !skipped,
    skipped,
    error: e.error || undefined,
    variants: [
      {
        variant: e.project || 'chromium',
        method: 'UI',
        url: (e.path || []).join(' > '),
        status: null,
        ok: e.outcome === 'expected',
        durationMs: e.durationMs,
        error: e.error || undefined,
      },
    ],
  };
}

function startRun({ files, headed, baseUrl }) {
  if (registry.activeId) {
    const err = new Error('A Playwright run is already in progress.');
    err.status = 409;
    throw err;
  }
  const id = `pw_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const run = { id, status: 'running', total: null, results: [], logs: [], startedAt: new Date().toISOString() };
  registry.runs.set(id, run);
  registry.activeId = id;
  audit.recordRunStart({
    id,
    kind: 'ui',
    role: 'browser',
    documentMode: headed ? 'headed' : 'headless',
    baseUrl,
    startedAt: run.startedAt,
    consignment: { specs: files.length ? files : 'all' },
  });

  // The config's own reporters are replaced, so html and json are listed again to keep the
  // report and test-results/results.json exactly as `npm test` leaves them.
  const args = [CLI, 'test', ...files, `--reporter=list,${REPORTER},html,json`];
  if (headed) args.push('--headed');
  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    // The environment chosen on the form wins over BASE_URL in .env (dotenv never overrides).
    env: childEnv({
      PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(PROJECT_ROOT, 'test-results', 'results.json'),
      ...(baseUrl ? { BASE_URL: baseUrl } : {}),
    }),
    windowsHide: true,
  });
  run.child = child;

  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) handleLine(run, line);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const finish = (status, error) => {
    if (run.status !== 'running') return;
    if (buffer) handleLine(run, buffer);
    run.status = status;
    run.finishedAt = new Date().toISOString();
    delete run.child;
    registry.activeId = null;
    const passed = run.results.filter((r) => r.ok).length;
    const skipped = run.results.filter((r) => !r.ok && r.skipped).length;
    audit.recordRunFinish(run.id, {
      status,
      finishedAt: run.finishedAt,
      total: run.results.length,
      passed,
      failed: run.results.length - passed - skipped,
      skipped,
      error,
    });
    publish(run, { type: 'done', status, error });
  };
  child.on('error', (err) => finish('error', err.message));
  child.on('close', (code) => {
    if (run.stopped) finish('stopped', 'Stopped from the dashboard');
    else if (code === 0) finish('complete');
    else if (run.results.length === 0) finish('error', `Playwright exited with code ${code} before any test ran — see the output below.`);
    else finish('complete');
  });
  return run;
}

function handleLine(run, line) {
  if (!line.startsWith(MARKER)) {
    if (line.trim()) publish(run, { type: 'log', line });
    return;
  }
  let event;
  try {
    event = JSON.parse(line.slice(MARKER.length));
  } catch {
    return;
  }
  if (event.type === 'begin') {
    run.total = event.total;
    publish(run, { type: 'total', total: event.total });
  } else if (event.type === 'testEnd') {
    publish(run, { type: 'result', result: toResult(event) });
  }
}

function stopRun(id) {
  const run = registry.runs.get(id);
  if (!run || !run.child) return false;
  run.stopped = true;
  // On Windows kill() ends only the runner, leaving its browser windows open; take the
  // whole process tree down instead.
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    run.child.kill();
  }
  return true;
}

// Newest first, without results or output - enough to find a run again.
function recentRuns() {
  return [...registry.runs.values()].reverse().slice(0, 10).map((r) => ({
    id: r.id, status: r.status, total: r.total, done: r.results.length,
    passed: r.results.filter((x) => x.ok).length, startedAt: r.startedAt, finishedAt: r.finishedAt ?? null,
  }));
}

function getRun(id) {
  return registry.runs.get(id) || null;
}

function subscribe(id, listener) {
  registry.bus.on(id, listener);
  return () => registry.bus.off(id, listener);
}

module.exports = { listSpecs, startRun, stopRun, getRun, recentRuns, subscribe };
