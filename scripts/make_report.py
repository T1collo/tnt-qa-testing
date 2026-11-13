"""Builds reports/TnT_Nonfunctional_Testing_Findings.docx using only the Python standard
library (zipfile) - a .docx is just a zip of OOXML parts, so no third-party package (e.g.
python-docx) is needed. One-off report generator, not part of the app; safe to delete after
the report is produced.
"""
import zipfile
from datetime import date

OUT_PATH = "reports/TnT_Nonfunctional_Testing_Findings_v3.docx"

def esc(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )

def run(text, bold=False, sz=None, color=None, italic=False):
    props = ""
    if bold or sz or color or italic:
        parts = []
        if bold:
            parts.append("<w:b/>")
        if italic:
            parts.append("<w:i/>")
        if color:
            parts.append(f'<w:color w:val="{color}"/>')
        if sz:
            parts.append(f'<w:sz w:val="{sz}"/>')
        props = f"<w:rPr>{''.join(parts)}</w:rPr>"
    return f'<w:r>{props}<w:t xml:space="preserve">{esc(text)}</w:t></w:r>'

def para(runs, spacing_after=160, indent=None):
    if isinstance(runs, str):
        runs = [run(runs)]
    ind = f'<w:ind w:left="{indent}"/>' if indent else ""
    return f'<w:p><w:pPr><w:spacing w:after="{spacing_after}"/>{ind}</w:pPr>{"".join(runs)}</w:p>'

def heading(text, level=1):
    sz = {1: "32", 2: "26", 3: "22"}.get(level, "22")
    return f'<w:p><w:pPr><w:spacing w:before="320" w:after="160"/><w:outlineLvl w:val="{level-1}"/></w:pPr>{run(text, bold=True, sz=sz, color="1F4E78")}</w:p>'

def bullet(text):
    return para([run("•  "), run(text)], indent=360)

def cell(text, width, header=False, shade=None):
    shd = f'<w:shd w:val="clear" w:color="auto" w:fill="{shade}"/>' if shade else ""
    r = run(text, bold=header)
    return (
        f'<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/>{shd}'
        f'<w:tcMar><w:top w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/>'
        f'<w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr>'
        f'<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>{r}</w:p></w:tc>'
    )

def table(headers, rows, widths):
    tbl_borders = (
        '<w:tblBorders>'
        '<w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
        '<w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
        '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
        '<w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
        '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
        '</w:tblBorders>'
    )
    grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
    head_row = "<w:tr>" + "".join(cell(h, w, header=True, shade="1F4E78") for h, w in zip(headers, widths)) + "</w:tr>"
    # header text needs to be white-on-dark; simplest is swap shade + bold black is fine too.
    body_rows = ""
    for row in rows:
        body_rows += "<w:tr>" + "".join(cell(v, w) for v, w in zip(row, widths)) + "</w:tr>"
    return (
        f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>{tbl_borders}</w:tblPr>'
        f'<w:tblGrid>{grid}</w:tblGrid>{head_row}{body_rows}</w:tbl>'
        f'<w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p>'
    )

today = date.today().isoformat()

body_parts = []

body_parts.append(f'<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>{run("TnT Partner API", bold=True, sz="44", color="1F4E78")}</w:p>')
body_parts.append(f'<w:p><w:pPr><w:spacing w:after="320"/></w:pPr>{run("Non-Functional & Performance Testing — Findings and Test Plan", bold=True, sz="26")}</w:p>')
body_parts.append(para([run(f"Prepared: {today}", italic=True, color="595959"), run("    |    ", color="595959"), run("Target: https://trackiq.apeiro-digital.com/new (confirmed, sandbox environment)", italic=True, color="595959")]))

body_parts.append(heading("1. Executive Summary", 1))
body_parts.append(para(
    "This report captures diagnostic findings from initial testing of the TnT partner EPCIS "
    "API, the root cause of an early blocking issue and its resolution, results from the first "
    "real load test run, and a k6-based non-functional/performance test plan covering load, "
    "stress, spike, soak, concurrency, latency, scalability, resilience, data integrity, and "
    "rate-limit verification."
))
body_parts.append(para([run("Headline findings: ", bold=True), run(
    "(1) early diagnostic requests returned a generic HTTP 500 regardless of partner role or "
    "event type — caused by invalid GLN/GTIN identifiers in the Postman collection's own "
    "Commission example, not a systemic outage; corrected, a load test (3,817 requests at 10 "
    "VUs) then ran with a 0% error rate. (2) A stress test found a real breaking point between "
    "150 and 500 concurrent VUs: throughput plateaus around 35-40 req/s regardless of added "
    "concurrency, then above the breaking point 4.21% of requests crash outright and others "
    "time out with no response. See Sections 2–5."
)]))

body_parts.append(heading("2. Diagnostic Finding: Current System Health", 1))
body_parts.append(para([run("Evidence.", bold=True), run(
    " Three sampled runs (manufacturer / Commission; distributor / Error Declaration × 2), "
    "covering both JSON-LD and XML request variants, all returned the identical body:"
)]))
body_parts.append(para([run('{"statusCode":500,"message":"Internal server error"}', italic=True)], indent=360))
body_parts.append(para(
    "That response shape is a generic, unstyled NestJS unhandled-exception response — "
    "consistent with the server crashing before or during request processing, not a clean "
    "validation rejection (no 400 with field detail) or a clean auth rejection (no 401/403)."
))
body_parts.append(para([run("This has since been root-caused and resolved — see Section 3.", bold=True, color="1F7A1F")]))

body_parts.append(heading("3. Root Cause & Resolution", 1))
body_parts.append(para([run("Confirmed correct, once a valid token and the ", ), run("X-API-Key", italic=True), run(
    " header were used: base URL https://trackiq.apeiro-digital.com/new, auth header "
    "X-API-Key (not Authorization: Bearer, despite the workbook's Test Steps prose)."
)]))
body_parts.append(para([run("The actual root cause: ", bold=True), run(
    "the Commission (ObjectEvent) example payload in the Postman collection — and therefore "
    "the first draft of the load-test script, which copied it — used a GLN "
    "(10000000.00009.0) and GTIN prefix (6161102974997) that the commissioning endpoint "
    "cannot handle gracefully. Every request built from that example returned the generic "
    "500 above, with a valid token, against the correct URL. A manually supplied working "
    "example (a “Stolen” status-change event using a GS1 sample company prefix, "
    "0123456) succeeded with HTTP 202 and only soft validation warnings."
)]))
body_parts.append(para([run("Isolating the difference: ", bold=True), run(
    "rebuilding the commissioning payload with the same 0123456-prefixed GLN/GTIN pattern, "
    "changing nothing else about the request, immediately fixed it — HTTP 202, "
    "{\"success\": true, ...}. The commissioning endpoint appears to throw an unhandled "
    "exception on certain unregistered/malformed identifier shapes instead of returning a "
    "clean 4xx, while other event types (e.g. status changes) tolerate unregistered "
    "identifiers with a soft warning. This is arguably a real defect worth reporting to the "
    "API team: a bad request should not be able to 500 a shared endpoint."
)]))
body_parts.append(para([run("k6/load-manufacturer-commission.js", italic=True), run(
    " was updated to generate GS1-valid-format identifiers (0123456 company prefix, numeric "
    "serials) instead of the broken example data, and now passes cleanly — see Section 5."
)]))

body_parts.append(heading("4. Load Test Results — Manufacturer Commission", 1))
body_parts.append(para([run("Profile: ", bold=True), run("ramp to 10 concurrent VUs over 30s, hold 1 minute, ramp down 30s (default script settings, run against the live sandbox).")]))
results_rows = [
    ["Total requests", "3,817"],
    ["Error rate", "0.00% (0 failed)"],
    ["Checks passed", "7,634 / 7,634 (100%) — status 201/202 and body.success === true"],
    ["Throughput", "≈31.8 req/s sustained at 10 VUs"],
    ["Latency — average", "239ms"],
    ["Latency — p95", "336ms (threshold: < 800ms) — PASS"],
    ["Latency — p99", "380ms (threshold: < 1500ms) — PASS"],
    ["Latency — max", "702ms"],
]
body_parts.append(table(["Metric", "Result"], results_rows, [3200, 5600]))
body_parts.append(para([run("Result: ", bold=True, color="1F7A1F"), run("clean pass — 0% errors, both latency thresholds comfortably met at this volume.", color="1F7A1F")]))

body_parts.append(heading("5. Stress Test Results — Manufacturer Commission", 1))
body_parts.append(para(
    "Escalated well past the load test's proven-healthy 10 VUs in two runs, using "
    "k6/stress-manufacturer-commission.js, to find where the endpoint actually breaks and "
    "whether it degrades gracefully or crashes."
))
stress_rows = [
    ["Stage 1 — up to 150 VUs", "6,746 requests, 0% errors, 0 unhandled crashes. Throughput barely moved from the 10-VU baseline (~37.5 vs. ~31.8 req/s) while latency rose sharply (avg 133ms → 2.46s, p95 4.13s) — consistent with a saturated queue, not a failure."],
    ["Stage 2 — up to 500 VUs", "6,683 requests. 282 unhandled crashes (4.21%), 482 requests that never received a response at all (network-level timeout/drop), latency climbing to avg 8.06s / p95 13.31s / max 13.72s (essentially pinned at what looks like a ~14s timeout ceiling)."],
]
body_parts.append(table(["Stage", "Result"], stress_rows, [2400, 6400]))
body_parts.append(para([run("Finding: ", bold=True), run(
    "the breaking point sits between 150 and 500 concurrent VUs. Below it, the system is "
    "resilient — it slows down under pressure rather than erroring. Above it, it genuinely "
    "fails: a meaningful fraction of requests crash outright or time out with no response at "
    "all, and latency is high enough (8-14s) to functionally look unavailable to a caller with "
    "any reasonable timeout of its own."
)]))
body_parts.append(para([run("Read on capacity: ", bold=True), run(
    "throughput staying flat around ~35-40 req/s from 10 VUs all the way to 150 VUs (i.e. "
    "adding concurrency doesn't add completed work) points to a fixed-size bottleneck "
    "somewhere in the async ingestion path — most likely a queue or a database/connection-pool "
    "limit — rather than the endpoint itself being slow per-request. Worth investigating "
    "server-side rather than assuming more client concurrency would help."
)]))

body_parts.append(heading("6. Proposed Non-Functional Test Plan", 1))
plan_rows = [
    ["Load", "Behavior at expected real-world volume", "Concurrent manufacturers/distributors/facilities submitting commission/pack/ship events", "p95/p99 latency within SLA; error rate ~0%"],
    ["Stress", "Where it breaks", "Ramp VUs well past expected volume", "Breaking point identified; degrades gracefully (429/503), not crashes (500)"],
    ["Spike", "Sudden burst handling", "Large batch commission near the 50,000-serial/message limit; shipment flood", "System absorbs or cleanly rejects; no cascading failure"],
    ["Soak / endurance", "Degradation over time", "Moderate sustained load, 1hr+", "Latency/error rate stay flat — no memory-leak-shaped drift"],
    ["Concurrent users", "Many simultaneous distinct partners", "Parallel VUs per role, each with own token/GLN", "No cross-partner interference; correct isolation"],
    ["Concurrency / race conditions", "Conflicting simultaneous writes", "Two simultaneous “pack” events on the same child EPC/SSCC", "Exactly one wins cleanly (409); no silent double-aggregation"],
    ["Latency", "Response-time SLA", "Tracked per endpoint across all scenarios above", "Defined p95/p99 thresholds hold under load"],
    ["Scalability", "Does throughput scale linearly", "Staged VU ramp (10→50→200→500…)", "Identify the stage where the latency/error curve bends"],
    ["Resilience", "Recovery after failure/load", "Error rate/latency in the minutes after a stress/spike run ends", "Returns to baseline; no lingering degradation"],
    ["Data integrity", "No lost/duplicated events under load", "Read back via Events Explorer after a concurrent burst", "Zero dropped, zero duplicated EPCIS events — compliance-critical, not optional"],
    ["Rate limiting", "429 enforcement", "Exceed a partner's documented request-tier budget", "429 returned at the documented threshold, not silently accepted or 500'd"],
]
body_parts.append(table(
    ["Area", "Validates", "Key Scenario", "Success Criteria"],
    plan_rows,
    [1500, 1800, 2900, 2600],
))

body_parts.append(heading("7. Practical Constraints", 1))
body_parts.append(bullet("Test data must be unique per iteration — EPCIS events are one-shot; a duplicate eventID is hard-rejected (API-MFG-COMM-EDGE-001), so payloads need dynamically generated SGTINs/SSCCs/eventIDs, not the static Postman examples."))
body_parts.append(bullet("Identifiers must also be GS1-structurally-valid, not just unique — see Section 3. The working pattern (0123456 company prefix, numeric serials) is shared by both delivered scripts via k6/lib/epcis.js."))
body_parts.append(bullet("Tokens are passed via environment variables at run time only — never hardcoded or committed, consistent with how this project already handles credentials."))
body_parts.append(bullet("This targets a live, shared partner sandbox environment (_sandbox: true in every response) — between the load and stress runs, roughly 17,000 real commissioning events have already been written to it today. Further high-volume runs should be coordinated with whoever owns it."))

body_parts.append(heading("8. Delivered Scripts", 1))
body_parts.append(para([run("k6/lib/epcis.js", italic=True), run(" — shared payload builder used by both scripts below, encapsulating the confirmed-working identifier shape from Section 3.")]))
body_parts.append(para([run("k6/load-manufacturer-commission.js", italic=True), run(
    " — ramps to a configurable number of concurrent VUs, holds, ramps down. Asserts p95 < "
    "800ms, p99 < 1500ms, error rate < 1%, status 201/202, and success: true in the body."
)]))
body_parts.append(para([run("Run: ", bold=True), run("k6 run -e MANUFACTURER_API_TOKEN=xxx k6/load-manufacturer-commission.js", italic=True)]))
body_parts.append(para([run("k6/stress-manufacturer-commission.js", italic=True), run(
    " — ramps through configurable escalating VU stages (default 25/75/150) to find the "
    "breaking point. Classifies every response as success, graceful degradation (429/503), "
    "unhandled crash (5xx), network error, or other — the pass/fail signal is zero unhandled "
    "crashes, not zero errors."
)]))
body_parts.append(para([run("Run: ", bold=True), run("k6 run -e STAGE_VUS=200,350,500 -e MANUFACTURER_API_TOKEN=xxx k6/stress-manufacturer-commission.js", italic=True)]))
body_parts.append(para([run("Status: ", bold=True, color="1F7A1F"), run(
    "both executed against the live sandbox — see Sections 4 and 5 for real results.", color="1F7A1F"
)]))

body_parts.append(heading("9. Next Steps", 1))
body_parts.append(bullet("Flag two findings to the API team: (a) a malformed/unregistered identifier on the commissioning endpoint returns a bare 500 instead of a clean 4xx (Section 3); (b) throughput plateaus around 35-40 req/s regardless of concurrency, then degrades into timeouts and crashes above ~150-500 concurrent requests (Section 5) — worth investigating as a queue/connection-pool sizing issue."))
body_parts.append(bullet("Build out the remaining scripts (spike, soak, concurrency/race-condition, rate-limit, data-integrity read-back checks) reusing k6/lib/epcis.js and the same pattern."))
body_parts.append(bullet("Extend coverage to the distributor and facility roles and their event types, not just manufacturer commissioning."))
body_parts.append(bullet("Narrow the 150-500 VU breaking-point range with a bisecting run (e.g. 250, 300) if a precise capacity number is needed."))

document_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
{''.join(body_parts)}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>
</w:body>
</w:document>'''

content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>'''

rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>'''

core_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>TnT Partner API Non-Functional Testing Findings</dc:title>
<dc:creator>TnT QA</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">{today}T00:00:00Z</dcterms:created>
</cp:coreProperties>'''

with zipfile.ZipFile(OUT_PATH, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", rels)
    z.writestr("docProps/core.xml", core_xml)
    z.writestr("word/document.xml", document_xml)

print(f"wrote {OUT_PATH}")
