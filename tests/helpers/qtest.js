// Wraps Playwright's test() to tag the test with its QA workbook Test ID via
// test.info().annotations, so the JSON reporter output (test-results/results.json)
// carries the ID the dashboard needs to map a result back to a workbook row.
//
// Playwright decides which fixtures to inject by statically reading the destructured
// parameter names off the function passed directly to test() - a generic (args) => fn(args)
// wrapper hides that from it and every fixture comes back undefined. So this wrapper
// destructures the fixtures itself and forwards them; add any further fixture here too.
const { test } = require('@playwright/test');

// The ID is a static annotation, so a test skipped before its body runs (a serial chain
// stopping after a failure) still reports which workbook row it belongs to.
function qtest(id, title, fn) {
  test(title, { annotation: { type: 'testId', description: id } }, async ({ page, browser, request }) => {
    return fn({ page, browser, request });
  });
}

/** Stable workbook ID for a page-inventory check, e.g. ('admin', '/regulator/journey') -> SMOKE-ADMIN-REGULATOR-JOURNEY. */
const pageTestId = (role, path) =>
  `SMOKE-${role}-${path.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-')}`.toUpperCase().replace(/-+$/, '');

module.exports = { qtest, pageTestId };
