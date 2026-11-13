// Shared EPCIS payload building, used by every k6 script in this suite so the
// known-working identifier shape only has to be correct in one place.
//
// Background: the Postman collection's own Commission example uses a GLN
// (10000000.00009.0) and GTIN prefix (6161102974997) that crash the commissioning
// endpoint with a bare 500 - confirmed via isolation testing on 2026-09-02. The
// 0123456 company prefix / numeric-serial shape below is confirmed working against
// the live sandbox (https://tnt-demo.apeiro-digital.com): HTTP 202,
// {"success": true, ...}, only soft UNKNOWN_SGLN/INVALID_LOT warnings.

// Unique across VUs, iterations, and separate runs against the same shared sandbox -
// avoids colliding with a prior run's eventIDs/serials, which the API hard-rejects as
// duplicates (see API-MFG-COMM-EDGE-001 in the QA workbook).
// 15 hex chars (ms timestamp + random) so it can seed the UUID groups below.
export function newRunId() {
  const rand = Math.floor(Math.random() * 0x1000).toString(16).padStart(3, '0');
  return `${Date.now().toString(16).padStart(12, '0')}${rand}`;
}

// The eventID every payload builder stamps on its event - exported so the data-integrity
// script can know what ID to expect back without re-parsing the payload. The API requires a
// strict UUID URN (400 INVALID_JSON_STRUCTURE otherwise), so run/VU/iteration are packed into
// a v4-shaped UUID: run id in groups 1, 2 and 4, VU in group 3, iteration in group 5.
export function loadtestEventId(runId, vu, iter) {
  const hex = (n, len) => n.toString(16).padStart(len, '0');
  return `urn:uuid:${runId.slice(0, 8)}-${runId.slice(8, 12)}-4${hex(vu, 3)}-8${runId.slice(12, 15)}-${hex(iter, 12)}`;
}

export function commissionPayload(runId, vu, iter) {
  const now = new Date().toISOString();
  const numericSerial = `${Date.now()}${vu}${iter}`.slice(-15);
  return JSON.stringify({
    '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: now,
    epcisBody: {
      eventList: [
        {
          type: 'ObjectEvent',
          eventID: loadtestEventId(runId, vu, iter),
          eventTime: now,
          eventTimeZoneOffset: '+03:00',
          epcList: [`urn:epc:id:sgtin:0123456.305512.${numericSerial}`],
          action: 'ADD',
          bizStep: 'commissioning',
          disposition: 'active',
          readPoint: { id: 'urn:epc:id:sgln:0123456.22222.0' },
          bizLocation: { id: 'urn:epc:id:sgln:0123456.22222.0' },
          ilmd: {
            'cbvmda:lotNumber': `LOADTEST-${runId}`,
            'cbvmda:itemExpirationDate': '2028-01-01',
          },
        },
      ],
    },
  });
}

export function authHeaders(apiToken) {
  return {
    'Content-Type': 'application/ld+json',
    'X-API-Key': apiToken,
  };
}

// Distributor/facility receiving events. The SSCC serial is randomised per call
// because the API deduplicates on a content hash (EPC+bizStep+disposition+readPoint)
// as well as on eventID - a fixed SSCC would 409 from the second request onward and
// the run would measure duplicate-rejection, not ingestion.
export function receivePayload(runId, vu, iter, kind) {
  const now = new Date().toISOString();
  const prefix = kind === 'facility' ? '0619999' : '0614141';
  const loc = kind === 'facility' ? '0618888.00001.0' : '0619999.00002.0';
  const serial = `${Date.now()}${vu}${iter}`.slice(-10);
  return JSON.stringify({
    '@context': ['https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld'],
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: now,
    epcisBody: {
      eventList: [
        {
          type: 'ObjectEvent',
          eventID: loadtestEventId(runId, vu, iter),
          eventTime: now,
          eventTimeZoneOffset: '+00:00',
          action: 'OBSERVE',
          bizStep: 'receiving',
          disposition: 'active',
          epcList: [`urn:epc:id:sscc:${prefix}.${serial}`],
          readPoint: { id: `urn:epc:id:sgln:${loc}` },
          bizLocation: { id: `urn:epc:id:sgln:${loc}` },
        },
      ],
    },
  });
}

// Partner roles and what each one sends. The supplier route is the distributor's
// integration surface, hence DISTRIBUTOR_API_TOKEN (same names as .env).
const ROLES = {
  manufacturer: { tokenEnv: 'MANUFACTURER_API_TOKEN', tag: 'commission' },
  supplier: { tokenEnv: 'DISTRIBUTOR_API_TOKEN', tag: 'receive' },
  facility: { tokenEnv: 'FACILITY_API_TOKEN', tag: 'receive' },
};

// Resolves -e ROLE=manufacturer|supplier|facility (default manufacturer) into the route,
// token and payload builder for that role. -e API_TOKEN overrides the role's own token
// variable, so one-off keys can be passed without touching .env names.
export function roleTarget(env, baseUrl) {
  const role = env.ROLE || 'manufacturer';
  const cfg = ROLES[role];
  if (!cfg) {
    throw new Error(`Unknown ROLE "${role}" - expected one of: ${Object.keys(ROLES).join(', ')}`);
  }
  const token = env.API_TOKEN || env[cfg.tokenEnv];
  if (!token) {
    throw new Error(`${cfg.tokenEnv} (or API_TOKEN) is required for ROLE=${role}, e.g. -e ${cfg.tokenEnv}=xxx`);
  }
  return {
    role,
    url: `${baseUrl}/api/integration/${role}/events`,
    token,
    tag: cfg.tag,
    payload: (runId, vu, iter) =>
      role === 'manufacturer' ? commissionPayload(runId, vu, iter) : receivePayload(runId, vu, iter, role),
  };
}

// Tracking output read by the dashboard's k6 runner (plain `k6 run` just prints it):
//   SENT <eventID> <EPC> <status>   - every request, so each event can be traced afterwards
//   SAMPLE {json}                   - the whole request and response, for the first request
//                                     and the first few failures of each VU
// Module state is per VU (each VU has its own JS runtime), so the caps are per VU.
const MAX_FAILURE_SAMPLES_PER_VU = 2;
let failureSamples = 0;

export function track(res, payload, eventId, url) {
  let epc = '-';
  try {
    epc = JSON.parse(payload).epcisBody.eventList[0].epcList[0];
  } catch {
    // not an EPCIS document we built - leave the EPC out
  }
  console.log(`SENT ${eventId} ${epc} ${res.status}`);
  const failed = res.status !== 201 && res.status !== 202;
  const first = __VU === 1 && __ITER === 0;
  if (!first && !(failed && failureSamples < MAX_FAILURE_SAMPLES_PER_VU)) return;
  if (failed) failureSamples += 1;
  console.log(
    `SAMPLE ${JSON.stringify({ eventId, epc, url, status: res.status, durationMs: Math.round(res.timings.duration), request: payload, response: res.body })}`
  );
}
