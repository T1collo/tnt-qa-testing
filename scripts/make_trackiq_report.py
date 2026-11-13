"""Generates the TrackIQ performance + security findings report (.docx).

Structure is deliberately section-per-topic: each section states the tests that were run,
what came back, and why the result matters. No executive summary and no "how to use this
document" section - the sections are the document.

Run: python scripts/make_trackiq_report.py
Out: reports/TnT_TrackIQ_Perf_Security_Report.docx
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from docx_helpers import heading, para, bullet, table, run, write_docx  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "reports", "TnT_TrackIQ_Perf_Security_Report.docx")

# Column widths (twentieths of a point) for the recurring 4- and 5-column tables.
W_TEST = [1500, 3400, 1900, 2200]
W_TEST5 = [1400, 3000, 1700, 1000, 1900]

body = []

# --------------------------------------------------------------- title
body.append(para([run("TrackIQ — Performance & Security Test Report", bold=True, sz="40", color="1F4E78")], spacing_after=60))
body.append(para([run("Target: https://trackiq.apeiro-digital.com", sz="22", color="595959")], spacing_after=40))
body.append(para([run("Test date: 3 September 2026   |   Partner EPCIS API + public web routes", sz="20", color="595959")], spacing_after=240))
body.append(para([run(
    "Every result below was directly observed against the live environment. Where a "
    "conclusion is inference rather than observation it is labelled as a hypothesis and "
    "kept separate from the evidence.", italic=True, sz="20", color="595959")]))

# --------------------------------------------------------------- summary
body.append(heading("Summary", 1))
body.append(para(
    "Two test surfaces were exercised on TrackIQ: the Partner EPCIS ingestion API across all "
    "three partner roles, and the public web routes. 37 automated security checks and 6 load "
    "runs were executed, plus targeted manual probes for business-rule and chain-of-custody "
    "behaviour. The web portal behind the login was not reachable and is the main gap."))

body.append(para([run("What was tested, and the result", bold=True)], spacing_after=80))
body.append(table(
    ["Area", "Checks", "Result"],
    [
        ["Partner API authentication", "4 run, 3 not applicable", "All passed"],
        ["Cross-partner authorization (3x3 matrix)", "9", "All passed - clean diagonal"],
        ["Business rules and counterfeit injection", "5", "All 5 accepted what was expected to be refused"],
        ["Event replay, duplication and dating", "3", "All passed"],
        ["Input validation and injection", "8", "6 passed, 2 failed"],
        ["Transport and data protection", "6", "4 passed, 2 failed"],
        ["Rate limiting and brute force", "3", "2 passed, 1 failed"],
        ["Performance - ingestion and web tier", "6 load runs", "Works, but plateaus early"],
        ["Service stability", "observed across session", "Intermittent 500s - unresolved"],
        ["Web portal (behind login)", "5 attempted", "3 passed, blocked on credentials"],
    ], [3600, 1900, 3900]))

body.append(para([run("The five things that matter most", bold=True)], spacing_after=80))
body.append(para([run("1. A partner can commission serials under another company's GS1 prefix (section 4).", bold=True)], spacing_after=60))
body.append(para(
    "This is the most serious finding. A track-and-trace system exists so a scanned pack can be "
    "proved genuine; if any authenticated partner can mint serial numbers under a major "
    "manufacturer's prefix, those serials are issued by the platform itself and will scan as "
    "authentic. Accepting an UNREGISTERED prefix with a warning is documented, intended "
    "behaviour. Accepting a prefix registered to a DIFFERENT company is not covered by that "
    "design and is the actual gap.", spacing_after=120))
body.append(para([run("2. Chain of custody is not sequenced (section 4).", bold=True)], spacing_after=60))
body.append(para(
    "An EPC can be shipped without ever having been commissioned, and decommissioned without "
    "ever having existed. Both were accepted with HTTP 202. The ledger is therefore an "
    "unordered set of individually valid assertions rather than a chain, and it records what "
    "partners claimed rather than what can be shown to have happened.", spacing_after=120))
body.append(para([run("3. Intermittent HTTP 500s on ingestion, cause unknown (section 12).", bold=True)], spacing_after=60))
body.append(para(
    "The same request that succeeds consistently in one window fails consistently in another. "
    "Observed at 100 percent failure, then 14 percent under load, then 0 percent, then 100 "
    "percent again across a single session. Payload shape was ruled out by bisection. "
    "Throughout, GET /api/health continued to report status ok, because it checks only "
    "object-storage configuration and never exercises the ingestion path.", spacing_after=120))
body.append(para([run("4. Capacity is well below the advertised quota (sections 8 to 10).", bold=True)], spacing_after=60))
body.append(para(
    "The API advertises 5,000 requests per minute, roughly 83 per second. Measured capacity is "
    "22 requests per second for commissioning and about 35 for receiving, and it plateaus: "
    "five times the concurrency bought 30 percent more throughput and 3.4 times worse latency. "
    "Batching does not help - it runs slower per event and dies at a 60-second gateway timeout "
    "past roughly 500 events per document. A partner engineering to its stated quota will hit "
    "timeouts and never see a 429.", spacing_after=120))
body.append(para([run("5. Access control is genuinely solid (sections 2 and 3).", bold=True)], spacing_after=60))
body.append(para(
    "Stated deliberately alongside the problems, because it is the control that matters most "
    "and it holds. All nine cells of the cross-role matrix behave correctly: each partner key "
    "is accepted on its own route and refused with 403 on both others. Authentication rejects "
    "every malformed, mutated and foreign-environment key tested. Replay protection works at "
    "both the event-ID and the content-hash level.", spacing_after=120))

body.append(para([run("What is not covered", bold=True)], spacing_after=80))
body.append(bullet("The XML ingestion path is entirely untested. Every endpoint accepts XML as well as JSON-LD, so this is half the ingestion surface, and XML parsers carry an external-entity vulnerability class the JSON path does not have. This is the largest gap."))
body.append(bullet("Everything behind the web portal login: sessions, cookie flags, logout, role separation in the interface, and whether stored input is escaped when rendered. Blocked on working credentials."))
body.append(bullet("Public scanner enumeration and timing-oracle checks; soak testing; an authorised OWASP ZAP scan."))

body.append(para([run("One caveat that applies to the whole report", bold=True)], spacing_after=80))
body.append(para(
    "Every response from this environment carries the flag \"_sandbox\": true. Several "
    "validations reported here as permissive may well be enforced strictly in production. That "
    "has not been verified and cannot be verified from the client side. Two points follow "
    "regardless: confirm which business rules production enforces, and note that partners "
    "certify their integrations against this sandbox, so anything it accepts that production "
    "rejects will produce integrations that pass testing and fail at go-live.", spacing_after=200))

# --------------------------------------------------------------- 1
body.append(heading("1. Environment and Endpoint Discovery", 1))
body.append(para("Tests run before any other work, to establish what was actually being tested."))
body.append(table(
    ["Test", "What was done", "Result", "Verdict"],
    [
        ["ENV-001", "POST to /new/api/integration/... (the path used previously)", "301 redirect to the host root", "Informational"],
        ["ENV-002", "POST to /api/integration/... at the host root", "Reached the API", "Correct base"],
        ["ENV-003", "Each of the 3 supplied keys against each of the 3 routes", "See section 3", "Mapping corrected"],
        ["ENV-004", "GET /api/health", '200 {"status":"ok"}', "See section 12"],
    ], W_TEST))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("The Partner API is served from the host root. On TrackIQ, /new issues a 301 to the root, so a client that follows redirects still works — but a POST following a 301 may be downgraded to GET by some HTTP clients, so the root should be used directly."))
body.append(bullet("Keys on this environment are opaque strings of the form trk_test_… . They are not JWTs. The tnt-demo environment issues JWTs instead, and the two formats are not interchangeable."))
body.append(bullet("Key permissions are set at issuance and cannot be inferred from how a key is labelled. Two keys supplied as \"manufacturer\" during testing in fact carried supplier permission only, and were rejected on the manufacturer route until a correctly-provisioned key was issued."))
body.append(bullet("A working manufacturer key was issued mid-session and confirmed. All three roles are now covered and the authorization matrix in section 3 is complete."))
body.append(bullet("Every accepted response carries \"_sandbox\": true and \"processing_mode\": \"ASYNC\". This environment self-identifies as a sandbox, and events are queued rather than committed synchronously."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "Commissioning is the entry point of the entire track-and-trace chain — it is where a "
    "serial number first comes into existence. Until a manufacturer key existed, no "
    "commissioning event could be created and the checks in section 4 could not be run at "
    "all. Those are the checks that turned up the most significant findings in this report, "
    "which is worth noting as a process point: the single missing credential was hiding the "
    "highest-value results."))
body.append(para(
    "The sandbox flag is a material caveat and is carried through the rest of this report. "
    "Several validations that this environment treats as warnings may well be enforced as "
    "errors in production. That distinction has not been verified and should be confirmed "
    "before any finding here is treated as a production defect."))

# --------------------------------------------------------------- 2
body.append(heading("2. Partner API Authentication", 1))
body.append(para("Whether an API key that should not work is correctly refused."))
body.append(table(
    ["Test", "What was sent", "Expected", "Actual", "Verdict"],
    [
        ["TNT-SEC-AUTH-001", "No X-API-Key header", "401", "401", "PASS"],
        ["TNT-SEC-AUTH-002", "Garbage string as the key", "401", "401", "PASS"],
        ["TNT-SEC-AUTH-011", "A real key with its final character changed", "401", "401", "PASS"],
        ["TNT-SEC-AUTH-005", "A valid key issued for the tnt-demo environment", "401", "401", "PASS"],
        ["TNT-SEC-AUTH-003/4/6", "JWT forgery: alg-none, bad signature, tampered payload", "n/a", "Not applicable", "SKIPPED"],
    ], W_TEST5))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("All four applicable authentication checks passed. Rejection is consistent and returns a clean 401 with no internal detail."))
body.append(bullet("The three JWT forgery tests were skipped because they are meaningless here. An opaque key carries no client-readable claims and no signature to re-compute, so there is nothing to forge offline — the key either exists in the server's store or it does not."))
body.append(bullet("A key differing from a real one by a single character is refused, which rules out prefix or partial matching in the key lookup."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "Opaque random keys are, on this specific point, a stronger design than the signed JWTs "
    "used on tnt-demo: there is no algorithm-confusion or signature-stripping attack surface "
    "at all. The trade-off is that revocation and expiry now depend entirely on server-side "
    "state, so key rotation and revocation should be verified separately — neither was "
    "testable here without a second key for the same partner."))

# --------------------------------------------------------------- 3
body.append(heading("3. Cross-Partner Authorization", 1))
body.append(para(
    "The most important control in a shared-ledger system. Every available key was posted to "
    "every partner endpoint; only a key's own route should accept it."))
body.append(table(
    ["Key holder", "/manufacturer", "/supplier", "/facility"],
    [
        ["manufacturer key", "202 accepted", "403 refused", "403 refused"],
        ["distributor key", "403 refused", "202 accepted", "403 refused"],
        ["facility key", "403 refused", "403 refused", "202 accepted"],
    ], [2200, 2266, 2266, 2266]))
body.append(table(
    ["Test", "What was done", "Expected", "Actual", "Verdict"],
    [
        ["TNT-SEC-AUTHZ-001", "manufacturer key to /manufacturer (own)", "2xx", "202", "PASS"],
        ["TNT-SEC-AUTHZ-002", "manufacturer key to /supplier", "401/403", "403", "PASS"],
        ["TNT-SEC-AUTHZ-003", "manufacturer key to /facility", "401/403", "403", "PASS"],
        ["TNT-SEC-AUTHZ-004", "distributor key to /manufacturer", "401/403", "403", "PASS"],
        ["TNT-SEC-AUTHZ-005", "distributor key to /supplier (own)", "2xx", "202", "PASS"],
        ["TNT-SEC-AUTHZ-006", "distributor key to /facility", "401/403", "403", "PASS"],
        ["TNT-SEC-AUTHZ-007", "facility key to /manufacturer", "401/403", "403", "PASS"],
        ["TNT-SEC-AUTHZ-008", "facility key to /supplier", "401/403", "403", "PASS"],
        ["TNT-SEC-AUTHZ-009", "facility key to /facility (own)", "2xx", "202", "PASS"],
    ], W_TEST5))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("All nine cells of the matrix behave correctly — a clean diagonal. Each key is accepted on its own route and refused with 403 on both others. Refusals are correctly typed as Forbidden rather than conflated with authentication failures."))
body.append(bullet('The refusal message names the exact missing permission, for example: "This API key is not authorized for the facility integration route. Request a token with the facility permission from the Partner Portal."'))
body.append(bullet("Permission is resolved server-side from the key. Because the keys are opaque, a partner cannot inspect or alter its own role claim."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "In a pharmaceutical track-and-trace network the participants are commercial competitors "
    "sharing one ledger, and that ledger is the legal record of custody. If any partner could "
    "post to another tier's endpoint, it could forge another company's custody events — "
    "recording a shipment that never happened, or a receipt of stock it never held. This "
    "control holding is the single most significant positive result in this report."))
body.append(para(
    "This control is doing its job. Note carefully what it does and does not cover: it "
    "establishes which endpoint a key may post to. It does not constrain what that key may "
    "assert once inside the endpoint — which is the subject of section 4, and where the "
    "picture is very different."))

# --------------------------------------------------------------- 4 (business rules)
body.append(heading("4. Business-Rule Validation and Counterfeit Injection", 1))
body.append(para(
    "These checks require a manufacturer identity and could only be run once a correctly "
    "provisioned manufacturer key was issued. They ask a different question from section 3. "
    "Section 3 established which endpoint a key may reach; this section asks what a key may "
    "assert once it is inside that endpoint."))
body.append(table(
    ["Test", "What was submitted", "Expected", "Actual", "Verdict"],
    [
        ["TNT-SEC-AUTHZ-002", "Commission serials under GS1 prefix 9999999", "403/400", "202 accepted", "FAIL"],
        ["TNT-SEC-AUTHZ-002b", "Commission under Kenya prefix 6161102974997", "403/400", "202 accepted", "FAIL"],
        ["TNT-SEC-AUTHZ-003", "Commission at a GLN the partner does not own", "403/400", "202 accepted", "FAIL"],
        ["TNT-SEC-INTEG-006", "Ship an EPC that was never commissioned", "400/409", "202 accepted", "FAIL"],
        ["TNT-SEC-INTEG-007", "Decommission an EPC that never existed", "400/409", "202 accepted", "FAIL"],
    ], W_TEST5))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("A manufacturer key can commission serial numbers under any GS1 company prefix, including prefixes belonging to other companies. The response is 202 Accepted with a soft UNKNOWN_SGTIN warning."))
body.append(bullet("Important qualification: accept-and-flag for an UNREGISTERED prefix is documented behaviour, recorded as passing in the QA master workbook (API-MFG-COMM-EDGE-006, per spec section 3 - \"unknown identifiers will be flagged\"). The finding here is narrower and is not covered by that case: nothing prevents a partner commissioning under a prefix that is registered to a DIFFERENT company. Registration and ownership are separate questions, and only the first is being checked."))
body.append(bullet("A partner can post events at any GLN, including locations it does not own and locations that do not exist. This yields a soft UNKNOWN_SGLN warning, not a rejection."))
body.append(bullet("Custody sequencing is not enforced. An EPC can be shipped, or decommissioned, without ever having been commissioned. No prior-state check is applied."))
body.append(bullet("An unregistered lot number produces a soft INVALID_LOT warning rather than a rejection."))
body.append(bullet("Every one of these was accepted with HTTP 202 and \"success\": true. The warnings array is populated, but nothing in the response signals that the event was anything other than successfully ingested."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "The ability to commission under another company's GS1 prefix is the most serious finding "
    "in this report. A track-and-trace system exists so that a scanned pack can be proved "
    "genuine. If any authenticated partner can mint serial numbers under a major "
    "manufacturer's prefix, those serials are issued by the system itself — so they will scan "
    "as authentic, because from the ledger's point of view they are. A compromised or "
    "dishonest minor participant would not need to defeat any cryptography or forge any "
    "document; it would simply ask the platform for legitimacy and be granted it."))
body.append(para(
    "The absence of custody sequencing compounds this. Because an EPC can be shipped without "
    "having been commissioned, and received without having been shipped, the chain of custody "
    "is not actually a chain — it is an unordered set of assertions, each individually valid. "
    "The ledger records what partners claimed, not what can be shown to have happened, and "
    "the two are only the same thing if the ordering is enforced."))
body.append(para([run("The sandbox caveat, stated plainly", bold=True)], spacing_after=80))
body.append(para(
    "Every response from this environment carries \"_sandbox\": true. It is entirely plausible "
    "that these validations are deliberately relaxed here so that partners can integrate "
    "against arbitrary test identifiers without first registering master data, and that "
    "production enforces them strictly. That would be a reasonable design."))
body.append(para(
    "This has not been verified and cannot be verified from the client side, so the findings "
    "above are reported as observations of this environment rather than as confirmed "
    "production defects. Two things are worth doing regardless of the answer. First, confirm "
    "explicitly which of these five checks are enforced in production — if any are not, they "
    "are live counterfeit-injection routes. Second, note that partners certify their "
    "integrations against this sandbox: if it accepts events that production will reject, "
    "every partner will pass testing and then fail at go-live, and the sandbox will have "
    "given them false confidence about exactly the rules that matter most."))

# --------------------------------------------------------------- 5
body.append(heading("5. Event Replay, Duplication and Dating", 1))
body.append(para(
    "Whether the ledger can be trusted as a record — replay, duplication and event dating."))
body.append(table(
    ["Test", "What was sent", "Expected", "Actual", "Verdict"],
    [
        ["TNT-SEC-INP-010", "The same event document submitted twice", "reject 2nd", "409 duplicate", "PASS"],
        ["TNT-SEC-INTEG-005", "eventTime dated 2031 (5 years ahead)", "400/422", "400 rejected", "PASS"],
        ["TNT-SEC-INTEG-014", "eventTime dated 1990 (36 years ago)", "flag or reject", "202 + STALE_EVENT_TIME", "PASS"],
    ], W_TEST5))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("Replay protection works. A resubmitted event is rejected with 409 DUPLICATE_EVENT_ID and the guidance \"This event_id has already been ingested. This is idempotent — no action needed.\""))
body.append(bullet("A second, content-based mechanism also exists: the same event content submitted under a different event ID is rejected as DUPLICATE_EVENT_PAYLOAD, keyed on EPC + bizStep + disposition + readPoint."))
body.append(bullet("Clock validation runs in both directions, but with deliberately different outcomes. A future-dated event is rejected outright with FUTURE_EVENT_TIME and a stated 5-minute tolerance. A backdated event is accepted and flagged with STALE_EVENT_TIME. Verified at 10 days, 365 days and 36 years in the past - the flag is raised in every case."))
body.append(bullet("This matches the behaviour documented in the QA master workbook (API-MFG-COMM-EDGE-004 and EDGE-005, per spec sections 6.1.2), where accept-and-flag is the specified design for stale events rather than a defect."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "Content-based deduplication is a genuinely good design decision and deserves credit: it "
    "stops a partner from re-recording the same custody event simply by generating a fresh "
    "UUID, which naive eventID-only deduplication would allow."))
body.append(para(
    "An earlier draft of this report recorded backdating as a failure. That was wrong: the "
    "warning is raised correctly, and the earlier reading came from truncated response output "
    "that cut the warnings array short. Accept-and-flag is the documented design, and it is a "
    "defensible one, because legitimate events do arrive late after a connectivity outage and "
    "hard rejection would lose real data."))
body.append(para(
    "One question is still worth putting to the product owner rather than treating as a defect: "
    "STALE_EVENT_TIME is raised identically for an event 10 days old and one 36 years old. A "
    "commissioning event predating the product's registration is not merely stale, it is "
    "impossible, and a warning that does not distinguish the two leaves a reviewer to spot the "
    "difference by eye."))

# --------------------------------------------------------------- 5
body.append(heading("6. Input Validation and Injection", 1))
body.append(table(
    ["Test", "What was sent", "Expected", "Actual", "Verdict"],
    [
        ["TNT-SEC-INP-001", "Malformed JSON", "4xx, no stack trace", "400, clean", "PASS"],
        ["TNT-SEC-INP-002", "Document with no epcisBody", "400", "400", "PASS"],
        ["TNT-SEC-INP-003", 'epcList entry "not-an-epc-at-all"', "400/422", "202 accepted", "FAIL"],
        ["TNT-SEC-INP-004", "<script> tag in lotNumber", "reject or escape", "202, echoed raw", "FAIL"],
        ["TNT-SEC-INP-005", "SQL metacharacters in lotNumber", "no DB error", "no DB error", "PASS"],
        ["TNT-SEC-INP-006", "100,000-character field value", "non-5xx", "handled", "PASS"],
        ["TNT-SEC-INP-007", "Privileged extra fields (role, tenantId)", "ignored", "ignored", "PASS"],
        ["TNT-SEC-INP-009", "Wrong Content-Type header", "non-5xx", "handled", "PASS"],
    ], W_TEST5))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("Six of eight passed. Schema validation is thorough and its error messages are well designed — they name the failing field, give a machine-readable code, and suggest a resolution."))
body.append(bullet("A string that is not a GS1 identifier at all is accepted with only a soft warning (UNKNOWN_SGTIN / UNKNOWN_SGLN, severity \"warning\") rather than rejected."))
body.append(bullet("A script tag placed in lotNumber is stored and returned in the response body unescaped."))
body.append(bullet("No SQL error text, stack trace, file path or internal identifier was surfaced by any malformed input."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "The invalid-EPC result conflates two different conditions. \"This is not a parseable GS1 "
    "identifier\" is malformed input and belongs as a 400. \"This is a well-formed SGTIN that "
    "is not yet in master data\" is legitimately a warning, because master data may lag "
    "ingestion. Treating both as warnings lets unparseable identifiers into the ledger, where "
    "they can never be matched back to a physical pack."))
body.append(para(
    "The script-payload result is not yet a proven vulnerability and should not be reported as "
    "one. The API returns application/json, where a script tag is inert. The risk is entirely "
    "downstream: wherever that lot number is rendered in the Regulator, Manufacturer or Events "
    "Explorer interface. That rendering was not tested. If it is rendered without escaping, "
    "this becomes a stored cross-site scripting flaw in a privileged context. Validating "
    "lotNumber server-side would close it regardless of how the UI behaves — GS1 Application "
    "Identifier 10 permits at most 20 alphanumeric characters, so the constraint is already "
    "defined by the standard."))

# --------------------------------------------------------------- 6
body.append(heading("7. Transport and Data Protection", 1))
body.append(table(
    ["Test", "What was checked", "Expected", "Actual", "Verdict"],
    [
        ["TNT-SEC-DATA-011", "Plain HTTP on port 80", "redirect or refuse", "not served", "PASS"],
        ["TNT-SEC-DATA-001", "Security headers on /, /login, /scanner", "CSP+XFO+nosniff+HSTS", "HSTS missing", "FAIL"],
        ["TNT-SEC-DATA-003", "API key passed in the URL query string", "401", "401", "PASS"],
        ["TNT-SEC-DATA-004", "GET on the ingestion endpoint", "no event data", "no event data", "PASS"],
        ["TNT-SEC-DATA-005", "CORS preflight from evil.example.com", "not reflected", "not reflected", "PASS"],
        ["TNT-SEC-DATA-002", "Framework and version banners", "absent", "disclosed", "FAIL"],
    ], W_TEST5))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy and Permissions-Policy are present on all public routes. Only Strict-Transport-Security is absent."))
body.append(bullet("CORS is correctly restrictive — an arbitrary origin is not reflected back."))
body.append(bullet("The API key is rejected when supplied as a URL query parameter, so it cannot leak into access logs or browser history."))
body.append(bullet("Response headers disclose X-Powered-By: Express and Server: nginx/1.18.0 (Ubuntu). The gateway also identifies itself as Apache APISIX via openresty in error pages."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "This is materially better than the tnt-demo environment, where the same headers were "
    "absent from the login page and the public scanner entirely. Here only HSTS is missing, "
    "and its practical risk is reduced by there being no cleartext listener on port 80 to "
    "downgrade to. It should still be added: without it, a first-time visitor typing the bare "
    "hostname has no protection against an active network attacker on that first request."))
body.append(para(
    "Version banners are a low-severity issue on their own. The concern is nginx 1.18.0, a "
    "specific and now-dated version — publishing it lets an attacker match known "
    "vulnerabilities to the deployment without probing for them."))

# --------------------------------------------------------------- 7
body.append(heading("8. Rate Limiting and Brute Force", 1))
body.append(table(
    ["Test", "What was done", "Expected", "Actual", "Verdict"],
    [
        ["TNT-SEC-RATE-001", "60 concurrent valid writes", "no 5xx", "absorbed", "PASS"],
        ["TNT-SEC-RATE-002", "30 concurrent invalid-key attempts", "some 429", "30 x 401, no backoff", "FAIL"],
        ["LOGIN-RATE-001", "15 rapid failed logins on one account", "throttle", "429 after ~3", "PASS"],
    ], W_TEST5))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("The API advertises its budget on every accepted request: x-ratelimit-limit 5000, x-ratelimit-tier supplier, x-ratelimit-reset 60. That is 5,000 per minute, roughly 83 requests per second."))
body.append(bullet("Measured sustained throughput is approximately 35 requests per second (section 8). The advertised budget is therefore about 2.4 times higher than the endpoint can actually serve."))
body.append(bullet("Repeated invalid-key attempts are answered 401 every time with no backoff or lockout."))
body.append(bullet("The web login endpoint does throttle, returning 429 after roughly three failed attempts."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "A published quota that exceeds real capacity sets an expectation the platform cannot "
    "meet. A partner engineering its integration to stay within its stated 5,000 per minute "
    "will drive the endpoint into multi-second queuing and gateway timeouts long before it "
    "ever receives a 429. Either the advertised tier or the underlying capacity needs to "
    "change so the two agree."))
body.append(para(
    "The absence of throttling on invalid keys is a smaller but real gap. Because the keys are "
    "long random strings, brute-forcing one is not a practical threat. The value of throttling "
    "here is detection: an unthrottled endpoint gives no signal that a key-guessing campaign "
    "is under way. The contrast with the login endpoint, which does throttle correctly, "
    "suggests this is an oversight rather than a deliberate decision."))

# --------------------------------------------------------------- 8
body.append(heading("9. Performance — Single-Event Ingestion", 1))
body.append(para("Three k6 runs, covering both the commissioning and the receiving write paths."))
body.append(table(
    ["Endpoint and load profile", "Requests", "Throughput", "p95", "Error rate"],
    [
        ["Commissioning, 10 virtual users", "1,519", "21.7 req/s", "496 ms", "0.00%"],
        ["Receiving, 10 virtual users", "1,872", "26.7 req/s", "461 ms", "see section 12"],
        ["Receiving, 50 virtual users", "3,131", "34.8 req/s", "1.58 s", "0.03%"],
    ], [2900, 1500, 1700, 1300, 1600]))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("Increasing concurrency five-fold, from 10 to 50 virtual users, increased throughput by only 30 percent (26.7 to 34.8 req/s) while p95 latency worsened by a factor of 3.4 (461 ms to 1.58 s)."))
body.append(bullet("That pattern is a queue, not additional capacity. The endpoint serialises work at roughly 35 requests per second and further concurrency simply waits."))
body.append(bullet("Commissioning runs slightly slower than receiving at the same concurrency, 21.7 against 26.7 req/s, which is expected given it creates new identifiers rather than observing existing ones. It met both latency thresholds with a clean 0.00% error rate."))
body.append(bullet("For comparison, the tnt-demo environment plateaued at about 15 req/s under the identical test. TrackIQ is approximately 2.3 times faster."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "The plateau, not the peak, is the number that governs planning. Commissioning is the "
    "constraining path, and at roughly 22 events per second a 100,000-pack production run "
    "takes approximately 76 minutes of continuous ingestion. Whether that is acceptable is a product decision, but it needs to be made "
    "deliberately and communicated to partners, because it directly constrains how a "
    "manufacturer schedules a production line."))
body.append(para(
    "Hypothesis, not confirmed: the ceiling is consistent with a per-event synchronous "
    "validation or master-data lookup executed in a loop rather than in bulk. Confirming this "
    "requires server-side profiling, which was outside the scope of this test."))

# --------------------------------------------------------------- 9 (batch)
body.append(heading("10. Performance — Batch Ingestion", 1))
body.append(para("Single documents containing progressively more events, submitted sequentially."))
body.append(table(
    ["Events per document", "Status", "Elapsed", "Effective rate"],
    [
        ["1", "202 accepted", "0.2 s", "4.3 events/s"],
        ["10", "202 accepted", "0.7 s", "14.7 events/s"],
        ["50", "202 accepted", "2.5 s", "19.9 events/s"],
        ["100", "202 accepted", "5.8 s", "17.3 events/s"],
        ["250", "202 accepted", "19.2 s", "13.0 events/s"],
        ["500", "202 accepted", "32.3 s", "15.5 events/s"],
        ["1,000", "504 Gateway Time-out", "60.4 s", "—"],
        ["5,000", "504 Gateway Time-out", "61.9 s", "—"],
    ], [2600, 2600, 1800, 2000]))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("Batch throughput settles at roughly 13 to 20 events per second and does not improve with larger batches — the cost is linear in the number of events."))
body.append(bullet("A hard 60-second gateway timeout, enforced by APISIX, caps a single document at somewhere between 500 and 1,000 events. The 500-event case completed in 32.3 seconds, comfortably inside the limit; 1,000 events did not."))
body.append(bullet("Batching is slower per event than concurrent single-event requests (roughly 15 events/s batched against 35 req/s concurrent)."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "Batching is the natural thing for an integrator to reach for and, counter-intuitively, it "
    "is the slower option here. That should be stated explicitly in the partner documentation, "
    "along with the practical ceiling, because the current behaviour actively misleads: a "
    "partner that increases its batch size to go faster will get slower, and past roughly 500 "
    "events per document will start receiving gateway timeouts."))
body.append(para(
    "The timeout itself is the more serious issue. A 504 tells the client the request failed, "
    "but the backend continues processing after the gateway has given up. On the tnt-demo "
    "environment this was confirmed directly: events from a timed-out 1,000-event batch were "
    "all present in the ledger when probed afterwards. The same behaviour is likely here but "
    "was not confirmed on TrackIQ. The result is a client that is told \"failed\" about work "
    "that in fact succeeded, with no completion signal and no status endpoint to ask."))
body.append(para(
    "The recommended fix is to accept large batches asynchronously — return 202 with a job "
    "identifier the partner can poll — rather than holding a synchronous connection open past "
    "the gateway timeout."))

# --------------------------------------------------------------- 11 web tier
body.append(heading("11. Performance — Web Tier", 1))
body.append(table(
    ["Route", "TTFB range (3 samples)", "Status", "Verdict"],
    [
        ["/", "88–112 ms", "200", "PASS"],
        ["/login", "67–82 ms", "200", "PASS"],
        ["/scanner", "106–126 ms", "307 redirect", "See note"],
    ], [2400, 3000, 1800, 1800]))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("Server-side HTML delivery is fast and consistent, well within any reasonable budget. Pages are prerendered and edge-cached."))
body.append(bullet("/scanner returns a 307 redirect on this environment rather than serving the scanner directly, unlike tnt-demo where it renders in place."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "These figures measure HTML delivery only, not full page render. They confirm the web tier "
    "is not a bottleneck, but they are not a substitute for measuring time-to-interactive in a "
    "real browser on a representative device — which matters most for the public scanner, the "
    "one screen used by pharmacists and patients on mid-range mobile hardware. That "
    "measurement remains outstanding."))

# --------------------------------------------------------------- 10 stability
body.append(heading("12. Service Stability", 1))
body.append(para("Observed across the full test session rather than by a single deliberate test."))
body.append(table(
    ["Observation window", "Requests", "Outcome"],
    [
        ["07:30–07:35, manual sequential", "~25", "100% HTTP 500"],
        ["10:40, k6 at 10 virtual users", "1,872", "14% HTTP 500 (263 errors)"],
        ["10:42, manual sequential", "40", "0% errors, all 202"],
        ["10:44, k6 at 50 virtual users", "3,131", "0.03% (1 error)"],
    ], [3000, 1600, 4400]))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("The ingestion endpoint returned intermittent HTTP 500 responses that were not attributable to payload content. The same document shape that failed consistently in one window succeeded consistently in another."))
body.append(bullet("Failures were fast, typically 130 to 260 milliseconds, indicating an error raised early rather than a resource or timeout exhaustion."))
body.append(bullet("Payload shape was ruled out by bisection: schema-invalid documents returned a correct 400 throughout, and every document that passed schema validation returned 500 during the affected window regardless of identifier type, business step, JSON-LD context or the presence of optional fields."))
body.append(bullet("Throughout the affected window, GET /api/health continued to report {\"status\":\"ok\"}."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "This is the finding most likely to be missed by routine monitoring, and it is worth being "
    "candid about how it was found: an early draft of this report recorded the endpoint as "
    "completely broken, on the strength of roughly 25 consecutive failures. A later load run "
    "accepted 1,609 events and disproved that. Both observations were accurate; the "
    "conclusion drawn from the first was not."))
body.append(para(
    "That is precisely the danger. An intermittent fault presents as a total outage to whoever "
    "happens to be testing during a bad window, and as a healthy system to whoever tests "
    "afterwards — and the health endpoint agrees with the optimist in both cases, because it "
    "checks only object-storage configuration and never exercises the ingestion path. The "
    "health check should cover a real dependency traversal, and the 500 rate should be alerted "
    "on directly."))
body.append(para(
    "The underlying cause was not identified and cannot be from the client side. Server-side "
    "logs for the affected window, roughly 07:30 to 07:35 UTC on 3 September 2026, would "
    "establish it."))

# --------------------------------------------------------------- 12 portal auth
body.append(heading("13. Web Portal Authentication", 1))
body.append(table(
    ["Test", "What was done", "Result", "Verdict"],
    [
        ["PORTAL-001", "POST to the legacy /api/auth/login", "410 Gone — endpoint retired", "Informational"],
        ["PORTAL-002", "POST to /api/auth/sign-in/email with no Origin", "403 MISSING_OR_NULL_ORIGIN", "PASS"],
        ["PORTAL-003", "Valid credentials with a cross-site Origin", "403 INVALID_ORIGIN", "PASS"],
        ["PORTAL-004", "15 rapid failed attempts on one account", "429 after ~3", "PASS"],
        ["PORTAL-005", "Supplied credentials for all three roles", "401 invalid", "BLOCKED"],
    ], W_TEST))
body.append(para([run("Findings", bold=True)], spacing_after=80))
body.append(bullet("Login has moved to Better Auth at /api/auth/sign-in/email. The legacy endpoint returns 410 Gone with a pointer to the replacement, which is good API hygiene."))
body.append(bullet("Cross-site request forgery protection is enforced by origin checking, and it is enforced before credential evaluation."))
body.append(bullet("Login is rate-limited, unlike the partner API key path."))
body.append(bullet("None of the three supplied credential sets authenticated against /api/auth/sign-in/email. Each returned a genuine 401 INVALID_EMAIL_OR_PASSWORD rather than a throttling response, so these were real credential evaluations and not artefacts of the rate limiter."))
body.append(bullet("Retested after the throttle window cleared, with a correct Origin header and a browser User-Agent, using the credentials exactly as configured. The result was unchanged."))
body.append(bullet("The authentication service itself is healthy: GET /api/auth/ok returns {\"ok\":true} and GET /api/auth/get-session returns null for an anonymous caller, both of which are correct."))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "The three controls that could be tested all passed, and together they are stronger than "
    "the equivalent path on tnt-demo, which had neither origin checking nor login throttling."))
body.append(para(
    "Everything behind the login remains untested: session handling, cookie flags, logout "
    "invalidation, session expiry, role separation in the user interface, and whether stored "
    "input such as the lot number in section 5 is escaped when rendered."))
body.append(para(
    "The credentials have been confirmed as correct as supplied, and the unusual spelling in "
    "staging-manfcaturer@dev.com is intentional. There is therefore a discrepancy between "
    "credentials that are reported to work and a direct API call that rejects them. The most "
    "likely explanations are that the browser client posts a different payload or endpoint "
    "than the one probed here, or that these accounts exist in a different environment's "
    "auth store. The quickest way to settle it is to sign in through the browser with the "
    "developer tools network tab open and capture the actual request the page issues. Until "
    "then this section stays blocked."))

# --------------------------------------------------------------- 13 not covered
body.append(heading("14. Not Covered", 1))
body.append(para("Stated explicitly so the coverage gaps are not mistaken for passes."))
body.append(table(
    ["Area", "Reason not covered"],
    [
        ["Multi-partner isolation of the same role", "Only one manufacturer and one facility key were available; same-role cross-partner tests need two keys per role"],
        ["End-to-end chain across all three partners", "Individual events were tested; a single pack was not carried commission to dispense across all three keys"],
        ["XML ingestion path, including XXE and XML-bomb", "Not attempted — every endpoint has an XML variant, so this is half the ingestion surface"],
        ["Portal session, cookies, logout, role separation in UI", "Blocked on working credentials"],
        ["Stored cross-site scripting in rendered views", "Blocked on working credentials"],
        ["Whether sandbox-relaxed validations are enforced in production", "Cannot be determined from the client side; needs confirmation from the team"],
        ["Public scanner: serial enumeration and timing oracle", "Verification endpoint not identified; /scanner redirects on this environment"],
        ["Soak and endurance testing", "Requires a sustained multi-hour window"],
        ["OWASP ZAP active scan", "Requires written authorisation"],
        ["Key revocation and rotation", "Requires a second key for the same partner"],
    ], [3800, 5600]))
body.append(para([run("Why this matters", bold=True)], spacing_after=80))
body.append(para(
    "The XML gap is the one to close first. Every endpoint in the partner collection accepts "
    "XML as well as JSON-LD, so half the ingestion surface has not been exercised at all — and "
    "XML parsers carry a class of vulnerability, external entity expansion, that the JSON path "
    "does not have. A test suite that covers only JSON-LD gives a misleading impression of "
    "coverage."))

# --------------------------------------------------------------- 14 actions
body.append(heading("15. Recommended Actions", 1))
body.append(table(
    ["Priority", "Action", "Section"],
    [
        ["1", "Confirm which of the five section 4 business rules are enforced in production. Any that are not are live counterfeit-injection routes", "4"],
        ["2", "Bind commissioning to the partner's own registered GS1 company prefix, and reject events at GLNs the partner does not own", "4"],
        ["3", "Enforce custody sequencing: an EPC must be commissioned before it can be shipped, and shipped before it can be received", "4"],
        ["4", "Investigate the intermittent 500s using server logs from 07:30–07:35 UTC; make /api/health exercise the ingestion dependency chain", "12"],
        ["5", "Capture the browser login request to resolve the portal credential discrepancy and unblock section 13", "13"],
        ["6", "Move large-batch ingestion to an asynchronous job with a pollable status, or publish the ~500-event practical ceiling", "10"],
        ["7", "Reconcile the advertised 5,000/min tier with the measured 22-35 req/s capacity", "8, 9"],
        ["8", "Add a lower bound to eventTime validation, matching the existing upper bound", "5"],
        ["9", "Reject structurally invalid EPCs with 400 rather than accepting them with a warning; validate lotNumber against GS1 AI 10", "6"],
        ["10", "Add Strict-Transport-Security; remove X-Powered-By and the nginx version banner", "7"],
        ["11", "Add throttling to repeated invalid-key attempts, matching the login endpoint", "8"],
        ["12", "Exercise the XML ingestion path, including XXE and entity-expansion cases", "14"],
    ], [1000, 6600, 1800]))

today = write_docx(OUT, "TrackIQ — Performance & Security Test Report", body)
print(f"written: {os.path.relpath(OUT, ROOT)}  ({today})")
print(f"sections: {sum(1 for p in body if 'outlineLvl' in p)}")
