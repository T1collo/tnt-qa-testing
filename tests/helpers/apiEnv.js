// Partner-API access for the environment under test (BASE_URL). The EPCIS endpoints live at
// the host root on both environments; keys are environment-specific (a tnt-demo key is
// rejected by TrackIQ and vice versa), so each role's key is chosen to match.
const { isTrackiq, baseUrl } = require('./auth');

const ENDPOINT_PATHS = {
  manufacturer: '/api/integration/manufacturer/events',
  distributor: '/api/integration/supplier/events',
  facility: '/api/integration/facility/events',
  dispense: '/api/integration/facility/events/dispense',
};

function apiKey(role) {
  const env = process.env;
  const name = { manufacturer: 'MANUFACTURER', distributor: 'DISTRIBUTOR', facility: 'FACILITY', dispense: 'FACILITY' }[role];
  return isTrackiq() ? env[`TRACKIQ_${name}_API_TOKEN`] : env[`${name}_API_TOKEN`];
}

const endpoint = (role) => `${baseUrl()}${ENDPOINT_PATHS[role]}`;

// POSTs an EPCIS document (JSON-LD object/string or XML string) as `role`.
// Returns { status, json, text, warnings: [codes] }.
async function postEvent(role, body, format = typeof body === 'string' && body.trimStart().startsWith('<') ? 'xml' : 'json') {
  const res = await fetch(endpoint(role), {
    method: 'POST',
    headers: {
      'Content-Type': format === 'xml' ? 'application/xml' : 'application/ld+json',
      'X-API-Key': apiKey(role),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  const warnings = (json?.warnings || []).map((w) => w.code).filter(Boolean);
  return { status: res.status, json, text, warnings, code: json?.code || null };
}

module.exports = { apiKey, endpoint, postEvent, ENDPOINT_PATHS };
