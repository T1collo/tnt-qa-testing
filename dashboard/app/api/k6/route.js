import { NextResponse } from 'next/server';
import { listTests, startRun, stopRun } from '../../../lib/k6Runner';
import { normalizeBaseUrl } from '../../../lib/baseUrl';
import { getBaseUrl } from '../../../lib/env';
import { checkReachable, healthSnapshot } from '../../../lib/reachability';

export const dynamic = 'force-dynamic';

// The load tests the Run page can offer, their tunable fields, and the installed k6 version.
export async function GET() {
  return NextResponse.json(await listTests());
}

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.apiToken !== 'string' || !body.apiToken.trim()) {
    return NextResponse.json({ error: 'Add the role’s API token' }, { status: 400 });
  }

  let baseUrl = getBaseUrl();
  if (body.baseUrl !== undefined) {
    const normalized = normalizeBaseUrl(body.baseUrl);
    if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });
    baseUrl = normalized.value;
  }

  // Same host gate as the other runs — load against a dead host measures nothing.
  const reachability = await checkReachable(baseUrl);
  if (!reachability.reachable) {
    return NextResponse.json(
      { error: `${baseUrl} is not reachable — ${reachability.error}`, reachability },
      { status: 502 }
    );
  }
  const health = healthSnapshot(baseUrl, reachability);

  try {
    const { run, seconds } = startRun({
      // { tests: [{ test, fields }] }; a single { test, fields } is still accepted.
      tests: Array.isArray(body.tests) ? body.tests : body.test ? [{ test: body.test, fields: body.fields }] : [],
      role: body.role,
      token: body.apiToken.trim(),
      baseUrl,
      health,
      rerunOf: typeof body.rerunOf === 'string' && body.rerunOf ? body.rerunOf : null,
    });
    return NextResponse.json({ runId: run.id, seconds, health });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}

export async function DELETE(request) {
  const runId = new URL(request.url).searchParams.get('runId');
  if (!runId || !stopRun(runId)) {
    return NextResponse.json({ error: 'No running load test with that id' }, { status: 404 });
  }
  return NextResponse.json({ stopping: runId });
}
