import { NextResponse } from 'next/server';
import { TEST_ID_MAP } from '../../../lib/testIdMap';

export async function GET() {
  return NextResponse.json({ map: TEST_ID_MAP });
}
