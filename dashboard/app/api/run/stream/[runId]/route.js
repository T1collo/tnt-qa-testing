import { readRun } from '../../../../../lib/runStore';
import { subscribe } from '../../../../../lib/runBus';

export const dynamic = 'force-dynamic';

// SSE stream of live progress for one run. Subscribes to runBus first, then sends whatever
// is already on disk as backlog, so a client connecting slightly after the run started still
// sees every result. The frontend keys results by testId (not append-only), so a result that
// arrives both in the backlog and as a live event is a harmless overwrite, not a duplicate.
export async function GET(request, { params }) {
  const { runId } = await params;
  const encoder = new TextEncoder();

  let unsubscribe = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (event) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const close = () => {
        unsubscribe();
        controller.close();
      };

      unsubscribe = subscribe(runId, (event) => {
        send(event);
        if (event.type === 'done') close();
      });

      const run = readRun(runId);
      if (!run) {
        send({ type: 'done', status: 'error', error: 'unknown runId' });
        close();
        return;
      }
      for (const result of run.results) {
        send({ type: 'result', result });
      }
      if (run.status !== 'running') {
        send({ type: 'done', status: run.status });
        close();
      }
    },
    cancel() {
      unsubscribe();
    },
  });

  request.signal.addEventListener('abort', () => unsubscribe());

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
