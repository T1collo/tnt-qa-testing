// In-memory pub/sub so the SSE route can stream live progress for a run started by the
// POST /api/run route, within the same long-running Node process (this app is run locally
// via `next dev`/`next start`, not deployed as stateless serverless functions, so a
// module-level singleton is safe and simplest - no Redis/pubsub needed).
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

function emitProgress(runId, event) {
  bus.emit(runId, event);
}

function subscribe(runId, listener) {
  bus.on(runId, listener);
  return () => bus.off(runId, listener);
}

module.exports = { emitProgress, subscribe };
