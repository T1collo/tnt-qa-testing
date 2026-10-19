import { NextResponse } from 'next/server';
import { listSpecs, startRun, stopRun, recentRuns } from '../../../lib/playwrightRunner';
import { normalizeBaseUrl } from '../../../lib/baseUrl';
import { getBaseUrl } from '../../../lib/env';
import { checkReachable, healthSnapshot } from '../../../lib/reachability';

export const dynamic = 'force-dynamic';

// The spec files the Run page can offer, with their test counts.
export async function GET() {
  try {
    return NextResponse.json({ specs: await listSpecs(), runs: recentRuns() });
  } catch (err) {
    return NextResponse.json({ specs: [], error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Only names Playwright itself listed are passed on, so nothing from the request can
  // reach the command line as an option.
  let specs;
  try {
    specs = await listSpecs();
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
  const known = new Set(specs.map((s) => s.file));
  const files = Array.isArray(body.files) ? body.files.filter((f) => known.has(f)) : [];
  if (files.length === 0) {
    return NextResponse.json({ error: 'Pick at least one spec file' }, { status: 400 });
  }

  let baseUrl = getBaseUrl();
  if (body.baseUrl !== undefined) {
    const normalized = normalizeBaseUrl(body.baseUrl);
    if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });
    baseUrl = normalized.value;
  }

  // Same host gate as API/e2e — UI tests against a dead host are not a useful suite result.
  const reachability = await checkReachable(baseUrl);
  if (!reachability.reachable) {
    return NextResponse.json(
      { error: `${baseUrl} is not reachable — ${reachability.error}`, reachability },
      { status: 502 }
    );
  }
  const health = healthSnapshot(baseUrl, reachability);

  try {
    const run = startRun({
      // Every spec picked means the whole suite, which is what `npm test` runs.
      files: files.length === specs.length ? [] : files,
      headed: Boolean(body.headed),
      rerunOf: typeof body.rerunOf === 'string' && body.rerunOf ? body.rerunOf : null,
      baseUrl,
      health,
    });
    const total = specs.filter((s) => files.includes(s.file)).reduce((n, s) => n + s.tests, 0);
    return NextResponse.json({ runId: run.id, total, health });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}

export async function DELETE(request) {
  const runId = new URL(request.url).searchParams.get('runId');
  if (!runId || !stopRun(runId)) {
    return NextResponse.json({ error: 'No running Playwright run with that id' }, { status: 404 });
  }
  return NextResponse.json({ stopping: runId });
}
