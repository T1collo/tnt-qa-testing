# TnT — Security QA Checklist

Track & Trace specific. The generic web-app security list (login, session, XSS, SQLi) still
applies and is kept below, but it is **not where the risk lives in this system**.

In a pharmaceutical track-and-trace network the participants are commercial competitors who
share one ledger, and the ledger is the legal record of custody. So the questions that matter
most are:

- Can one supply-chain tier **forge another tier's custody event**?
- Can a partner see **another partner's commercial data** (volumes, customers, pricing)?
- Can a valid event be **replayed, backdated, or voided** to launder counterfeit stock into
  the legitimate chain?
- Can an attacker **harvest valid serial numbers** to print convincing fakes?

Sections A–C cover those. Sections D–G are the conventional checks.

**Severity key** — 🔴 Critical · 🟠 High · 🟡 Medium · 🔵 Low · ⚪ Info

---

## A. Partner API authentication

| # | Check | Expected | Pass/Fail | Notes/Evidence |
|---|---|---|---|---|
| TNT-SEC-AUTH-001 | Request with no `X-API-Key` is rejected | 401 | ☐ | |
| TNT-SEC-AUTH-002 | Malformed / garbage API key is rejected | **401** (not 500) | ☐ | |
| TNT-SEC-AUTH-003 | JWT `alg: none` downgrade is rejected | **401** (not 500) | ☐ | |
| TNT-SEC-AUTH-004 | Token with a mismatched signature is rejected | **401** (not 500) | ☐ | |
| TNT-SEC-AUTH-005 | Token issued for a different environment is rejected | 401 | ☐ | |
| TNT-SEC-AUTH-006 | Token with a tampered payload (swapped partner id) is rejected | **401** (not 500) | ☐ | |
| TNT-SEC-AUTH-007 | Expired token is rejected | 401 | ☐ | |
| TNT-SEC-AUTH-008 | Revoked token stops working immediately | 401 | ☐ | |
| TNT-SEC-AUTH-009 | Token lifetime is justifiable and documented | ≤ issued policy | ☐ | |
| TNT-SEC-AUTH-010 | Rejection status codes are consistent across all three roles | same code, same shape | ☐ | |

> **Why 401-not-500 is called out explicitly.** A rejection path that answers `500 Internal
> Server Error` still denies access, so it is not an access-control breach. But it is a real
> defect for two reasons: a monitoring system cannot separate "someone is brute-forcing us"
> from "our database is down", and a 500 usually means an *unhandled exception* — code
> reached a state its author did not anticipate, which is exactly where subtler bugs hide.

## B. Cross-partner authorization (the core control)

Run this as a **full matrix**: every partner token against every partner endpoint. Only the
diagonal may succeed.

|  | `/manufacturer/events` | `/supplier/events` | `/facility/events` |
|---|---|---|---|
| **manufacturer token** | ✅ accept | ⛔ 403 | ⛔ 403 |
| **distributor token** | ⛔ 403 | ✅ accept | ⛔ 403 |
| **facility token** | ⛔ 403 | ⛔ 403 | ✅ accept |

| # | Check | Expected | Pass/Fail | Notes/Evidence |
|---|---|---|---|---|
| TNT-SEC-AUTHZ-001 | Full 3×3 cross-role matrix — only the diagonal is accepted | as table above | ☐ | |
| TNT-SEC-AUTHZ-002 | Manufacturer cannot commission EPCs under **another company's GS1 prefix** | rejected | ☐ | |
| TNT-SEC-AUTHZ-003 | Partner cannot post an event for a `bizLocation` (GLN) it does not own | rejected | ☐ | |
| TNT-SEC-AUTHZ-004 | Partner cannot claim receipt of an EPC never shipped to them | rejected / flagged | ☐ | |
| TNT-SEC-AUTHZ-005 | Partner cannot decommission, destroy or void **another partner's** stock | 403 | ☐ | |
| TNT-SEC-AUTHZ-006 | Error-declaration ("did not occur") cannot void an event the caller did not author | 403 | ☐ | |
| TNT-SEC-AUTHZ-007 | Partner cannot dispense stock it never received (facility path) | rejected / flagged | ☐ | |
| TNT-SEC-AUTHZ-008 | Web portal: each role is blocked from other roles' modules | access denied | ☐ | |
| TNT-SEC-AUTHZ-009 | Web portal: direct URL entry to another role's page is blocked | access denied | ☐ | |
| TNT-SEC-AUTHZ-010 | Changing an id in a request does not expose another org's record | 403/404 | ☐ | |
| TNT-SEC-AUTHZ-011 | Regulator read access does not permit event authorship | read-only enforced | ☐ | |
| TNT-SEC-AUTHZ-012 | A partner's data is not visible to another partner anywhere in the UI | isolated | ☐ | |

> TNT-SEC-AUTHZ-002 is the counterfeiter's dream. If any authenticated partner can commission
> serials under *any* GS1 company prefix, a compromised or dishonest minor partner can mint
> serial numbers that scan as a major manufacturer's product — and they will verify as genuine,
> because the system itself issued them.

## C. Event & chain-of-custody integrity

These have no equivalent in a generic web checklist, and they are the ones that decide whether
the ledger can be trusted as evidence.

| # | Check | Expected | Pass/Fail | Notes/Evidence |
|---|---|---|---|---|
| TNT-SEC-INTEG-001 | Replaying an identical event document is rejected/deduped | 409 or dedup | ☐ | |
| TNT-SEC-INTEG-002 | Reusing an `eventID` with a *different* body is rejected | 409 | ☐ | |
| TNT-SEC-INTEG-003 | Duplicate serial commissioning is rejected | 409 | ☐ | |
| TNT-SEC-INTEG-004 | Backdated `eventTime` (before the pack existed) is rejected or flagged | rejected/flagged | ☐ | |
| TNT-SEC-INTEG-005 | Future-dated `eventTime` is rejected or flagged | rejected/flagged | ☐ | |
| TNT-SEC-INTEG-006 | Out-of-sequence custody (receive before ship) is rejected or flagged | rejected/flagged | ☐ | |
| TNT-SEC-INTEG-007 | Recorded events are immutable — no API path edits or deletes history | append-only | ☐ | |
| TNT-SEC-INTEG-008 | Corrections happen via error-declaration events, not mutation | corrective event | ☐ | |
| TNT-SEC-INTEG-009 | Aggregation cannot pack an EPC into two parents at once | rejected | ☐ | |
| TNT-SEC-INTEG-010 | Events survive a partial-failure batch atomically (all or none) | documented + consistent | ☐ | |
| TNT-SEC-INTEG-011 | Concurrent writes to the same EPC do not corrupt its state | serialised | ☐ | |
| TNT-SEC-INTEG-012 | Audit trail records **who** submitted each event and when | attributable | ☐ | |
| TNT-SEC-INTEG-013 | A batch that times out at the gateway reports its **true** outcome (completion signal or job id) | no misleading 504 | ☐ | |
| TNT-SEC-INTEG-015 | Partners can reconcile a batch **without** resubmitting events (a read/status path exists) | non-mutating check | ☐ | |
| TNT-SEC-INTEG-014 | `eventTime` earlier than the product/partner could exist is rejected | rejected | ☐ | |

## D. Public scanner — serial enumeration & data leakage

The scanner is unauthenticated by design. That makes it the one component an attacker can
probe freely, and the one most likely to leak.

| # | Check | Expected | Pass/Fail | Notes/Evidence |
|---|---|---|---|---|
| TNT-SEC-SCAN-001 | Scanner is rate-limited per IP | throttled | ☐ | |
| TNT-SEC-SCAN-002 | Bulk serial enumeration is detected/blocked | blocked | ☐ | |
| TNT-SEC-SCAN-003 | Valid vs invalid serial responses are **timing-indistinguishable** | no timing oracle | ☐ | |
| TNT-SEC-SCAN-004 | Scanner response leaks no commercial data (volumes, pricing, customers) | minimal fields | ☐ | |
| TNT-SEC-SCAN-005 | Scanner response leaks no patient or dispensing data | none | ☐ | |
| TNT-SEC-SCAN-006 | Serial numbers are not sequentially guessable | non-enumerable | ☐ | |
| TNT-SEC-SCAN-007 | Repeated scans of one serial are flagged (clone detection) | flagged | ☐ | |

> TNT-SEC-SCAN-006 deserves a real look. If serials increment predictably, a counterfeiter does
> not need to breach anything — they buy one genuine pack, read its serial, and derive the rest
> of the run. Serial randomisation is the control, and it can only be fixed at issuance time,
> not retrofitted.

## E. Input validation & injection

| # | Check | Expected | Pass/Fail | Notes/Evidence |
|---|---|---|---|---|
| TNT-SEC-INP-001 | Malformed JSON returns 4xx with no stack trace | 400, clean | ☐ | |
| TNT-SEC-INP-002 | Missing `epcisBody` / `@context` is rejected | 400 | ☐ | |
| TNT-SEC-INP-003 | Structurally invalid EPC/SGTIN is rejected | 400/422 | ☐ | |
| TNT-SEC-INP-004 | Script payload in `lotNumber` is rejected or escaped everywhere it renders | no stored XSS | ☐ | |
| TNT-SEC-INP-005 | SQL metacharacters surface no database error | no DB error text | ☐ | |
| TNT-SEC-INP-006 | Very long field values (100k chars) handled without 5xx | non-5xx | ☐ | |
| TNT-SEC-INP-007 | Unexpected/privileged extra fields are ignored, not honoured | no mass assignment | ☐ | |
| TNT-SEC-INP-008 | Oversized batches are bounded with a fast, documented rejection | fast 4xx, no 504 | ☐ | |
| TNT-SEC-INP-009 | Wrong `Content-Type` handled cleanly | non-5xx | ☐ | |
| TNT-SEC-INP-010 | XML payloads are parsed without external-entity expansion (XXE) | XXE blocked | ☐ | |
| TNT-SEC-INP-011 | XML bomb / deeply nested payload does not exhaust memory | bounded | ☐ | |
| TNT-SEC-INP-012 | Error messages expose no internal paths, versions or SQL | sanitised | ☐ | |

> TNT-SEC-INP-010 and -011 exist because this API accepts **XML as well as JSON-LD** — every
> endpoint in the Postman collection has an XML variant. XML parsers are a different attack
> surface from JSON parsers, and XXE is the classic way to turn a document upload into an
> arbitrary file read. Testing only the JSON-LD path leaves half the ingestion surface untested.

## F. Transport & data protection

| # | Check | Expected | Pass/Fail | Notes/Evidence |
|---|---|---|---|---|
| TNT-SEC-DATA-001 | HTTPS enforced; plain HTTP redirected or refused | enforced | ☐ | |
| TNT-SEC-DATA-002 | HSTS present | header set | ☐ | |
| TNT-SEC-DATA-003 | Security headers (CSP, XFO, nosniff, Referrer-Policy) present on **all** routes | consistent | ☐ | |
| TNT-SEC-DATA-004 | No framework/version banners (`X-Powered-By`) | absent | ☐ | |
| TNT-SEC-DATA-005 | API key is not accepted in a URL query string | 401 | ☐ | |
| TNT-SEC-DATA-006 | Ingestion endpoint serves no readable event dump over GET | 404/405 | ☐ | |
| TNT-SEC-DATA-007 | CORS does not reflect an arbitrary origin | allowlisted | ☐ | |
| TNT-SEC-DATA-008 | Tokens are not written to browser storage or logs | absent | ☐ | |
| TNT-SEC-DATA-009 | API responses return no unnecessary internal fields (ids, flags, SQL) | minimal | ☐ | |
| TNT-SEC-DATA-010 | TLS configuration is current (TLS 1.2+, no weak ciphers) | passes scan | ☐ | |

## G. Web portal authentication & session

| # | Check | Expected | Pass/Fail | Notes/Evidence |
|---|---|---|---|---|
| TNT-SEC-WEB-001 | Invalid credentials rejected, no user enumeration in the message | generic error | ☐ | |
| TNT-SEC-WEB-002 | Empty credentials rejected | rejected | ☐ | |
| TNT-SEC-WEB-003 | Password field is masked | masked | ☐ | |
| TNT-SEC-WEB-004 | Excessive failed logins are throttled or locked out | throttled | ☐ | |
| TNT-SEC-WEB-005 | Logout ends the session server-side | invalidated | ☐ | |
| TNT-SEC-WEB-006 | Back button does not expose authenticated pages after logout | blocked | ☐ | |
| TNT-SEC-WEB-007 | Session expires after configured inactivity | expires | ☐ | |
| TNT-SEC-WEB-008 | Reusing an expired session token is rejected | rejected | ☐ | |
| TNT-SEC-WEB-009 | Session cookies are `HttpOnly`, `Secure`, `SameSite` | all set | ☐ | |
| TNT-SEC-WEB-010 | Password reset flow cannot be used to enumerate accounts | generic response | ☐ | |
| TNT-SEC-WEB-011 | Role change takes effect on the next request, not next login | immediate | ☐ | |
| TNT-SEC-WEB-012 | CSRF protection on state-changing portal actions | token/SameSite | ☐ | |

---

## Automated scanning

Run OWASP ZAP against the **staging/demo** environment only, with written authorisation:

```text
☐ Missing security headers          ☐ Cookie security flags
☐ XSS indicators                    ☐ Authentication/session issues
☐ Information disclosure            ☐ TLS configuration
☐ Dangerous HTTP methods            ☐ Directory/resource exposure
```

## Reporting format

| ID | Category | Test | Expected | Actual | Status | Severity | Evidence |
|---|---|---|---|---|---|---|---|
| TNT-SEC-AUTHZ-001 | Authorization | Cross-role matrix | 403 off-diagonal | 403 | PASS | — | probe JSON |
| TNT-SEC-AUTH-002 | Authentication | Invalid API key | 401 | 500 | FAIL | High | probe JSON |

**Severity** — 🔴 Critical (data exposure, forged custody, account takeover) · 🟠 High (serious
control weakness) · 🟡 Medium (meaningful but limited) · 🔵 Low (minor) · ⚪ Info.

## Tooling

```bash
node security/probe.mjs      # sections A, B, E, F + rate limiting - writes security/results/*.json
```

Sections C, D and G are partly manual today — see the report for which are automated.
