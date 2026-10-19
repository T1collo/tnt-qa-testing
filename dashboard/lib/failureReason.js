// Turns a failure into one plain-English sentence for the workbook's COMMENTS column and the
// run views ("why did this fail?"), while the exact observed result goes to Actual Result.
//
// Sources, in order of preference:
//   1. a reason the test wrote itself (Playwright annotation type "reason")
//   2. the assertion / timeout error Playwright raised, translated
//   3. for API steps, the platform's response (status, code, message)

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => String(s ?? '').replace(ANSI, '');
const oneLine = (s) => stripAnsi(s).replace(/\s+/g, ' ').trim();
const clip = (s, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const seconds = (ms) => {
  const n = Number(ms);
  return Number.isFinite(n) ? `${Math.round(n / 100) / 10} s` : 'the time allowed';
};
const sentence = (s) => {
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return t;
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(cap) ? cap : `${cap}.`;
};

// getByRole('button', { name: 'Sign In' }) -> the "Sign In" button
function describeLocator(raw) {
  const loc = stripAnsi(raw).trim();
  let m = loc.match(/getByRole\('([^']+)'(?:,\s*\{\s*name:\s*(?:'([^']*)'|\/(.*?)\/[a-z]*)[^}]*\})?\)/);
  if (m) return m[2] || m[3] ? `the "${m[2] || m[3]}" ${m[1]}` : `the ${m[1]}`;
  m = loc.match(/getByText\((?:'([^']*)'|\/(.*?)\/[a-z]*)/);
  if (m) return `the text "${m[1] || m[2]}"`;
  m = loc.match(/getByPlaceholder\((?:'([^']*)'|\/(.*?)\/[a-z]*)/);
  if (m) return `the "${m[1] || m[2]}" field`;
  m = loc.match(/getByLabel\((?:'([^']*)'|\/(.*?)\/[a-z]*)/);
  if (m) return `the field labelled "${m[1] || m[2]}"`;
  m = loc.match(/locator\('([^']*)'\)/);
  if (m) return `the page element "${m[1]}"`;
  return loc ? `"${clip(loc, 80)}"` : 'the page element';
}

const ACTION_WORD = {
  click: 'click', fill: 'type into', selectOption: 'choose an option in', check: 'tick',
  uncheck: 'untick', hover: 'hover over', press: 'press a key in', setInputFiles: 'attach a file to',
  waitFor: 'find', textContent: 'read', innerText: 'read', inputValue: 'read',
};

// The exact values an assertion compared, from Playwright's message.
function comparedValues(text) {
  const pick = (label) => {
    const m = text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, 'mi'));
    return m ? m[1].trim() : null;
  };
  return {
    expected: pick('Expected(?: value| pattern| substring| string)?'),
    received: pick('Received(?: value| string| array| object)?'),
    locator: pick('Locator'),
    timeout: pick('Timeout'),
  };
}

// Plain-English reason for a failed Playwright test.
function reasonFromTestError(errorText) {
  const text = stripAnsi(errorText);
  if (!text.trim()) return 'The test failed without reporting a reason.';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0].replace(/^(Error|TimeoutError|AssertionError):\s*/, '');

  if (/Test timeout of (\d+)ms exceeded/.test(text)) {
    const ms = text.match(/Test timeout of (\d+)ms/)[1];
    return `The test ran out of time (${seconds(ms)}) before it finished - the page or the API never reached the expected state.`;
  }

  // A locator action that timed out: "locator.click: Timeout 15000ms exceeded" + "waiting for …"
  const act = first.match(/locator\.(\w+): Timeout (\d+)ms exceeded/);
  if (act) {
    const waiting = text.match(/waiting for (.+)/);
    const target = waiting ? describeLocator(waiting[1]) : 'the page element';
    const notEnabled = /element is not enabled/.test(text);
    const notVisible = /element is not visible/.test(text);
    const verb = ACTION_WORD[act[1]] || act[1];
    const why = notEnabled ? 'it stayed disabled' : notVisible ? 'it stayed hidden' : 'it never appeared on the page';
    return `Could not ${verb} ${target} - ${why} (waited ${seconds(act[2])}).`;
  }

  if (/net::ERR_|page\.goto:/.test(first)) return `The page could not be opened: ${clip(oneLine(first))}.`;

  const { expected, received, locator, timeout } = comparedValues(text);
  // The author's own message comes first when they gave one ("Error: <message>\n\nexpect(...)").
  const custom = /^expect\(/.test(first) ? null : first;
  const isLocatorCheck = /expect\(locator\)\.(\w+)/.exec(text);

  if (isLocatorCheck) {
    const what = locator ? describeLocator(locator) : 'the page element';
    const check = isLocatorCheck[1].replace(/^to/, '').replace(/([A-Z])/g, ' $1').trim().toLowerCase();
    const notFound = received && /element\(s\) not found/.test(received);
    const got = notFound ? '' : received ? ` - found: ${clip(received.replace(/[<>]/g, ''), 120)}` : '';
    const waited = timeout ? ` (waited ${seconds(String(timeout).replace(/ms$/, ''))})` : '';
    const lead = custom ? `${custom} - ` : '';
    return sentence(`${lead}expected ${what} to ${check.startsWith('be') || check.startsWith('have') || check.startsWith('contain') ? check : `be ${check}`}${expected && !/^(visible|hidden|enabled|disabled|checked)$/.test(expected) ? ` (${clip(expected, 80)})` : ''}, but ${notFound ? 'it was not found on the page' : `it was not${got}`}${waited}`);
  }

  if (expected !== null || received !== null) {
    const lead = custom ? `${custom} - ` : 'The check ';
    if (/Expected substring|Expected pattern/i.test(text)) {
      return sentence(`${lead}expected the text to contain ${clip(expected || '', 80)}, but it was ${clip(received || 'empty', 140)}`);
    }
    if (/Received array/i.test(text)) {
      return sentence(`${lead}expected ${clip(expected || '', 80)} in the list, but the list was ${clip(received || '[]', 140)}`);
    }
    if (/not\./.test(first) || /Expected: not /.test(text)) {
      return sentence(`${lead}expected anything except ${clip((expected || '').replace(/^not\s+/, ''), 80)}, but got exactly that`);
    }
    // toBeTruthy()/toBeFalsy() print only one side; never show a placeholder for the missing one.
    if (expected === null) return sentence(`${custom ? `${custom} - ` : ''}the system gave ${clip(received, 140)}`);
    if (received === null) return sentence(`${lead}expected ${clip(expected, 100)}, but nothing was returned`);
    return sentence(`${lead}expected ${clip(expected, 100)}, but the system gave ${clip(received, 140)}`);
  }

  return sentence(clip(oneLine(custom || first), 260));
}

// The exact outcome a failed test saw, for Actual Result when the test recorded none itself.
function actualFromTestError(errorText) {
  const text = stripAnsi(errorText);
  const timedOut = text.match(/Test timeout of (\d+)ms exceeded/);
  if (timedOut) return `The test did not finish within ${seconds(timedOut[1])}`;
  const act = text.match(/locator\.(\w+): Timeout (\d+)ms exceeded/);
  if (act) {
    const waiting = text.match(/waiting for (.+)/);
    const state = /element is not enabled/.test(text) ? ' (present but disabled)' : /element is not visible/.test(text) ? ' (present but hidden)' : ' (never appeared)';
    return `Timed out after ${seconds(act[2])} waiting to ${ACTION_WORD[act[1]] || act[1]} ${waiting ? describeLocator(waiting[1]) : 'the page element'}${state}`;
  }
  const { expected, received, locator } = comparedValues(text);
  if (received === null && expected && /^not /.test(expected)) return `Received ${clip(expected.replace(/^not\s+/, ''), 150)} (expected anything else)`;
  if (received !== null) {
    return `Received ${clip(received, 300)}${expected !== null ? ` (expected ${clip(expected, 150)})` : ''}${locator ? ` on ${describeLocator(locator)}` : ''}`;
  }
  const first = (text.split('\n').find((l) => l.trim()) || '').trim();
  return clip(oneLine(first), 400) || 'No result was captured';
}

const CODE_MEANING = {
  DUPLICATE_EVENT_PAYLOAD: 'this exact event had already been recorded',
  DUPLICATE_EVENT_ID: 'this event ID had already been used',
  INVALID_JSON_STRUCTURE: 'the document did not match the EPCIS format TrackIQ expects',
  INVALID_XML_STRUCTURE: 'the XML document did not match the EPCIS format TrackIQ expects',
  INVALID_GS1_IDENTIFIER: 'an identifier (SGTIN/SSCC/GLN) is not a valid GS1 code',
  MISSING_NEEDED_FIELDS: 'a required field was missing',
  PARTNER_TYPE_BIZSTEP_MISMATCH: 'this partner role is not allowed to send this kind of event',
  ERROR_DECLARATION_ORIGINAL_NOT_FOUND: 'the event being corrected could not be found',
  ERROR_DECLARATION_CORRECTIVE_NOT_FOUND: 'the corrective event it points to could not be found',
};

// Plain-English reason for a failed API step (one format of one event).
function reasonFromApiResponse(variant = {}) {
  const fmt = variant.variant && variant.variant !== 'UI' ? `${variant.variant} ` : '';
  if (variant.error && !variant.status) return `The ${fmt}request never reached the platform (network error: ${clip(oneLine(variant.error), 120)}).`;
  let body = null;
  try {
    body = JSON.parse(variant.responseBody || '');
  } catch {
    body = null;
  }
  const status = variant.status;
  const code = body?.code;
  const message = body?.message ? clip(oneLine(body.message), 160) : '';
  if (status >= 200 && status < 300) {
    return `The platform accepted the ${fmt}submission (HTTP ${status}), but the test expected it to be refused or flagged.`;
  }
  const meaning = code && CODE_MEANING[code];
  const generic =
    status === 401 ? 'the API key was not accepted'
      : status === 403 ? 'the key or account is not allowed to do this'
        : status === 404 ? 'the address does not exist'
          : status === 409 ? 'it conflicts with something already recorded'
            : status === 413 ? 'the document is too large'
              : status === 429 ? 'too many requests were sent (rate limited)'
                : status >= 500 ? 'the platform had an internal server error'
                  : 'the platform refused it';
  return sentence(`The platform rejected the ${fmt}submission with HTTP ${status ?? '?'}${code ? ` ${code}` : ''}${message ? ` ("${message}")` : ''} - ${meaning || generic}`);
}

// The reason for a whole failed result: the test's own, else from its error, else from the
// first failing API variant.
function reasonForResult(result = {}) {
  if (result.reason) return sentence(result.reason);
  const variants = result.variants || [];
  const ui = variants.find((v) => v.method === 'UI');
  if (ui) {
    if (ui.reason) return sentence(ui.reason);
    return reasonFromTestError(ui.errorDetail || ui.error || result.error);
  }
  const failing = variants.filter((v) => !v.ok);
  if (failing.length) return failing.map(reasonFromApiResponse).join(' ');
  if (result.error) return sentence(clip(oneLine(result.error), 260));
  return 'The step did not reach the expected outcome.';
}

module.exports = { reasonFromTestError, actualFromTestError, reasonFromApiResponse, reasonForResult, stripAnsi };
