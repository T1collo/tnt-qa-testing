"""Builds reports/TnT_API_Confirmed_Findings.docx - a dev-facing summary of only what we
have directly confirmed via real executed test runs against the live sandbox
(https://trackiq.apeiro-digital.com/new). No speculation presented as fact; anything we
believe but haven't proven is explicitly labeled as a hypothesis, not a finding.
"""
from docx_helpers import run, para, heading, bullet, table, write_docx

OUT_PATH = "reports/TnT_API_Confirmed_Findings.docx"

body = []

# --- Title ---
body.append(f'<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>{run("TnT Partner API", bold=True, sz="44", color="1F4E78")}</w:p>')
body.append(f'<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>{run("Confirmed Performance & Reliability Findings", bold=True, sz="26")}</w:p>')
body.append(para([run("For: engineering team (manufacturer Commission endpoint)", italic=True, color="595959")]))
body.append(para([run("Environment: https://trackiq.apeiro-digital.com/new  |  Tool: k6", italic=True, color="595959")]))

# --- How to read this doc ---
body.append(heading("How to read this document", 1))
body.append(para(
    "Every finding below was produced by an actual test run against the live sandbox, not "
    "estimated or assumed. Where we have a theory about WHY something happens but haven't "
    "proven it, that's labeled “Likely cause (not confirmed)” so it doesn't get "
    "mistaken for a verified fact. Raw numbers for every run are in the summary table at the "
    "end if you want to check our math."
))

# --- Glossary ---
body.append(heading("Quick terms", 1))

def glossary_item(term, definition):
    return para([run(f"{term}: ", bold=True), run(definition)], indent=360)

body.append(glossary_item("VU (Virtual User)", "one simulated client hitting the API. “150 VUs” = 150 requests happening at once, each one looping (send request → wait for reply → send the next)."))
body.append(glossary_item("Throughput", "how many requests actually finish per second - the real measure of capacity, as opposed to how many you're trying to send."))
body.append(glossary_item("p95 / p99", "“95% (or 99%) of requests were faster than this.” E.g. p95 = 336ms means only 1 in 20 requests was slower than that."))
body.append(glossary_item("HTTP 5xx / 429", "5xx = the server broke while handling your request (its fault). 429 = “you're sending too many requests, slow down” (a controlled, intentional rejection, not a crash)."))
body.append(para(""))

# --- Finding 1 ---
body.append(heading("Finding 1 — Confirmed bug: bad input crashes the endpoint instead of being rejected cleanly", 1))
body.append(para([run("What we did: ", bold=True), run(
    "sent a Commission event using the exact GLN (10000000.00009.0) and GTIN prefix "
    "(6161102974997) from the Postman collection's own example."
)]))
body.append(para([run("What happened: ", bold=True), run("HTTP 500, every single time, with no useful detail: "), run('{"statusCode":500,"message":"Internal server error"}', italic=True), run(".")]))
body.append(para([run("How we know it's the identifiers specifically: ", bold=True), run(
    "changing nothing except the GLN/GTIN (to a different, GS1-format-valid pair) made the "
    "exact same request succeed with HTTP 202. We flipped one variable and the failure "
    "disappeared - that's about as confirmed as a root cause gets."
)]))
body.append(para([run("Why it matters: ", bold=True), run(
    "a malformed or unrecognized identifier should return a normal 4xx validation error, not "
    "a 500. A 500 means the server hit an unhandled exception - i.e. a code path that isn't "
    "catching a case it should be catching."
)]))

# --- Finding 2 ---
body.append(heading("Finding 2 — Confirmed: healthy and fast at 10 concurrent users", 1))
results_rows = [
    ["Requests sent", "3,817"],
    ["Errors", "0 (0%)"],
    ["p95 latency", "336ms"],
    ["p99 latency", "380ms"],
]
body.append(table(["Metric", "Result"], results_rows, [3200, 5600]))
body.append(para([run("In plain terms: ", bold=True), run("at a realistic, everyday load (10 concurrent users), this endpoint just works - fast, zero errors.")]))

# --- Finding 3 ---
body.append(heading("Finding 3 — Confirmed: throughput stops scaling around 35-40 requests/second, no matter how much concurrency is applied", 1))
body.append(para([run(
    "This is the strongest finding in this document because it wasn't observed once - it showed up independently in three separate test runs, using two different testing methods:"
)]))
throughput_rows = [
    ["Stress test, up to 150 VUs", "~37.5 req/s completed"],
    ["Stress test, up to 500 VUs", "~42.5 req/s completed (before the endpoint started failing outright — see Finding 4)"],
    ["Rate-limit test, 150 req/s attempted via a different k6 execution mode", "~36.8 req/s completed"],
]
body.append(table(["Test", "Actual completed throughput"], throughput_rows, [5200, 3600]))
body.append(para([run("In plain terms: ", bold=True), run(
    "going from 10 concurrent users to 150 (15x more) only moved completed throughput from "
    "~32 to ~37 req/s. Adding more concurrent requests doesn't get more work done - it just "
    "makes each individual request wait longer. That's the signature of a fixed-size "
    "bottleneck somewhere in the pipeline, not the endpoint itself being slow per-request."
)]))
body.append(para([run("Likely cause (not confirmed): ", bold=True, color="9C5700"), run(
    "a queue or a database/connection-pool size limit on the async ingestion path. We have "
    "not looked at server-side code or infrastructure to confirm this - it's the standard "
    "explanation for “throughput is flat regardless of concurrency,” but it's an "
    "inference from the outside, not a verified cause.", color="9C5700"
)]))

# --- Finding 4 ---
body.append(heading("Finding 4 — Confirmed: the endpoint genuinely breaks somewhere between 150 and 500 concurrent requests", 1))
breaking_rows = [
    ["Unhandled crashes (5xx)", "282 out of 6,683 requests (4.21%)"],
    ["No response at all (timeout/dropped)", "482 requests"],
    ["Average latency", "8.06 seconds"],
    ["p95 / max latency", "13.31s / 13.72s (essentially pinned at a ceiling, consistent with a timeout being hit)"],
]
body.append(table(["Metric at 500 concurrent VUs", "Result"], breaking_rows, [4200, 4600]))
body.append(para([run("In plain terms: ", bold=True), run(
    "below this range, the system slows down under pressure but doesn't lose or corrupt "
    "anything (see Finding 3). Above it, it genuinely fails - a real fraction of requests "
    "crash outright, and a comparable number just vanish with no answer at all. To a caller "
    "with any normal timeout configured, this range would look completely unavailable."
)]))

# --- Finding 5 ---
body.append(heading("Finding 5 — Rate limiting (HTTP 429) was never observed — inconclusive, not confirmed broken", 1))
body.append(para([run(
    "The documented manufacturer tier budget is 5,000-10,000 requests/minute (~83-166 req/s). "
    "Across three high-volume runs (Findings 3 and 4 above, plus a dedicated rate-limit test), "
    "we never once received an HTTP 429."
)]))
body.append(para([run("Why this is NOT the same as “rate limiting is broken”: ", bold=True), run(
    "per Finding 3, this endpoint cannot actually complete more than ~35-40 requests/second no "
    "matter what we throw at it. To trigger a 5,000/min budget you need ~83 completed "
    "requests/second sustained - which this endpoint has never once achieved in our testing. "
    "We ran out of the ability to generate enough real request volume before we could ever "
    "reach the threshold that would trip a rate limiter. This needs a dedicated test once "
    "Finding 3/4 is addressed, or a direct answer from whoever owns the rate-limiting code on "
    "how it's actually configured."
)]))

# --- Finding 6 ---
body.append(heading("Finding 6 — Confirmed (small-scale check): no ID mix-ups under concurrent requests", 1))
body.append(para([run("What we checked: ", bold=True), run(
    "sent 10 concurrent Commission requests, each with a unique event ID, and checked that "
    "each response acknowledged exactly the ID that specific request sent - not someone "
    "else's ID, not a missing ID, not a duplicate."
)]))
body.append(para([run("Result: ", bold=True), run("10 out of 10 clean. No cross-request contamination at the acknowledgment layer.")]))
body.append(para([run("Scope limit: ", bold=True, color="9C5700"), run(
    "this only checked the immediate response (“did you acknowledge the right ID”), "
    "not whether the event was actually stored correctly afterward - the API only accepts "
    "writes (no read/query endpoint), so we can't yet confirm data lands correctly in storage, "
    "only that the API isn't scrambling IDs on the way in. Also only 10 requests so far, not "
    "a large-scale run.", color="9C5700"
)]))

# --- Summary table ---
body.append(heading("All raw numbers, side by side", 1))
summary_rows = [
    ["Load (10 VUs)", "3,817", "0%", "336ms / 380ms", "0"],
    ["Stress (150 VUs)", "6,746", "0%", "n/a (see Finding 3)", "0"],
    ["Stress (500 VUs)", "6,683", "4.21%", "13.31s / 13.72s", "282"],
    ["Rate-limit attempt", "3,580 sent (9,921 dropped by k6)", "0%", "n/a", "0"],
    ["Data integrity (smoke)", "10", "0%", "n/a", "0"],
]
body.append(table(["Test", "Requests completed", "Error rate", "p95 / max latency", "Crashes (5xx)"], summary_rows, [1900, 2000, 1300, 1900, 1700]))

# --- Scope note ---
body.append(heading("What this document does not cover", 1))
body.append(bullet("Spike, soak/endurance, and race-condition testing have not been run yet."))
body.append(bullet("Only the manufacturer Commission endpoint has been tested. Distributor, facility, and other event types are untested."))
body.append(bullet("Data integrity has only been checked at the acknowledgment layer on a small sample (Finding 6) - actual storage/persistence has not been independently verified."))

today = write_docx(OUT_PATH, "TnT Partner API Confirmed Findings", body)
print(f"wrote {OUT_PATH} (dated {today})")
