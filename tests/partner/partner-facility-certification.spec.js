// TL-1596 Facility certification, checked end to end against the TrackIQ partner portal.
//
// Each case submits its event in BOTH formats (EPCIS 2.0 JSON-LD and EPCIS 1.2 XML - the
// portal accepts either for a case), then proves in the portal that:
//   1. API Logs lists each submitted eventID with the expected outcome, and
//   2. the Certification case reads Passed and its attempt count rose by this run's
//      submissions.
//
// Expectations follow the live certification cases (/partners/certification), which differ
// from two workbook rows: dispensing answers 201 (not 200), and an unknown SGTIN at
// dispensing is accepted with an UNKNOWN_SGTIN warning (not rejected with 422).
const { test, expect } = require('@playwright/test');
const { qtest } = require('../helpers/qtest');
const {
  ENDPOINTS,
  FACILITY_KEY,
  buildEvent,
  submit,
  certificationStatus,
  stepOf,
  waitForAttempts,
  expectInApiLogs,
  expectCasePassed,
} = require('./partner-helpers');

const VARIANTS = ['JSON-LD', 'XML'];

const CASES = [
  { id: 'TL-1596-FAC-TC01', stepId: 'fac_recv_valid', title: '3.3.1 Receiving - inbound SSCC from distributor', path: ['Facility Events', 'Receive (ObjectEvent)'], endpoint: ENDPOINTS.facility, status: 202, logOutcome: 'Accepted' },
  { id: 'TL-1596-FAC-TC02', stepId: 'fac_dispense_valid', title: '3.3.2 Dispensing - dispense serialized medicine', path: ['Facility Events', 'Dispense (ObjectEvent - SGTIN only)'], endpoint: ENDPOINTS.dispense, status: 201, logOutcome: 'Stored' },
  { id: 'TL-1596-FAC-TC03', stepId: 'fac_dispense_unknown_serial', title: 'Error handling - dispensing an unknown SGTIN', path: ['Facility Events', 'Dispense (ObjectEvent - SGTIN only)'], endpoint: ENDPOINTS.dispense, status: 201, logOutcome: 'Stored', warning: 'UNKNOWN_SGTIN' },
  { id: 'TL-1596-FAC-TC04', stepId: 'fac_return_ship', title: '4.2.1 Return Shipping', path: ['Special Events', 'Facility', 'Return Shipping (shipping / returned)'], endpoint: ENDPOINTS.facility, status: 202, logOutcome: 'Accepted' },
  { id: 'TL-1596-FAC-TC05', stepId: 'fac_destroy', title: '4.3.2 Destruction Completion', path: ['Special Events', 'Facility', 'Destruction (destroying / destroyed)'], endpoint: ENDPOINTS.facility, status: 202, logOutcome: 'Accepted' },
  { id: 'TL-1596-FAC-TC06', stepId: 'fac_damaged', title: '4.4.1 Damaged', path: ['Special Events', 'Facility', 'Damaged (inspecting / damaged)'], endpoint: ENDPOINTS.facility, status: 202, logOutcome: 'Accepted' },
  { id: 'TL-1596-FAC-TC07', stepId: 'fac_stolen', title: '4.4.2.1 Stolen', path: ['Special Events', 'Facility', 'Stolen (decommissioning / stolen)'], endpoint: ENDPOINTS.facility, status: 202, logOutcome: 'Accepted' },
  { id: 'TL-1596-FAC-TC08', stepId: 'fac_lost', title: '4.4.2.2 Lost', path: ['Special Events', 'Facility', 'Lost (decommissioning / inactive)'], endpoint: ENDPOINTS.facility, status: 202, logOutcome: 'Accepted' },
  { id: 'TL-1596-FAC-TC09', stepId: 'fac_expired', title: '4.4.3 Expired', path: ['Special Events', 'Facility', 'Expired (inspecting / expired)'], endpoint: ENDPOINTS.facility, status: 202, logOutcome: 'Accepted' },
  { id: 'TL-1596-FAC-TC10', stepId: 'fac_stock_taking', title: '4.5 Inventory stock_taking', path: ['Special Events', 'Facility', 'Stock Taking (stock_taking / active)'], endpoint: ENDPOINTS.facility, status: 202, logOutcome: 'Accepted' },
];

test.describe('TL-1596 Facility certification (partner portal)', () => {
  test.beforeAll(() => {
    expect(FACILITY_KEY, 'TRACKIQ_FACILITY_API_TOKEN is missing from .env').toBeTruthy();
  });

  for (const c of CASES) {
    qtest(c.id, c.title, async ({ page }) => {
      test.setTimeout(150_000);
      const before = stepOf(await certificationStatus(page), c.stepId);
      const observed = [];
      // Recorded whether the case passes or fails, so the workbook shows what was seen.
      const record = () => test.info().annotations.push({ type: 'actual', description: observed.join('; ') });

      try {
        // 1. Submit in both formats through the partner API.
        const submitted = [];
        for (const variant of VARIANTS) {
          const event = buildEvent(c.path, variant);
          const res = await submit(c.endpoint, event);
          const warnings = (res.json?.warnings || []).map((w) => w.code);
          observed.push(`${variant}: HTTP ${res.status}${c.warning ? `, warnings [${warnings.join(', ')}]` : ''}`);
          expect(res.status, `${variant} submission: ${res.text.slice(0, 300)}`).toBe(c.status);
          if (c.warning) {
            expect(warnings, `${variant}: the portal case requires a ${c.warning} warning in the 201 response`).toContain(c.warning);
          }
          submitted.push({ variant, eventId: event.eventIds[0] });
        }

        // 2. API Logs lists each eventID with the expected outcome.
        for (const { eventId } of submitted) await expectInApiLogs(page, eventId, c.logOutcome);
        observed.push(`both eventIDs listed in API Logs as ${c.logOutcome}`);

        // 3. The certification case counted these submissions and reads Passed.
        const after = await waitForAttempts(page, c.stepId, before.attempts + submitted.length);
        expect(after.status).toBe('passed');
        await expectCasePassed(page, after.name);
        observed.push(`certification "${after.name}" Passed, attempts ${before.attempts} -> ${after.attempts}`);
      } finally {
        record();
      }
    });
  }
});
