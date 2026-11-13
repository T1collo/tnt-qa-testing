import { NextResponse } from 'next/server';
import { runDetail } from '../../../../lib/runDetail';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { id } = await params;
  const detail = await runDetail(id);
  if (!detail) return NextResponse.json({ error: 'unknown runId' }, { status: 404 });
  return NextResponse.json(detail);
}
