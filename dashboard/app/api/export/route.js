import fs from 'fs';
import { NextResponse } from 'next/server';
import { exportToWorkbook } from '../../../lib/exportWorkbook';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const { outPath, filename, matchedRows, totalTracked } = await exportToWorkbook();
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
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
