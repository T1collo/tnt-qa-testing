import { NextResponse } from 'next/server';
import { listRuns } from '../../../lib/runStore';
import { runDetail } from '../../../lib/runDetail';
import { readRun } from '../../../lib/runStore';
import fs from 'node:fs';

export const dynamic = 'force-dynamic';

// The run list, or one run's detail with ?id=. The query form is what the pages use: a plain
// path keeps working even when the dev server loses dynamic-segment routes (/api/runs/[id]).
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const id = params.get('id');

  // ?id=<run>&document=<stepKey|testId> returns the document that step was sent in. The path
  // comes from the run's own record, never from the request, so nothing outside a run's
  // documents folder can be read.
  const step = params.get('document');
  if (id && step) {
    const run = readRun(id);
    const result = run?.results?.find((x) => x.stepKey === step || x.testId === step);
    const path = result?.variants?.find((v) => v.documentPath)?.documentPath;
    if (!path) return NextResponse.json({ error: 'no saved document for that step' }, { status: 404 });
    try {
      return NextResponse.json({ path, text: fs.readFileSync(path, 'utf-8') });
    } catch (err) {
      return NextResponse.json({ error: `could not read ${path}: ${err.message}` }, { status: 410 });
    }
  }
  if (!id) return NextResponse.json({ runs: listRuns() });
  const detail = await runDetail(id);
  if (!detail) return NextResponse.json({ error: 'unknown runId' }, { status: 404 });
  return NextResponse.json(detail);
}
