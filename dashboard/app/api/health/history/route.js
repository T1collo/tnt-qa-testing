import { NextResponse } from 'next/server';
import { listRuns } from '../../../../lib/runStore';

export const dynamic = 'force-dynamic';

function passRate(run) {
  const skipped = run.skipped ?? 0;
  const attempted = (run.total || 0) - skipped;
  if (attempted <= 0) return null;
  return Math.round((run.passed / attempted) * 1000) / 10;
}

function toSnapshot(run) {
  const health = run.health || null;
  return {
    id: run.id,
    role: run.role,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    baseUrl: health?.baseUrl || run.baseUrl || null,
    health,
    total: run.total ?? 0,
    passed: run.passed ?? 0,
    failed: run.failed ?? 0,
    skipped: run.skipped ?? 0,
    passRate: passRate(run),
  };
}

// Filtered health history derived from run index entries (host probe + suite totals).
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  const role = params.get('role') || 'all';
  const reachable = params.get('reachable') || 'all';
  const status = params.get('status') || 'all';
  const baseUrlQ = (params.get('baseUrl') || '').trim().toLowerCase();
  const from = params.get('from');
  const to = params.get('to');

  const fromMs = from ? Date.parse(from) : NaN;
  const toMs = to ? Date.parse(to) : NaN;

  let items = listRuns().map(toSnapshot);

  if (role !== 'all') {
    items = items.filter((r) => r.role === role);
  }
  if (reachable === 'up') {
    items = items.filter((r) => r.health?.reachable === true);
  } else if (reachable === 'down') {
    items = items.filter((r) => r.health?.reachable === false);
  }
  if (status !== 'all') {
    items = items.filter((r) => r.status === status);
  }
  if (baseUrlQ) {
    items = items.filter((r) => (r.baseUrl || '').toLowerCase().includes(baseUrlQ));
  }
  if (!Number.isNaN(fromMs)) {
    items = items.filter((r) => {
      const t = Date.parse(r.health?.checkedAt || r.startedAt);
      return !Number.isNaN(t) && t >= fromMs;
    });
  }
  if (!Number.isNaN(toMs)) {
    items = items.filter((r) => {
      const t = Date.parse(r.health?.checkedAt || r.startedAt);
      return !Number.isNaN(t) && t <= toMs;
    });
  }

  // Newest first already from index; current = [0], past = first completed after that.
  const current = items[0] || null;
  const past =
    items.find(
      (r, i) =>
        i > 0 &&
        r.status !== 'running' &&
        (!current || r.role === current.role || role !== 'all')
    ) || null;

  return NextResponse.json({
    items,
    current,
    past,
    filters: { role, reachable, status, baseUrl: baseUrlQ, from, to },
  });
}
