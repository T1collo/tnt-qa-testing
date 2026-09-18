import { NextResponse } from 'next/server';
import { getBaseUrl } from '../../../lib/env';
import { normalizeBaseUrl } from '../../../lib/baseUrl';
import { checkReachable } from '../../../lib/reachability';

export const dynamic = 'force-dynamic';

// Simple reachability check for the Dashboard's "system health" tile - a HEAD request to
// the partner API host. Doesn't require a token, so it's safe to run on every dashboard load.
// Accepts ?baseUrl= so the Run form can check the host the operator typed before they paste
// a token into it - an unreachable or wrong host is much cheaper to spot here than as a 401
// halfway through a run.
export async function GET(request) {
  const requested = request.nextUrl.searchParams.get('baseUrl');
  let baseUrl = getBaseUrl();
  if (requested !== null) {
    const normalized = normalizeBaseUrl(requested);
    if (!normalized.ok) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }
    baseUrl = normalized.value;
  }

  return NextResponse.json({ baseUrl, ...(await checkReachable(baseUrl)) });
}
