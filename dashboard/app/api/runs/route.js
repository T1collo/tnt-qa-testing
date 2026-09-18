import { NextResponse } from 'next/server';
import { listRuns } from '../../../lib/runStore';
import { runDetail } from '../../../lib/runDetail';

export const dynamic = 'force-dynamic';

// The run list, or one run's detail with ?id=. The query form is what the pages use: a plain
// path keeps working even when the dev server loses dynamic-segment routes (/api/runs/[id]).
export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ runs: listRuns() });
  const detail = await runDetail(id);
  if (!detail) return NextResponse.json({ error: 'unknown runId' }, { status: 404 });
  return NextResponse.json(detail);
}
