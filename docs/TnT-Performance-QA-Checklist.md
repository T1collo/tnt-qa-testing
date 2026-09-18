# TnT — Performance QA Checklist

Track & Trace specific. This replaces the generic P01–P20 web-app checklist: a generic list
asks "does the dashboard load"; a track-and-trace system lives or dies on **serialised event
ingestion throughput** and **consumer verification latency**, so those are the checks that
carry weight here.

**System under test**

| Surface | What it is |
|---|---|
| Web app | `https://tnt-demo.apeiro-digital.com` — Next.js portals for Regulator (PPB), Manufacturer, Distributor, Facility, plus the public `/scanner` |
| Partner EPCIS API | `https://tnt-demo.apeiro-digital.com/api/integration/{manufacturer\|supplier\|facility}/events` — POST-only EPCIS 2.0 ingestion, `X-API-Key` auth |

> **Base-URL trap.** The API is at the **host root**. `…/new/api/integration/…` resolves to a
> *different backend environment* and rejects this environment's tokens with
> `Invalid API key for this environment`. Point load tools at the root, never at `/new`.

**Severity key** — 🔴 Critical · 🟠 High · 🟡 Medium · 🔵 Low · ⚪ Info

---

## A. Consumer verification path (highest business risk)

A patient or pharmacist scanning a pack is the one interaction with a hard human deadline.
If verification is slow, people stop scanning, and an unscanned pack is an unprotected pack.

| # | Check | Target | Pass/Fail | Notes/Evidence |
|---|---|---|---|---|
| TNT-PERF-001 | Public `/scanner` page is interactive on a mid-range mobile over 4G | TTI < 3 s | ☐ | |
| TNT-PERF-002 | Single GTIN+serial verification returns a verdict | p95 < 1.5 s | ☐ | |
| TNT-PERF-003 | Verification latency holds while ingestion load runs concurrently | p95 < 2.5 s | ☐ | |
| TNT-PERF-004 | Verification of an **unknown/counterfeit** serial is no slower than a valid one | within 2× valid-path p95 | ☐ | |
| TNT-PERF-005 | Scanner remains usable on a flaky/intermittent connection | graceful retry, no lockup | ☐ | |

> TNT-PERF-004 matters more than it looks: if "not found" is measurably slower than "found",
> the response time itself becomes an oracle a counterfeiter can use to mine valid serials
> without ever reading the response body.

## B. Event ingestion — the core write path

| # | Check | Target | Pass/Fail | Notes/Evidence |
|---|---|---|---|---|
| TNT-PERF-006 | Commission (ObjectEvent), single event, baseline latency | p95 < 800 ms, p99 < 1.5 s | ☐ | |
| TNT-PERF-007 | Pack / Aggregation (item → case) latency | p95 < 1 s | ☐ | |
| TNT-PERF-008 | Nested aggregation (case → pallet, SSCC into SSCC) latency | p95 < 1.5 s | ☐ | |
| TNT-PERF-009 | Ship (manufacturer) latency | p95 < 1 s | ☐ | |
| TNT-PERF-010 | Receive (distributor `/supplier`) latency | p95 < 1 s | ☐ | |
| TNT-PERF-011 | Receive + Dispense (facility) latency | p95 < 1 s | ☐ | |
| TNT-PERF-012 | Bulk batch of 100 events in one document | accepted, < 5 s | ☐ | |
| TNT-PERF-013 | Bulk batch of 1,000 events in one document | accepted or cleanly rejected with a documented cap | ☐ | |
| TNT-PERF-014 | Oversized batch (5,000+ events) is **bounded** | fast 4xx with a stated limit — never a 504 | ☐ | |
| TNT-PERF-015 | Duplicate/idempotency detection does not degrade under load | dedup p95 within 1.5× of a fresh write | ☐ | |
| TNT-PERF-016 | XML payloads perform comparably to JSON-LD | within 1.5× of JSON-LD p95 | ☐ | |

> TNT-PERF-014 is the batch-size question every serialisation rollout hits. A manufacturer
> commissioning a production run will try to send the whole run in one document. The system
> must state a cap and enforce it quickly, because the alternative — accepting the request and
> timing out at the gateway 120 s later — leaves the client with **no idea whether the events
> were recorded**, which is the worst possible outcome for a chain-of-custody ledger.

## C. Load, scale and stability

| # | Check | Target | Pass/Fail | Notes/Evidence |
|---|---|---|---|---|
| TNT-PERF-017 | Sustained manufacturer ingestion at expected peak | error rate < 1 %, p95 < 800 ms | ☐ | |
| TNT-PERF-018 | Measured throughput ceiling (req/s plateau) | ≥ documented tier floor | ☐ | |
| TNT-PERF-019 | All three partner roles ingesting concurrently | no cross-role degradation | ☐ | |
| TNT-PERF-020 | Spike test — sudden 10× burst | absorbed or throttled; no 5xx | ☐ | |
| TNT-PERF-021 | Soak test — expected load sustained 2 h+ | no latency drift, no memory growth | ☐ | |
| TNT-PERF-022 | Rate limiting matches the documented partner tier | 429 at the documented threshold | ☐ | |
| TNT-PERF-023 | No gateway timeouts at expected load | zero 502/503/504 | ☐ | |
| TNT-PERF-024 | System recovers to baseline after stress | p95 back within 20 % of baseline in < 5 min | ☐ | |
| TNT-PERF-025 | Auth/rejection path stays correct under load | invalid keys still 401 — not 500 | ☐ | |
| TNT-PERF-036 | Advertised rate-limit tier is achievable at measured capacity | tier ≤ real ceiling | ☐ | |

> TNT-PERF-025 is not a normal performance check. It is here because a rejection path that
> degrades into `500 Internal Server Error` under pressure is invisible to a load test that
> only measures the happy path, and it destroys your ability to distinguish an attack from an
> outage in the logs.

## D. Query, reporting and UI at realistic data volume

| # | Check | Target | Pass/Fail | Notes/Evidence |
|---|---|---|---|---|
| TNT-PERF-026 | Login → first authenticated page, per role | < 3 s | ☐ | |
| TNT-PERF-027 | Regulator dashboard renders | < 3 s | ☐ | |
| TNT-PERF-028 | Product journey / full traceability lookup for a deep hierarchy | < 4 s | ☐ | |
| TNT-PERF-029 | Events Explorer filter + sort over a realistic event volume | < 2 s | ☐ | |
| TNT-PERF-030 | Pagination through a large event list | consistent per-page time, no drift | ☐ | |
| TNT-PERF-031 | Large master-data tables do not freeze the browser | no long task > 200 ms | ☐ | |
| TNT-PERF-032 | Manufacturer batches/packages list at realistic volume | < 3 s | ☐ | |
| TNT-PERF-033 | Recall dashboard computes affected-stock scope | < 5 s | ☐ | |
| TNT-PERF-034 | Report/CSV export generation and download | completes, no timeout | ☐ | |
| TNT-PERF-035 | Rules-engine evaluation does not stall ingestion | ingestion p95 unchanged when rules are active | ☐ | |

---

## What to record for every load run

A verdict of "performance passed" with no numbers behind it is not a QA result. Capture:

```text
Target URL:
Role / endpoint:
Load profile:        (VUs or arrival rate, ramp, hold)
Duration:
Requests:
Throughput:          req/s
Avg / p90 / p95 / p99:
Max response time:
Error rate:          %
Non-2xx breakdown:   (401 / 403 / 409 / 429 / 5xx counts)
Timeouts:
Recovery time after stop:
```

Two numbers deserve special attention in a track-and-trace system:

- **Throughput plateau.** If req/s stops rising as you add concurrency, you have found the
  ceiling. Report the plateau, not the peak VU count — the plateau is what caps how fast a
  manufacturer can commission a production run.
- **409 rate.** Duplicate-event rejections are *correct* behaviour, so they must be counted
  separately from real errors. Folding them into "error rate" understates your success rate;
  folding them into "success" hides a client that is retrying blindly.

## Tooling

```bash
# Load — manufacturer commissioning
k6 run -e MANUFACTURER_API_TOKEN=$TOKEN \
       -e BASE_URL=https://tnt-demo.apeiro-digital.com \
       k6/load-manufacturer-commission.js

# Stress / spike — find the ceiling
k6 run -e MANUFACTURER_API_TOKEN=$TOKEN k6/stress-manufacturer-commission.js

# Rate-limit verification — constant arrival rate
k6 run -e MANUFACTURER_API_TOKEN=$TOKEN -e TARGET_RPS=150 \
       k6/rate-limit-manufacturer-commission.js

# Data integrity under concurrency
k6 run -e MANUFACTURER_API_TOKEN=$TOKEN k6/data-integrity-manufacturer-commission.js
node k6/check-data-integrity-log.js
```
