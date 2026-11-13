# BUG: Duplicate serials in one batch cause HTTP 500 instead of a validation message

| | |
|---|---|
| **Area** | Manufacturer portal › Production › Batches › Create Batch |
| **Endpoint** | `POST /api/manufacturer/batches` |
| **Test case** | MFG-BATCH-EDGE-007 (`tests/portal/manufacturer-batches.spec.js`) |
| **Reproduced** | 2026-10-19 on **tnt-demo** (`https://tnt-demo.apeiro-digital.com`) and **TrackIQ** (`https://trackiq.apeiro-digital.com`), manufacturer `test-manufacturer@pharma.ke`. 9 of 9 attempts returned 500 (UI, direct API, Postman) |
| **Severity** | Medium. Bad input is not saved, but the user gets a generic server error and no hint which serial is the problem |

## Steps (UI)
1. Sign in as the manufacturer, open **Production › Batches**, click **Create Batch**.
2. Product **Telmicos 40 mg Oral Tablet**, any package, expiry two years out, batch number blank.
3. Serial numbers: `DUPMVEZMSAX, DUPMVEZMSAX` (the same value twice).
4. Click **Create Batch**.

**Expected:** 4xx validation error that names the repeated serial, e.g. *"Duplicate serial number DUPMVEZMSAX in this batch"*, or the form blocks the submit before sending.
**Actual:** HTTP 500 `{"statusCode":500,"message":"Internal server error"}`, shown as a toast and inline as **"Error 500: Internal server error"** (`evidence/tnt-demo-ui-create-batch-500.png`, `evidence/trackiq-ui-create-batch-500.png`). The form shows "2 serial numbers entered" with no duplicate warning.

## Exact request
```http
POST /api/manufacturer/batches
Content-Type: application/json
Cookie: __Secure-trackiq_user_prod.session_token=<session>

{"product_id":3449,"package_id":5012,"expiry":"2028-10-18","qty":2,"serial_numbers":["DUPMVEZMSAX","DUPMVEZMSAX"]}
```
Response `500`. TrackIQ `x-request-id: 9ad06d16-1ea3-418a-844d-51487884e869` (`x-apisix-upstream-status: 500`, so the error comes from the backend, not the gateway). tnt-demo `x-request-id: a6a27fa8-03bb-4878-9e95-90ed5108298b`.

The duplicate does not have to be next to its pair: `["…A","…B","…A"]` also returns 500. All request IDs, for log lookup, are in `evidence/api-replay-2026-10-19.txt`.

## Recreate it
Every run uses new `DUP<timestamp>` serials, so earlier runs never get in the way. The duplicate requests create nothing. Only the optional control request creates a batch.

**Postman / newman:** `duplicate-serials-500.postman_collection.json`
- Set `session_cookie` to `__Secure-trackiq_user_prod.session_token=<value>` (DevTools › Application › Cookies; the same cookie name is used on both environments), and `base_url` to the environment under test (default TrackIQ).
- Requests 1–2 FAIL their tests while the bug is present. Request 3 is the control: it creates a batch to show the payload is otherwise valid, so destroy that batch afterwards.
```bash
newman run duplicate-serials-500.postman_collection.json --env-var "session_cookie=<name=value>" \
  --folder "1. Duplicate serial, adjacent (A, A) - expect 4xx" --folder "2. Duplicate serial, non-adjacent (A, B, A) - expect 4xx"
```

**Node, API only:** `repro-api.mjs` (exits 1 while the bug is present)
```bash
BASE_URL=https://trackiq.apeiro-digital.com SESSION_COOKIE="<name=value>" node repro-api.mjs
# or, from the qa-testing-suite root, with a saved Playwright session:
SESSION_FILE=playwright/.auth/portal-trackiq.apeiro-digital.com-manufacturer.json node bug-repros/duplicate-serials-500/repro-api.mjs
```

**Playwright, through the UI:** `repro-ui.cjs` (run from inside qa-testing-suite; writes the captured request, response and a screenshot to `evidence/`)
```bash
CAP_BASE=https://trackiq.apeiro-digital.com CAP_SESSION=portal-trackiq.apeiro-digital.com-manufacturer.json node bug-repros/duplicate-serials-500/repro-ui.cjs
```

## Other environments
On tnt-demo and TrackIQ, `product_id` 3449 / `package_id` 5012 is Telmicos 40 mg, so the defaults work on both. On any other environment, open DevTools › Network, submit a Create Batch, and copy both IDs from the request body.

## Likely cause
The 500 looks like a unique constraint on the serial (GTIN + serial) firing when the batch's serials are inserted, with the database error not mapped to a 4xx. Suggested fix: check `serial_numbers` for repeats before inserting and return 400 listing them, and add the same check to the Create Batch form.
