import fs from 'fs';
import { NextResponse } from 'next/server';
import { exportToWorkbook } from '../../../lib/exportWorkbook';

export const dynamic = 'force-dynamic';

// Body (optional): { runId } to export a single run; no body exports every run.
export async function POST(request) {
  const body = await request.json().catch(() => null);
  const runId = typeof body?.runId === 'string' && body.runId ? body.runId : null;
  try {
    const { outPath, filename, matchedRows, totalTracked } = await exportToWorkbook({ runId });
    const buffer = fs.readFileSync(outPath);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Matched-Rows': String(matchedRows),
        'X-Total-Tracked': String(totalTracked),
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}
