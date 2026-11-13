// Runs scripts/portal/create-batches.cjs (Playwright, Manufacturer portal UI) and returns the
// batch number and expiry the portal assigned to each product line.
const { spawn } = require('child_process');
const path = require('path');
const { PROJECT_ROOT } = require('./paths');

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'portal', 'create-batches.cjs');
const MARKER = '@@BATCH@@';
// Serials are typed into the portal form; beyond this the form is not a sensible channel
// (the portal's Bulk CSV import is), so the run refuses rather than hanging on a huge paste.
const MAX_PORTAL_SERIALS = 1000;
const TIMEOUT_MS = 5 * 60_000;

// "urn:epc:id:sgtin:8904179.170218.1234" -> "1234"
const bareSerial = (sgtin) => sgtin.slice(sgtin.lastIndexOf('.') + 1);

function createPortalBatches({ lines, baseUrl, headed = false }) {
  const request = {
    baseUrl,
    headed,
    batches: lines.map((line, i) => ({
      key: String(i),
      productName: line.product.brand,
      gtin: line.product.gtin,
      serials: line.serials.map(bareSerial),
    })),
  };

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const results = new Map();
    let output = '';
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PORTAL_BATCH_REQUEST: JSON.stringify(request), DOTENV_CONFIG_QUIET: 'true' },
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      for (const line of parts) {
        if (!line.startsWith(MARKER)) {
          if (line.trim()) output += `${line}\n`;
          continue;
        }
        try {
          const event = JSON.parse(line.slice(MARKER.length));
          if (event.type === 'batch') results.set(event.key, event);
        } catch {
          // ignore a malformed marker line
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const finish = (fallbackError) => {
      clearTimeout(timer);
      resolve({
        durationMs: Date.now() - startedAt,
        output: output.slice(-2000),
        lines: request.batches.map((b) =>
          results.get(b.key) || { key: b.key, ok: false, error: fallbackError || 'The portal script ended before this batch was created' }
        ),
      });
    };
    child.on('error', (err) => finish(`Could not start the portal script: ${err.message}`));
    child.on('close', (code) => finish(code === null ? 'The portal script timed out' : null));
  });
}

module.exports = { createPortalBatches, MAX_PORTAL_SERIALS };
