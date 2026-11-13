// Builds the System Map: which partner sends which event to which Hub endpoint, and how each
// of those last behaved. Run records are per environment, so results are never merged across
// base URLs - a pass on tnt-demo says nothing about TrackIQ.
const { TEST_ID_MAP } = require('./testIdMap');
const { listRuns, readRun } = require('./runStore');

// Enough history to find the last result of every event, without reading the whole store.
const MAX_RUNS = 60;

const ROLE_LABEL = { manufacturer: 'Manufacturer', distributor: 'Distributor', facility: 'Facility' };

// Used until a recorded request shows the real path.
const DEFAULT_ENDPOINT = {
  manufacturer: '/api/integration/manufacturer/events',
  distributor: '/api/integration/supplier/events',
  facility: '/api/integration/facility/events',
};

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

// pass: green. warn: accepted, but the platform raised warnings worth a look: yellow.
// fail: red. discontinued: the flow stopped before this step ran: blue.
function warningsOf(result) {
  return [...new Set([...(result.attributedWarnings ?? []), ...(result.unattributedWarnings ?? [])].map((w) => w.code ?? w))];
}

function statusOf(result) {
  if (result.skipped) return 'discontinued';
  if (!result.ok) return 'fail';
  return warningsOf(result).length > 0 ? 'warn' : 'pass';
}

function systemMap(requestedBaseUrl) {
  const runs = listRuns();
  const environments = [...new Set(runs.map((r) => r.baseUrl).filter(Boolean))];
  // Default to the environment with the most API history, so the map opens with real results.
  const apiRuns = (url) => runs.filter((r) => r.baseUrl === url && r.role in { ...ROLE_LABEL, 'end-to-end': 1 }).length;
  const busiest = [...environments].sort((a, b) => apiRuns(b) - apiRuns(a))[0] ?? null;
  const baseUrl = requestedBaseUrl && environments.includes(requestedBaseUrl) ? requestedBaseUrl : busiest;

  const relevant = runs
    .filter((r) => r.baseUrl === baseUrl && r.role in { ...ROLE_LABEL, 'end-to-end': 1 })
    .slice(0, MAX_RUNS);

  // Runs are newest first, so the first result seen for an event is its latest.
  const latest = new Map();
  for (const summary of relevant) {
    const run = readRun(summary.id);
    for (const result of run?.results ?? []) {
      const role = result.role ?? (summary.role in ROLE_LABEL ? summary.role : null);
      if (!role || !result.testId) continue;
      const key = `${role}|${result.testId}`;
      if (latest.has(key)) continue;
      const variant = result.variants?.find((v) => v.url) ?? result.variants?.[0];
      latest.set(key, {
        status: statusOf(result),
        http: variant?.status ?? null,
        durationMs: variant?.durationMs ?? null,
        endpoint: pathOf(variant?.url),
        error: result.error ?? null,
        warnings: warningsOf(result),
        runId: summary.id,
        at: summary.startedAt,
      });
    }
    // A single-role run names its events up front. Any it has not reached are waiting if it is
    // still going, and discontinued if it stopped. Older results must not stand in for them.
    if (run?.eventTypes && summary.role in ROLE_LABEL) {
      for (const m of TEST_ID_MAP.filter((t) => t.role === summary.role && run.eventTypes.includes(t.eventType))) {
        const key = `${summary.role}|${m.testId}`;
        if (latest.has(key)) continue;
        if (run.status === 'running') latest.set(key, { status: 'pending', runId: summary.id, at: summary.startedAt });
        else if (run.status === 'stopped' || run.status === 'error') {
          latest.set(key, { status: 'discontinued', error: run.error ?? `Run ${run.status} before this step`, runId: summary.id, at: summary.startedAt });
        }
      }
    }
  }

  const roles = Object.entries(ROLE_LABEL).map(([role, label]) => ({
    role,
    label,
    events: TEST_ID_MAP.filter((m) => m.role === role).map((m) => {
      const seen = latest.get(`${role}|${m.testId}`);
      return {
        id: `${role}|${m.testId}`,
        testId: m.testId,
        eventType: m.eventType,
        path: m.path.join(' > '),
        endpoint: seen?.endpoint ?? DEFAULT_ENDPOINT[role],
        status: seen?.status ?? 'not-run',
        http: seen?.http ?? null,
        durationMs: seen?.durationMs ?? null,
        error: seen?.error ?? null,
        warnings: seen?.warnings ?? [],
        runId: seen?.runId ?? null,
        at: seen?.at ?? null,
      };
    }),
  }));

  const newest = relevant[0] ?? runs.find((r) => r.baseUrl === baseUrl);
  return {
    baseUrl,
    environments,
    running: relevant.some((r) => r.status === 'running'),
    hub: {
      reachable: newest?.health?.reachable ?? null,
      latencyMs: newest?.health?.latencyMs ?? null,
      checkedAt: newest?.health?.checkedAt ?? null,
    },
    roles,
  };
}

module.exports = { systemMap };
