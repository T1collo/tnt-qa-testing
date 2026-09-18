// Wraps Playwright's test() to tag the test with its QA workbook Test ID via
// test.info().annotations, so the JSON reporter output (test-results/results.json)
// carries the ID the dashboard needs to map a result back to a workbook row.
//
// Playwright decides which fixtures to inject by statically reading the destructured
// parameter names off the function passed directly to test() - a generic (args) => fn(args)
// wrapper hides that from it and every fixture comes back undefined. So this wrapper
// destructures { page } itself and forwards it; if a test ever needs other fixtures
// (context, request, ...) add them here too.
const { test } = require('@playwright/test');

function qtest(id, title, fn) {
  test(title, async ({ page }) => {
    test.info().annotations.push({ type: 'testId', description: id });
    return fn({ page });
  });
}

module.exports = { qtest };
