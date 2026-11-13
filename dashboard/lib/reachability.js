// One reachability probe, used by /api/health (so the Run form can show a verdict) and by
// /api/run + /api/e2e (so the server decides for itself before firing anything).
//
// The API routes deliberately do NOT trust the client's "I already checked" state: a stale
// green badge, an edited request, or a host that went down between the check and the run
// would otherwise start a run against something unreachable and report a wall of network
// errors as if they were test failures. The server re-probes and is the source of truth.
const TIMEOUT_MS = 5000;

async function checkReachable(baseUrl) {
  const startedAt = Date.now();
  try {
    const res = await fetch(baseUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { reachable: true, status: res.status, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { reachable: false, error: err.message, latencyMs: Date.now() - startedAt };
  }
}

// Snapshot stored on each run at start so Health history can show past probes, not only
// the live tile. checkedAt is wall-clock at probe time; baseUrl is the host that was probed.
function healthSnapshot(baseUrl, reachability) {
  return {
    reachable: Boolean(reachability?.reachable),
    status: reachability?.status ?? null,
    latencyMs: reachability?.latencyMs ?? null,
    error: reachability?.error ?? null,
    checkedAt: new Date().toISOString(),
    baseUrl,
  };
}

module.exports = { checkReachable, healthSnapshot };
