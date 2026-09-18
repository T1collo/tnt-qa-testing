import { NextResponse } from 'next/server';
import {
  auditSummary,
  listAuditRuns,
  searchResults,
  resultDetail,
  runAudit,
} from '../../../lib/auditDb';

export const dynamic = 'force-dynamic';

// Read-only view of the SQLite audit log. One plain path with ?view= (no dynamic segments):
//   ?view=summary
//   ?view=runs&kind=e2e&status=complete&from=2026-09-01&to=2026-09-18
//   ?view=results&runId=...&outcome=fail&testId=MFG&code=INVALID_LOT&q=text
//   ?view=result&id=123          one result with request, response and every warning
//   ?view=run&id=run_...         one run with its log lines, portal batches and warning counts
export async function GET(request) {
  const p = new URL(request.url).searchParams;
  const get = (k) => p.get(k) || undefined;
  switch (p.get('view') || 'summary') {
    case 'summary':
      return NextResponse.json(auditSummary());
    case 'runs':
      return NextResponse.json({
        runs: listAuditRuns({ kind: get('kind'), status: get('status'), from: get('from'), to: get('to'), limit: get('limit') }),
      });
    case 'results':
      return NextResponse.json({
        results: searchResults({
          runId: get('runId'),
          outcome: get('outcome'),
          testId: get('testId'),
          code: get('code'),
          q: get('q'),
          limit: get('limit'),
        }),
      });
    case 'result': {
      const row = resultDetail(Number(p.get('id')));
      return row ? NextResponse.json(row) : NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    case 'run': {
      const run = runAudit(p.get('id') || '');
      return run ? NextResponse.json(run) : NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    default:
      return NextResponse.json({ error: 'unknown view' }, { status: 400 });
  }
}
