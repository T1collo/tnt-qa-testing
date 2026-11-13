// Single source of truth mapping EPCIS Postman collection requests to their row in
// TnT_QA_Test_Cases_Re-Revised_Master.xlsx. Used by postmanRunner.js (to know which
// requests to fire for a role) AND rendered directly in the UI's Test Map tab as a
// reference/key - never duplicated, so the two can't drift apart.
//
// `path` walks the collection: [folder, subfolder?, requestName]. Requests are fired for
// both their JSON-LD and XML variants; the run result for a Test ID is the worst case
// (FAIL) across every request/variant that maps to it.

const ROLES = { MANUFACTURER: 'manufacturer', DISTRIBUTOR: 'distributor', FACILITY: 'facility' };

const TEST_ID_MAP = [
  // --- Manufacturer Events ---
  { testId: 'API-MFG-COMM-001', role: ROLES.MANUFACTURER, eventType: 'Commission', path: ['Manufacturer Events', 'Commission (ObjectEvent)'] },
  { testId: 'API-MFG-PACK-001', role: ROLES.MANUFACTURER, eventType: 'Pack', path: ['Manufacturer Events', 'Pack (AggregationEvent)'] },
  { testId: 'API-MFG-PACK-002', role: ROLES.MANUFACTURER, eventType: 'Pack SSCC into SSCC', path: ['Manufacturer Events', 'Pack SSCC into SSCC (AggregationEvent)'] },
  { testId: 'API-MFG-SHIP-001', role: ROLES.MANUFACTURER, eventType: 'Ship', path: ['Manufacturer Events', 'Ship (ObjectEvent)'] },

  // --- Distributor Events ---
  { testId: 'API-DIST-RECV-001', role: ROLES.DISTRIBUTOR, eventType: 'Receive', path: ['Distributor Events', 'Receive (ObjectEvent)'] },
  { testId: 'API-DIST-UNPACK-002', role: ROLES.DISTRIBUTOR, eventType: 'Unpack', path: ['Distributor Events', 'Unpack (AggregationEvent)'] },
  { testId: 'API-DIST-PACK-001', role: ROLES.DISTRIBUTOR, eventType: 'Pack', path: ['Distributor Events', 'Pack (AggregationEvent)'] },
  { testId: 'API-DIST-SHIP-001', role: ROLES.DISTRIBUTOR, eventType: 'Ship', path: ['Distributor Events', 'Ship (ObjectEvent)'] },

  // --- Facility Events ---
  { testId: 'API-FAC-RECV-001', role: ROLES.FACILITY, eventType: 'Receive', path: ['Facility Events', 'Receive (ObjectEvent)'] },
  { testId: 'API-FAC-UNPACK-002', role: ROLES.FACILITY, eventType: 'Unpack', path: ['Facility Events', 'Unpack (AggregationEvent)'] },
  { testId: 'API-FAC-DISP-001', role: ROLES.FACILITY, eventType: 'Dispense', path: ['Facility Events', 'Dispense (ObjectEvent - SGTIN only)'] },

  // --- Special Events > Manufacturer ---
  { testId: 'API-SPEC-RET-002', role: ROLES.MANUFACTURER, eventType: 'Return Receiving', path: ['Special Events', 'Manufacturer', 'Return Receiving (receiving / returned)'] },
  { testId: 'API-SPEC-RECALL-003', role: ROLES.MANUFACTURER, eventType: 'Destruction', path: ['Special Events', 'Manufacturer', 'Destruction (destroying / destroyed)'] },
  { testId: 'API-SPEC-STATUS-001', role: ROLES.MANUFACTURER, eventType: 'Damaged', path: ['Special Events', 'Manufacturer', 'Damaged (inspecting / damaged)'] },
  { testId: 'API-SPEC-STATUS-004', role: ROLES.MANUFACTURER, eventType: 'Stolen', path: ['Special Events', 'Manufacturer', 'Stolen (decommissioning / stolen)'] },
  { testId: 'API-SPEC-STATUS-005', role: ROLES.MANUFACTURER, eventType: 'Lost', path: ['Special Events', 'Manufacturer', 'Lost (decommissioning / inactive)'] },
  { testId: 'API-SPEC-STATUS-006', role: ROLES.MANUFACTURER, eventType: 'Expired', path: ['Special Events', 'Manufacturer', 'Expired (inspecting / expired)'] },

  // --- Special Events > Distributor ---
  { testId: 'API-SPEC-RET-001', role: ROLES.DISTRIBUTOR, eventType: 'Return Shipping', path: ['Special Events', 'Distributor', 'Return Shipping (shipping / returned)'] },
  { testId: 'API-SPEC-RET-002', role: ROLES.DISTRIBUTOR, eventType: 'Return Receiving', path: ['Special Events', 'Distributor', 'Return Receiving (receiving / returned)'] },
  { testId: 'API-SPEC-RECALL-003', role: ROLES.DISTRIBUTOR, eventType: 'Destruction', path: ['Special Events', 'Distributor', 'Destruction (destroying / destroyed)'] },
  { testId: 'API-SPEC-STATUS-001', role: ROLES.DISTRIBUTOR, eventType: 'Damaged', path: ['Special Events', 'Distributor', 'Damaged (inspecting / damaged)'] },
  { testId: 'API-SPEC-STATUS-004', role: ROLES.DISTRIBUTOR, eventType: 'Stolen', path: ['Special Events', 'Distributor', 'Stolen (decommissioning / stolen)'] },
  { testId: 'API-SPEC-STATUS-005', role: ROLES.DISTRIBUTOR, eventType: 'Lost', path: ['Special Events', 'Distributor', 'Lost (decommissioning / inactive)'] },
  { testId: 'API-SPEC-STATUS-006', role: ROLES.DISTRIBUTOR, eventType: 'Expired', path: ['Special Events', 'Distributor', 'Expired (inspecting / expired)'] },
  { testId: 'API-SPEC-INV-001', role: ROLES.DISTRIBUTOR, eventType: 'Stock Taking', path: ['Special Events', 'Distributor', 'Stock Taking (stock_taking / active)'] },

  // --- Special Events > Facility ---
  { testId: 'API-SPEC-RET-001', role: ROLES.FACILITY, eventType: 'Return Shipping', path: ['Special Events', 'Facility', 'Return Shipping (shipping / returned)'] },
  { testId: 'API-SPEC-RECALL-003', role: ROLES.FACILITY, eventType: 'Destruction', path: ['Special Events', 'Facility', 'Destruction (destroying / destroyed)'] },
  { testId: 'API-SPEC-STATUS-001', role: ROLES.FACILITY, eventType: 'Damaged', path: ['Special Events', 'Facility', 'Damaged (inspecting / damaged)'] },
  { testId: 'API-SPEC-STATUS-004', role: ROLES.FACILITY, eventType: 'Stolen', path: ['Special Events', 'Facility', 'Stolen (decommissioning / stolen)'] },
  { testId: 'API-SPEC-STATUS-005', role: ROLES.FACILITY, eventType: 'Lost', path: ['Special Events', 'Facility', 'Lost (decommissioning / inactive)'] },
  { testId: 'API-SPEC-STATUS-006', role: ROLES.FACILITY, eventType: 'Expired', path: ['Special Events', 'Facility', 'Expired (inspecting / expired)'] },
  { testId: 'API-SPEC-INV-001', role: ROLES.FACILITY, eventType: 'Stock Taking', path: ['Special Events', 'Facility', 'Stock Taking (stock_taking / active)'] },

  // --- Error Declaration ---
  { testId: 'ED-MFG-04-DNO', role: ROLES.MANUFACTURER, eventType: 'Error Declaration', path: ['Special Events', 'Error Declaration', 'Did Not Occur - void mistaken event (Manufacturer)'] },
  { testId: 'ED-MFG-04-INC', role: ROLES.MANUFACTURER, eventType: 'Error Declaration', path: ['Special Events', 'Error Declaration', 'Incorrect Data - with corrective event (Manufacturer)'] },
  { testId: 'ED-DIST-01-DNO', role: ROLES.DISTRIBUTOR, eventType: 'Error Declaration', path: ['Special Events', 'Error Declaration', 'Did Not Occur - void mistaken event (Distributor)'] },
  { testId: 'ED-FAC-03-DNO', role: ROLES.FACILITY, eventType: 'Error Declaration', path: ['Special Events', 'Error Declaration', 'Did Not Occur - void mistaken event (Facility)'] },
];

function forRole(role) {
  return TEST_ID_MAP.filter((m) => m.role === role);
}

function eventTypesForRole(role) {
  return [...new Set(forRole(role).map((m) => m.eventType))];
}

module.exports = { ROLES, TEST_ID_MAP, forRole, eventTypesForRole };
