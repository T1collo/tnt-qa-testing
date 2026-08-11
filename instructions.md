# TnT UAT — Automated Test Suite

Playwright end-to-end test suite covering login/RBAC, page-inventory smoke checks, and the full
manufacturer → distributor lifecycle (commission → pack → aggregate → approve → ship → receive)
against the TnT UAT demo environment.

## 1. Prerequisites

- Node.js 18+ and npm
- Access to the demo environment (`https://tnt-demo.apeiro-digital.com` by default)
- Valid credentials for each role you want to test with (admin/PPB, KEMSA/distributor,
  manufacturer), and/or partner API tokens if you extend the suite to hit the EPCIS API directly

## 2. Setup

```bash
npm install
npx playwright install --with-deps chromium
```

Copy the env template and fill in real values:

```bash
cp .env.example .env
```

`.env` fields:

| Variable | Purpose |
|---|---|
| `BASE_URL` | Demo environment base URL (defaults to `https://tnt-demo.apeiro-digital.com` if unset) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | PPB / Regulatory Authority login |
| `KEMSA_EMAIL` / `KEMSA_PASSWORD` | Distributor (KEMSA) login |
| `MANUFACTURER_EMAIL` / `MANUFACTURER_PASSWORD` | Manufacturer login |
| `MANUFACTURER_API_TOKEN` / `DISTRIBUTOR_API_TOKEN` / `FACILITY_API_TOKEN` | Partner API tokens (`X-API-Key` header), only needed if you write/run EPCIS API tests |

`.env` is gitignored — never commit it. If a role's credentials are missing, `auth.spec.js`
skips that role's test rather than failing.

## 3. Running the tests

```bash
npm test                 # full suite, headless
npm test -- --headed     # full suite, visible browser window
npm test -- --ui         # Playwright's interactive step-through UI

npm run test:smoke       # auth.spec.js + smoke.spec.js only
npm run test:lifecycle   # lifecycle.spec.js only (serial — mutates shared demo data)

npm run test:report      # open the HTML report from the last run
```

`lifecycle.spec.js` uses `test.describe.serial` and runs with `workers: 1` (see
`playwright.config.js`) because each step depends on state created by the previous one
(commission → pack → aggregate → approve → ship → receive) and everything shares the same
demo data. Don't try to parallelize it.

## 4. What's currently captured vs. not

By default (`playwright.config.js`):

- `screenshot: 'only-on-failure'`
- `video: 'retain-on-failure'`
- `trace: 'retain-on-failure'`

This means **a fully passing run produces no video or screenshots** — artifacts are only kept
for failing tests, and they land in Playwright's default `test-results/` folder (gitignored).

If you want proof/video of every run regardless of pass/fail, change in `playwright.config.js`:

```js
use: {
  video: 'on',
  screenshot: 'on',
  // ...
},
outputDir: './test-video',
```

## 5. Not yet built (flagging for whoever picks this up)

There is currently **no automated pipeline** that turns a test run into:

- a findings/summary Markdown doc, or
- an update to the QA test-case Excel workbook (`TnT_QA_Test_Cases_Re-Revised_Master.xlsx`,
  tracked separately, not in this repo)

Today that mapping is done by hand: read `test-results/results.json` after a run, cross-reference
each Playwright test title against the corresponding Test ID row in the workbook, and fill in
Actual Result / STATUS / COMMENTS manually.

To automate this cleanly, the spec files would need each `test(...)` tagged with its workbook
Test ID (e.g. via `test('MFG-SHIP-001: ...', ...)` or Playwright's `test.info().annotations`),
so a report generator can map JSON results back to workbook rows without a manual lookup step.
That tagging + generator script is the natural next piece of work here.

## 6. Test files

| File | Covers |
|---|---|
| `tests/auth.spec.js` | Login rejection (bad password/unknown email), valid login per role |
| `tests/smoke.spec.js` | Page-inventory per role, RBAC boundaries (e.g. admin blocked from Manufacturer module) |
| `tests/lifecycle.spec.js` | Full commission → pack → aggregate → approve → ship → receive flow |
| `tests/helpers/auth.js` | `loginAs(page, role)` helper, reads credentials from `.env` |
| `tests/helpers/datalog.js` | Shared helper for logging test data used during a run |
