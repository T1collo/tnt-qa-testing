// Calls made on workbook cases that are deliberately not automated, with the reason. Applied to
// every generated workbook (all-runs export, single-run export, daily sheet), so the row
// carries the decision rather than a bare NOT TESTED. Cases that were decided and automated
// are not listed here - their tests record their own results.
//
// Decided 2026-10-19 (the QA owner asked for a call on each N/A / PENDING / NEEDS
// CONFIRMATION row):
//   TL-1659-TC04          automated (CSV upload latency, tests/portal/manufacturer-batches.spec.js)
//   API-MFG-COMM-EDGE-002 automated in its representable form (tests/api/epcis-edge.spec.js)
//   API-SPEC-STATUS-009   automated against the partner docs' Export event (tests/api/epcis-edge.spec.js)
//   API-SPEC-APPR-004     not automated - below
//   API-SPEC-RET-005      not automated - below
const CASE_DECISIONS = {
  'API-SPEC-APPR-004': {
    status: 'NOT TESTED',
    actual:
      'Not applicable - regulator approval is not an EPCIS event: it is made through the regulator portal (POST /api/regulator/package-approval), which has no bizTransactionList to omit. The approval itself is covered by API-SPEC-APPR-001.',
    decision: 'Decision 2026-10-19: retired as not applicable; no test can exercise it.',
  },
  'API-SPEC-RET-005': {
    status: 'NOT TESTED',
    actual:
      'Not tested - "left indefinitely in returned" has no defined time limit, so there is nothing to assert. Needs the product owner to define the threshold (e.g. N days); it then becomes a scheduled check that creates a return and looks for the flag after that time.',
    decision: 'Decision 2026-10-19: on hold until the threshold is defined.',
  },
};

module.exports = { CASE_DECISIONS };
