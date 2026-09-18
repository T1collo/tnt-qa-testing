import { getRun, subscribe } from '../../../../../lib/playwrightRunner';

export const dynamic = 'force-dynamic';

// SSE stream for one Playwright run: subscribes first, then replays what already happened
// (total, results, recent output), so a page that reconnects mid-run misses nothing.
export async function GET(request, { params }) {
  const { runId } = await params;
  const encoder = new TextEncoder();
  let unsubscribe = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        controller.close();
      };

      const run = getRun(runId);
      if (!run) {
        send({ type: 'done', status: 'error', error: 'This Playwright run is no longer held by the server (it restarted).' });
        close();
        return;
      }

      unsubscribe = subscribe(runId, (event) => {
        send(event);
        if (event.type === 'done') close();
      });

      send({ type: 'reset' });
      if (run.total !== null) send({ type: 'total', total: run.total });
      for (const result of run.results) send({ type: 'result', result });
      for (const line of run.logs) send({ type: 'log', line });
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
