// Records the requests a browser test sends - the portal's own API calls and any EPCIS document
// a helper posts directly - so the dashboard can show each one's body, EPC list and response,
// the same way it does for API runs. Each request is a test attachment named "exchange"; the
// live reporter forwards them to the dashboard.
//
// Sign-in calls are never recorded, and any field that looks like a secret (password, token,
// API key, cookie) is blanked before it leaves the test.
const { test } = require('@playwright/test');

const MAX_BODY = 100_000;
const MAX_EXCHANGES = 25;
const SECRET_KEY = /pass(word)?|token|secret|api[-_]?key|authorization|cookie|session/i;
// Sign-in (credentials) and browser telemetry beacons (Grafana Faro and similar) are not test traffic.
const SKIP_PATH = /\/api\/(auth|faro|telemetry|analytics|metrics|collect)(\/|$)/;
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : scrub(v)]));
  }
  return value;
}

function redact(text) {
  if (text == null) return null;
  const s = String(text);
  try {
    return JSON.stringify(scrub(JSON.parse(s)), null, 2);
  } catch {
    // Not JSON (EPCIS XML, form data, plain text): blank key=value and "key":"value" secrets.
    return s
      .replace(/("(?:[^"]*(?:pass(?:word)?|token|secret|api[-_]?key)[^"]*)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
      .replace(/((?:pass(?:word)?|token|secret|api[-_]?key)=)[^&\s]*/gi, '$1[redacted]');
  }
}

const clip = (s) => (s && s.length > MAX_BODY ? `${s.slice(0, MAX_BODY)}\n… (${s.length - MAX_BODY} more characters not recorded)` : s);

function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (SECRET_KEY.test(k)) u.searchParams.set(k, '[redacted]');
    return u.href;
  } catch {
    return raw;
  }
}

let count = new WeakMap();

/** Attaches one request/response pair to the running test. A no-op outside a test. */
async function recordExchange({ label, method = 'POST', url, status = null, ok, contentType, requestBody, responseBody, durationMs = null }) {
  let info;
  try {
    info = test.info();
  } catch {
    return;
  }
  const n = count.get(info) || 0;
  if (n >= MAX_EXCHANGES) return;
  count.set(info, n + 1);
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  const entry = {
    variant: label || `${method} ${path}`,
    method,
    url: cleanUrl(url),
    status,
    ok: ok ?? (status != null && status < 400),
    contentType: contentType || null,
    requestBody: clip(redact(requestBody)),
    responseBody: clip(redact(responseBody)),
    durationMs,
  };
  await info.attach('exchange', { body: JSON.stringify(entry), contentType: 'application/json' });
}

/**
 * Starts recording the data-changing API calls a page (and its context) makes. Returns a
 * function that stops recording and attaches what was seen; call it before the test ends.
 */
function captureBrowserCalls(page) {
  const context = page.context();
  const pending = [];
  const onFinished = (req) => {
    const method = req.method();
    if (READ_ONLY.has(method)) return;
    let path;
    try {
      path = new URL(req.url()).pathname;
    } catch {
      return;
    }
    if (!path.startsWith('/api/') || SKIP_PATH.test(path)) return;
    pending.push(
      (async () => {
        const res = await req.response();
        let body = null;
        try {
          body = res ? await res.text() : null;
        } catch {
          // body no longer available (navigation) - recorded without it
        }
        const t = req.timing();
        return {
          method,
          url: req.url(),
          status: res ? res.status() : null,
          contentType: req.headers()['content-type'],
          requestBody: req.postData(),
          responseBody: body,
          durationMs: t.responseEnd > 0 ? Math.round(t.responseEnd) : null,
        };
      })().catch(() => null)
    );
  };
  context.on('requestfinished', onFinished);
  return async () => {
    context.off('requestfinished', onFinished);
    const settled = await Promise.race([
      Promise.all(pending),
      new Promise((resolve) => setTimeout(() => resolve([]), 5_000)),
    ]);
    for (const e of settled) if (e) await recordExchange(e);
  };
}

module.exports = { recordExchange, captureBrowserCalls };
