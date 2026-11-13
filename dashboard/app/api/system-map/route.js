import { NextResponse } from 'next/server';
import { systemMap } from '../../../lib/systemMap';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const baseUrl = new URL(request.url).searchParams.get('baseUrl');
  return NextResponse.json(systemMap(baseUrl));
}
