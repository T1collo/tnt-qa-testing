import { GET as streamById } from './[runId]/route';

export const dynamic = 'force-dynamic';

// Same stream as /api/playwright/stream/[runId], addressed as ?runId=. A plain path does not depend
// on dynamic-segment handling, which the dev server has been seen to lose (every [param]
// route then answers 500 while static routes keep working).
export async function GET(request) {
  const runId = new URL(request.url).searchParams.get('runId') || '';
  return streamById(request, { params: Promise.resolve({ runId }) });
}
