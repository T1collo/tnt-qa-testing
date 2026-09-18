# TnT — Performance & Security Findings

**Target** `https://tnt-demo.apeiro-digital.com` (self-identifies as `_sandbox: true`)
**Date** 2026-09-03
**Scope** High-level performance and security pass over the Partner EPCIS ingestion API and the
public web routes. Partner tokens for manufacturer, distributor and facility were supplied by
the product owner; testing was authorised against this demo environment only.

Everything below was directly observed. Where something is inference rather than observation it
is labelled **Hypothesis** and kept separate from the evidence.

---

## 0. Before anything else — the base URL

The three supplied tokens were rejected at `https://tnt-demo.apeiro-digital.com/new/api/...`
with `Invalid API key for this environment`.

**The Partner API is served from the host root, not from `/new`.**

```
✅  https://tnt-demo.apeiro-digital.com/api/integration/manufacturer/events
❌  https://tnt-demo.apeiro-digital.com/new/api/integration/manufacturer/events
```

`/new` is a UI route that proxies to a **different backend environment** with a different key
store. Any test suite, Postman environment or load script pointed at `/new` will report
authentication failures that have nothing to do with the code under test. This cost the first
20 minutes of the session and is worth writing into the partner onboarding docs.

---

## 1. Findings summary

| # | Finding | Severity | Confidence |
|---|---|---|---|
| F1 | A gateway-timed-out batch **still completes in the background**; the client is told 504 for a request that succeeds, with no completion signal | 🟠 High | Confirmed |
| F2 | Ingestion throughput ceiling is ~15 events/s; **batching is slower, not faster** (~5 events/s) | 🟠 High | Confirmed |
| F3 | Unresolvable API keys return **500** instead of 401 | 🟠 High | Confirmed |
| F4 | The supplied **facility token does not work on this environment** at all | 🟠 High | Confirmed (cause unconfirmed) |
| F5 | Advertised rate limit (10,000/min) is ~11× higher than the system can actually serve | 🟠 High | Confirmed |
| F6 | Security headers are **absent from `/`, `/login` and `/scanner`** | 🟡 Medium | Confirmed |
| F7 | CORS reflects an arbitrary origin with `allow-credentials: true` | 🟡 Medium | Confirmed |
| F8 | **Backdated** event times are accepted without challenge (future-dated are rejected) | 🟡 Medium | Confirmed |
| F9 | Structurally invalid EPCs are accepted with only a soft warning | 🟡 Medium | Confirmed |
| F10 | Script payload in `lotNumber` is stored and echoed back unescaped | 🟡 Medium | Confirmed at API; UI unverified |
| F11 | `X-Powered-By: Express` disclosed | 🔵 Low | Confirmed |

**What passed, and it matters:** cross-partner authorization is solid (§3.1), duplicate-event
replay is rejected (§3.2), and the ingestion path held **0 % error rate** under sustained load.

---

## 2. Performance

### 2.1 Measured

| Test | Profile | Requests | Throughput | p95 | p99 | Errors |
|---|---|---|---|---|---|---|
| Load | 10 VUs, 90 s | 1,165 | **12.9 req/s** | 989 ms | 1.18 s | 0.00 % |
| Stress | ramp to 50 VUs, 2 m 30 s | 2,333 | **15.5 req/s** | 3.38 s | — | 0.00 % |

Web page delivery is fast and not a concern: TTFB 0.09–0.26 s across `/`, `/new`, `/login`,
`/scanner`, all HTTP 200, HTML prerendered and edge-cached.

### 2.2 F2 — the throughput ceiling

Raising concurrency 5× (10 → 50 VUs) bought **20 % more throughput and 3.4× worse latency**:

```
10 VUs → 12.9 req/s, p95 0.99 s
50 VUs → 15.5 req/s, p95 3.38 s
```

That is a queue, not a capacity increase. The endpoint is serialising work somewhere around
**13–16 events/s** and additional concurrency simply waits.

The obvious remedy is batching — many events per document. It does not work either:

| Events per document | Status | Elapsed | Effective rate |
|---|---|---|---|
| 1 | 202 | 0.5 s | 2.1 /s |
| 10 | 202 | 2.2 s | 4.5 /s |
| 50 | 202 | 9.1 s | 5.5 /s |
| 100 | 202 | 19.5 s | 5.1 /s |
| 250 | 202 | 49.0 s | 5.1 /s |
| 500 | 202 | 116.5 s | 4.3 /s |
| 1,000 | **504** | 120.6 s | — |

Batch processing is **linear at ~5 events/s** and gains nothing from batching. A hard
**120-second gateway timeout** caps any single document at roughly 500 events — and the 500-event
case completed at 116.5 s, four seconds inside the limit.

**Business impact.** Commissioning a 100,000-pack production run takes ≈ 1.9 hours via
concurrent single events, or ≈ 5.5 hours via batches. Both figures need a product decision
about whether they are acceptable before go-live.

> **Hypothesis (not confirmed):** the ~5/s batch rate and the ~15/s concurrent ceiling are close
> enough to suggest one shared serialised resource — a per-event synchronous validation or
> master-data lookup, executed in a loop rather than in bulk. Confirming this needs server-side
> profiling, which was out of scope.

### 2.3 F1 — a timed-out batch still completes, but the client is told it failed 🟠

> **Correction.** An earlier draft of this report recorded F1 as *partial commit / silent data
> loss* at Critical severity, based on a probe taken ~3 minutes after the timeout. A later probe
> disproved it. The corrected finding is below; the original evidence and why it misled are kept
> because the retraction is part of the result.

A 1,000-event document was submitted with deterministic event IDs. It returned **504 after
120.7 s**. Because the Partner API is POST-only with no read endpoint, the events were probed
afterwards by resubmitting individual IDs and reading the duplicate-detection response —
`409 DUPLICATE_EVENT_ID` means the event was already in the ledger, `202` means it was not.

**Probe at T+165 s** (45 s after the 504):

| Event | Result | Reading |
|---|---|---|
| #0, #1, #250, #500 | 409 `DUPLICATE_EVENT_ID` | already ingested |
| #999 | 202 accepted | not yet ingested |

**Probe at T+~15 min**, on six indices never touched before:

| Event | Result | Reading |
|---|---|---|
| #600, #700, #800, #900, #950, #998 | 409 `DUPLICATE_EVENT_ID` | already ingested |

```json
{"category":"DUPLICATE_EVENT_ID",
 "message":"Event ID urn:uuid:orphan-mtl5rq6i-650 was already ingested",
 "resolution":"This event_id has already been ingested. This is idempotent — no action needed."}
```

**Conclusion: nothing is lost.** The gateway gives up at 120 s but the backend keeps working and
finishes the batch. The first probe caught the job mid-flight, at a point somewhere past event
#500 but not yet at #999, and mistook "not written yet" for "never written".

What is actually wrong is still worth fixing:

- **The client is told its request failed when it eventually succeeds in full.** A 504 is an
  error response. A partner that trusts it believes 1,000 packs went uncommissioned when they
  are, in fact, recorded.
- **There is no completion signal, and no bound on completion time.** The batch was still in
  flight at T+165 s and done by T+15 min. The client cannot tell when — or whether — it finished,
  and has no endpoint to ask.
- **Reconciliation is only possible by abusing duplicate-detection**, which is what this test
  did. Probing with a real event ID writes it if absent, so the act of checking mutates the
  ledger. That is not something a partner should have to do in production.

**Mitigating factor, and it is a real one.** Retry is safe. Both `DUPLICATE_EVENT_ID` and
`DUPLICATE_EVENT_PAYLOAD` (§3.2) are enforced, so a partner that resubmits the whole batch —
with the original event IDs *or* with freshly generated ones — cannot double-write. The API even
returns the right guidance: *"This is idempotent — no action needed."* The dedup design is sound;
it is the 504 that misrepresents what happened.

**Recommended fix:** return `202 Accepted` with a job id the partner can poll, rather than
holding a synchronous connection open past the gateway timeout. Failing that, publish the
practical batch ceiling (~500 events, §2.2) so clients stay inside the 120 s window.

**Severity: High, not Critical** — misleading status and no completion signal, not data loss.

### 2.4 F5 — rate limit is unreachable

The API advertises its budget on every 202:

```http
x-ratelimit-limit: 10000
x-ratelimit-remaining: 9999
x-ratelimit-reset: 60
x-ratelimit-tier: manufacturer
```

10,000 per minute is **≈ 166 req/s**. Measured ceiling is ~15 req/s. The documented budget is
roughly **11× more than the system can serve**, so a client working within its stated allowance
will drive the endpoint into multi-second queuing and gateway timeouts and **never receive a
429**. The rate limiter offers no practical protection, and the published tier sets an
expectation the platform cannot meet. Either the limit or the capacity needs to change.

---

## 3. Security

Automated coverage: `node security/probe.mjs` → `security/results/probe-*.json`.

### 3.1 ✅ Cross-partner authorization — passed

Full 3×3 matrix, every token against every endpoint (status codes):

|  | `/manufacturer` | `/supplier` | `/facility` |
|---|---|---|---|
| **manufacturer token** | 202 ✅ | 403 ⛔ | 403 ⛔ |
| **distributor token** | 403 ⛔ | 202/409 ✅ | 403 ⛔ |
| **facility token** | 500 ⚠ | 500 ⚠ | 500 ⚠ |

Refusals are clean, specific and correctly typed:

```json
{"message":"This API key is not authorized for the \"facility\" integration route.
  Request a token with the \"facility\" permission from the Partner Portal.",
 "error":"Forbidden","statusCode":403}
```

This is the control that matters most in a shared-ledger system, and it holds for both working
tokens. It was independently reproduced in Postman by the product owner.

Also verified: role permission is resolved **server-side from the token subject**, not read from
a claim in the token — the JWTs carry no `role` or `scope` claim. Tampering with the payload
does not grant a different role.

### 3.2 ✅ Replay & duplicate protection — passed

Two independent mechanisms, both working:

- `DUPLICATE_EVENT_ID` — the same `eventID` submitted twice is rejected with 409.
- `DUPLICATE_EVENT_PAYLOAD` — the same *content* under a **different** `eventID` is also rejected
  (`Duplicate matrix key EPC+bizStep`), with the resolution text
  *"Retries must reuse the original eventID."*

Content-level deduplication is a genuinely good design choice — it stops a partner from
re-recording the same custody event by simply generating a fresh UUID.

### 3.3 F3 — unresolvable keys return 500 🟠

| Request | Response |
|---|---|
| No `X-API-Key` header | **401** ✅ correct |
| Garbage string as key | **500** ❌ |
| Valid JWT shape, bad signature | **500** ❌ |
| `alg: none` downgrade | **500** ❌ |
| Tampered payload (swapped partner id) | **500** ❌ |
| Token from another environment | **401** ✅ correct |

**No access is granted** in any of these cases — the system fails closed, and this is *not* an
authentication bypass. But:

- A 500 usually means an **unhandled exception** — code reached a state nobody planned for.
- Monitoring cannot distinguish "someone is brute-forcing our API" from "our database is down",
  because both look like a spike of 500s.
- It defeats the WAF and alerting patterns that key off 401 rates.

**Timeline note, reported honestly:** at 06:20 the garbage-key request returned a correct
`401 Invalid API key`. From 06:28 onward, the identical request returned 500 consistently, and
was still doing so at 06:46 across four separate isolation runs. Something changed in that
window. This may be a load-induced degradation rather than a static code defect, which makes it
*more* concerning, not less — but the trigger is unconfirmed.

> **Hypothesis (not confirmed):** the auth middleware short-circuits to 401 when the header is
> absent, but performs a partner lookup when a key *is* present; if that lookup throws — because
> the key is absent from the store, or the store is unreachable — the exception surfaces as 500
> instead of being mapped to 401.

### 3.4 F4 — the facility token does not work here 🟠

The supplied facility token returns **500 on all three endpoints, including its own**, while the
manufacturer and distributor tokens behave correctly on the same runs. Its behaviour is
identical to that of a completely unrecognised key (§3.3).

The JWT itself is well-formed and unexpired:

| Token | Subject | Issued | Expires |
|---|---|---|---|
| manufacturer | `c72834d4…` | 2026-04-15 | 2027-04-15 ✅ |
| distributor | `3f5c7e8a…` | 2026-05-25 | 2027-05-25 ✅ |
| facility | `c9a644d8…` | 2026-05-11 | 2027-05-11 ✅ |

**Action needed from the product owner:** confirm whether this facility partner is provisioned
on `tnt-demo`. If it is not, F4 collapses into F3 (unknown key → 500) and the facility role
simply remains untested. If it *is* provisioned, this is a separate and more serious defect.
Facility-role coverage is blocked either way.

### 3.5 F6 — security headers missing on the routes people actually use 🟡

| Route | CSP | X-Frame-Options | nosniff | HSTS | ACAO |
|---|---|---|---|---|---|
| `/` | ❌ | ❌ | ❌ | ❌ | `*` |
| `/login` | ❌ | ❌ | ❌ | ❌ | `*` |
| `/scanner` | ❌ | ❌ | ❌ | ❌ | `*` |
| `/new` | ✅ | ✅ | ✅ | ❌ | — |

The **only** route carrying protective headers is `/new` — which serves a different backend. The
login page and the public scanner, the two routes handling credentials and consumer traffic, have
no CSP, no clickjacking protection and no MIME-sniffing protection, and return
`Access-Control-Allow-Origin: *`.

HSTS is absent everywhere. Plain HTTP on port 80 does not respond at all (connection timeout),
so there is no cleartext listener to downgrade to — which limits the practical risk — but it
also means there is no redirect, and a first-time visitor typing the bare hostname gets a
connection failure rather than an upgrade.

### 3.6 F7 — CORS reflects any origin with credentials 🟡

```http
OPTIONS /api/integration/manufacturer/events
Origin: https://evil.example.com
→ Access-Control-Allow-Origin: https://evil.example.com
  Access-Control-Allow-Credentials: true
```

The origin is reflected verbatim rather than checked against an allowlist, and credentials are
permitted. Exploitability is limited because the API authenticates with an `X-API-Key` header
rather than cookies, so a browser will not attach credentials automatically. It should still be
an allowlist — reflect-any-origin is a latent hazard the moment any cookie-based endpoint is
added to the same origin.

### 3.7 F8 — backdating is accepted, future-dating is not 🟡

| `eventTime` | Result |
|---|---|
| 2031-01-01 (5 years ahead) | **400** `FUTURE_EVENT_TIME` — *"more than 5 minutes in the future"* ✅ |
| 1990-01-01 (36 years ago) | **202 accepted** ❌ |

Clock-skew validation exists but is applied in one direction only. Backdating is the direction
that matters for a custody ledger: inserting a predated event is how you make stock of unknown
provenance appear to have been in legitimate custody all along. A pack cannot have been
commissioned before its product's registration date, and no real event should predate the
partner's own onboarding — both are cheap server-side bounds.

### 3.8 F9 — invalid EPCs accepted with a soft warning 🟡

`"epcList": ["not-an-epc-at-all"]` returns **202 accepted**, with a non-blocking warning:

```json
"warnings":[{"layer":3,"field":"epcList","code":"UNKNOWN_SGTIN",
  "message":"SGTIN … not found in master data registry","severity":"warning"}]
```

A string that is not a GS1 identifier at all is not the same as a well-formed SGTIN missing from
master data. The first is malformed input and should be a 400; the second is legitimately a
warning. Conflating them lets unparseable identifiers into the ledger, where they can never be
matched to a physical pack.

The same soft-warning treatment applies to unknown GLNs (`UNKNOWN_SGLN`), which is why every
test event in this run recorded a location that does not exist in master data — worth a product
decision as to whether that should stay permissive.

### 3.9 F10 — script payload stored and echoed 🟡

`lotNumber` set to `<script>alert(document.domain)</script>` returns **202** and the response
body contains the payload **unescaped**. The value is stored against the event.

This is not yet a proven XSS: the API returns `application/json`, and a JSON response containing
`<script>` is inert. The risk is downstream — wherever that lot number is rendered in the
Regulator, Manufacturer or Events Explorer UI. **Untested and worth testing**, since a stored
payload that reaches a regulator's dashboard is a privileged-context XSS. Server-side input
validation on `lotNumber` (GS1 AI 10 permits at most 20 alphanumeric characters) would close it
regardless of how the UI renders.

### 3.10 F11 and other observations 🔵

- `X-Powered-By: Express` on API responses — remove it; free information for an attacker.
- No brute-force throttling observed on repeated invalid keys (30 concurrent attempts, no 429).
  Currently masked by F3, since those attempts return 500 rather than 401.
- A burst of 60 concurrent valid writes was absorbed with no 5xx — the happy path is stable.
- Responses carry `"_sandbox": true`, confirming this is not production data.

---

## 4. Coverage

The revised checklists define **112 checks** (35 performance, 77 security). This pass executed
**32 automated security checks** plus 4 performance runs. Deliberately not covered:

| Area | Why |
|---|---|
| Facility role, end to end | Blocked on F4 |
| Web portal session/auth (§G, 12 checks) | Needs browser automation; specs not yet written |
| Public scanner enumeration & timing oracle (§D, 7 checks) | Needs the scanner's verification endpoint, not yet identified |
| Chain-of-custody sequencing (§C, partial) | Needs a full ship→receive fixture across two partners |
| XML ingestion path, XXE and XML-bomb | Every endpoint has an XML variant; **entirely untested** |
| Soak / endurance | Needs a 2 h+ window |
| OWASP ZAP scan | Needs written authorisation for an active scan |

The XML gap is the one I would close first — it is half the ingestion surface, and XML parsers
carry a class of vulnerability (external entity expansion) that the JSON path simply does not have.

---

## 5. Recommended order of work

1. **F1** — move batch ingestion to async with a pollable job id, or publish the ~500-event
   practical ceiling. No data is lost today, but a 504 on a request that succeeds is a trap for
   every partner integration.
2. **F3 / F4** — map unresolvable keys to 401; confirm whether the facility partner exists on
   this environment. Unblocks facility testing.
3. **F5 / F2** — reconcile the advertised 10,000/min tier with the ~15 req/s reality; decide
   whether the ceiling is acceptable for production commissioning volumes.
4. **F6** — apply the security headers that `/new` already has to `/`, `/login` and `/scanner`.
5. **F8 / F9** — add lower-bound `eventTime` validation and strict EPC syntax validation.
6. **F10** — validate `lotNumber` server-side, then test UI rendering of stored payloads.
7. **F7 / F11** — CORS allowlist, drop `X-Powered-By`.

## 6. Reproducing this

```bash
node security/probe.mjs                      # security matrix -> security/results/*.json
node scripts/make-checklist-workbook.mjs     # -> reports/TnT_Perf_Security_Checklist.xlsx

k6 run -e MANUFACTURER_API_TOKEN=$TOKEN -e TARGET_VUS=10 \
       k6/load-manufacturer-commission.js
k6 run -e MANUFACTURER_API_TOKEN=$TOKEN -e STAGE_VUS=5,20,50 \
       k6/stress-manufacturer-commission.js
```

All k6 scripts default to `https://tnt-demo.apeiro-digital.com` (host root — see §0).
