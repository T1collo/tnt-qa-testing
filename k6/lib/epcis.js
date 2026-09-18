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
export function newRunId() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function commissionPayload(runId, vu, iter) {
  const now = new Date().toISOString();
  const uniqueSuffix = `${vu}-${iter}`;
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
          eventID: `urn:uuid:loadtest-${runId}-${uniqueSuffix}`,
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
          eventID: `urn:uuid:loadtest-${runId}-${vu}-${iter}`,
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
