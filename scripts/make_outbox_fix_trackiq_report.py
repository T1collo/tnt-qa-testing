"""TrackIQ-only QA report: epcis_outbox sequence fix verification (for Devs + PMO).
Includes the 5,000-request burst and a full appendix of batch + event IDs.
"""
from pathlib import Path
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from docx_helpers import run, para, heading, bullet, table, write_docx  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = ROOT / "security" / "results" / "outbox-fix-5k-2026-10-02T10-53-38-130Z"
OUT_PATH = "reports/TnT_TrackIQ_Outbox_Sequence_Fix_Verification_2026-10-02_5k.docx"

summary = json.loads((RESULTS_DIR / "summary.json").read_text(encoding="utf-8"))
event_ids = [
    line.strip()
    for line in (RESULTS_DIR / "event-ids.txt").read_text(encoding="utf-8").splitlines()
    if line.strip()
]

batch_id = summary["batchId"]
lot_number = summary["lotNumber"]
run_id = summary["runId"]
count = summary["count"]

body = []

# --- Title ---
body.append(
    f'<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>'
    f'{run("TrackIQ Partner API", bold=True, sz="44", color="1F4E78")}</w:p>'
)
body.append(
    f'<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>'
    f'{run("Outbox Sequence Fix — Verification Report", bold=True, sz="28")}</w:p>'
)
body.append(
    para(
        [
            run("Audience: ", bold=True, color="595959"),
            run("Engineering & PMO  |  ", color="595959"),
            run("Environment: ", bold=True, color="595959"),
            run("https://trackiq.apeiro-digital.com  |  ", color="595959"),
            run("Date: ", bold=True, color="595959"),
            run("2 October 2026", color="595959"),
        ]
    )
)
body.append(
    para(
        [
            run("Verdict: ", bold=True),
            run("PASS", bold=True, color="006400"),
            run(
                f" — {count:,} individual manufacturer event POSTs on TrackIQ returned "
                "HTTP 202 with zero HTTP 5xx and no epcis_outbox_pkey signals."
            ),
        ]
    )
)

# --- Executive summary ---
body.append(heading("1. Executive summary", 1))
body.append(
    para(
        "Staging had intermittent HTTP 500 responses on Partner "
        "POST /api/integration/manufacturer/events. Root cause was not application logic "
        "in the outbox writer: after an import/restore, the Postgres sequence "
        "epcis_outbox_id_seq lagged behind max(epcis_outbox.id). New inserts reused IDs, "
        "hit unique constraint epcis_outbox_pkey, rolled back the ingest transaction, and "
        "returned a generic Internal server error to the partner."
    )
)
body.append(
    para(
        "Ops fixed this without an app deploy, schema change, or row rewrite by aligning "
        "the sequence with setval(...). QA then retested from the Partner API only "
        f"(black-box) with a {count:,}-request burst — one commissioning ObjectEvent per "
        "HTTP request (not one document containing 5,000 events). TrackIQ accepted every "
        "request with HTTP 202."
    )
)

# --- KEY TABLE ---
body.append(heading("2. How to read this vs the old bug", 1))
body.append(
    para(
        [
            run(
                "This is the core comparison for stakeholders. Left = behaviour during the "
                "incident. Right = what TrackIQ did in the verification run after the ops fix.",
                italic=True,
            )
        ]
    )
)
body.append(
    table(
        ["Before fix (incident)", "After these tests (TrackIQ)"],
        [
            [
                "Intermittent HTTP 500",
                f"0 × HTTP 500 in {count:,} manufacturer POSTs",
            ],
            [
                "Postgres: duplicate key on epcis_outbox_pkey",
                "No sign of epcis_outbox_pkey / duplicate-key text in API responses",
            ],
            [
                "Ingest transaction rolled back",
                "Events accepted (HTTP 202)",
            ],
            [
                "Partner saw generic Internal server error",
                "Partner sees success (202) on every unique eventID in this run",
            ],
        ],
        [4400, 4400],
    )
)

# --- Incident ---
body.append(heading("3. Incident (what broke)", 1))
body.append(para([run("Symptom: ", bold=True), run("Intermittent 500 on manufacturer event POST.")]))
body.append(
    para(
        [
            run("Where it failed: ", bold=True),
            run(
                "Inside the ingest transaction, on insert into epcis_outbox, where "
                "id defaults to nextval('epcis_outbox_id_seq')."
            ),
        ]
    )
)
body.append(
    para(
        [
            run("Confirmed on staging primary (ops): ", bold=True),
            run(
                "max(epcis_outbox.id) ≈ 55,672 while epcis_outbox_id_seq.last_value ≈ 16,659 "
                "(SEQUENCE_BEHIND)."
            ),
        ]
    )
)
body.append(
    para(
        [
            run("Classification: ", bold=True),
            run(
                "Data/ops skew after import/restore — sequence not advanced with table data. "
                "Not an application bug in the outbox writer for this incident."
            ),
        ]
    )
)

# --- Fix ---
body.append(heading("4. Fix applied (ops-only)", 1))
body.append(bullet("No app deploy, no schema change, no row renumbering."))
body.append(
    bullet(
        "Connected as the app DB user via the API container DATABASE_URL (pgbouncer → primary)."
    )
)
body.append(bullet("Pre-check: last_value < max(id) on epcis_outbox / epcis_outbox_id_seq."))
body.append(
    bullet(
        "Applied: setval('epcis_outbox_id_seq', (SELECT COALESCE(MAX(id), 1) FROM epcis_outbox), true) "
        "so the next nextval() is max(id) + 1."
    )
)
body.append(bullet("Verified: last_value = max(id) and is_called = true."))
body.append(
    bullet(
        "Audited other serial/identity sequences for the same last_value < max(pk) pattern "
        "and aligned any that were behind (same setval approach)."
    )
)

# --- Test method ---
body.append(heading("5. What QA tested (TrackIQ — 5,000 requests)", 1))
body.append(
    para(
        [
            run("Endpoint: ", bold=True),
            run("POST https://trackiq.apeiro-digital.com/api/integration/manufacturer/events"),
        ]
    )
)
body.append(
    para(
        [
            run("Auth: ", bold=True),
            run("X-API-Key (manufacturer Partner token). Content-Type: application/ld+json."),
        ]
    )
)
body.append(
    para(
        [
            run("Design: ", bold=True),
            run(
                f"{count:,} separate HTTP requests, each carrying one commissioning ObjectEvent "
                "with a unique RFC UUID eventID. Concurrency = "
                f"{summary['concurrency']} (light parallel load). "
                "This is not a single EPCISDocument with 5,000 events in one body "
                "(that path often hits gateway timeouts and is a different finding)."
            ),
        ]
    )
)
body.append(
    table(
        ["Item", "Value"],
        [
            ["QA batch ID", batch_id],
            ["Lot number (ilmd)", lot_number],
            ["Run ID", run_id],
            ["Requests", f"{count:,}"],
            ["Concurrency", str(summary["concurrency"])],
            ["Elapsed", f"{summary['elapsedSec']} seconds (~{summary['elapsedSec'] // 60} min)"],
            [
                "Evidence folder",
                "security/results/outbox-fix-5k-2026-10-02T10-53-38-130Z/",
            ],
        ],
        [3200, 5600],
    )
)

# --- Results ---
body.append(heading("6. Results (TrackIQ — 5,000 requests)", 1))
body.append(
    table(
        ["Metric", "Result"],
        [
            ["Overall verdict", "PASS"],
            ["HTTP 202 accepted", f"{summary['ok2xx']:,} / {count:,}"],
            ["HTTP 5xx count", str(summary["http5xx"])],
            ["Status breakdown", json.dumps(summary["statusCounts"])],
            ["epcis_outbox_pkey signals in response body", str(summary["outboxPkeySignals"])],
            [
                "Latency (ms)",
                f"min {summary['latencyMs']['min']} · p50 {summary['latencyMs']['p50']} · "
                f"p95 {summary['latencyMs']['p95']} · p99 {summary['latencyMs']['p99']} · "
                f"max {summary['latencyMs']['max']}",
            ],
            ["First eventID", summary["sampleEventIds"]["first"]],
            ["Mid eventID", summary["sampleEventIds"]["mid"]],
            ["Last eventID", summary["sampleEventIds"]["last"]],
        ],
        [3600, 5200],
    )
)

# --- Plain language ---
body.append(heading("7. Plain-language takeaway", 1))
body.append(
    para(
        "Before the fix, partners sometimes got a vague “server error” even when their "
        "payload was fine — because the database was handing out outbox IDs that already "
        "existed. Ops reset the ID counter to sit past the highest existing row. After that, "
        f"QA sent {count:,} separate Partner commission requests (five at a time). Every one "
        "was accepted with HTTP 202. None returned 500. None showed an outbox primary-key "
        "error in the response. That is strong evidence the intermittent outbox-sequence "
        "failure mode is resolved on TrackIQ for this traffic pattern."
    )
)

# --- Scope ---
body.append(heading("8. Scope and limits", 1))
body.append(
    bullet(
        "TrackIQ only; covers the outbox-sequence / intermittent-500 failure mode under "
        f"{count:,} single-event requests."
    )
)
body.append(
    bullet(
        "Does not re-query sequence vs max(id) in the database — that remains an ops health check."
    )
)
body.append(
    bullet(
        "Does not cover one HTTP request containing 5,000 events (gateway timeout / 504 territory)."
    )
)
body.append(
    bullet(
        "Recommendation: after future DB restores/imports, include a sequence-vs-max(pk) "
        "check for epcis_outbox (and other serial tables) in the ops checklist."
    )
)

# --- Sign-off ---
body.append(heading("9. Sign-off", 1))
body.append(
    table(
        ["Item", "Status"],
        [
            ["Incident class", "Ops / sequence lag (not app outbox-writer bug)"],
            ["Fix type", "setval on epcis_outbox_id_seq (+ audit of other sequences)"],
            [f"QA black-box verification ({count:,} POSTs on TrackIQ)", "PASS"],
            ["Ready to share with Devs & PMO", "Yes"],
        ],
        [4800, 4000],
    )
)

# --- Appendix: batch + all event IDs ---
body.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
body.append(heading("Appendix A — Batch numbers and all event IDs used", 1))
body.append(
    para(
        "Every request in the 5,000-request TrackIQ run used the batch and lot identifiers "
        "below. Each line in the list is the eventID sent on that request (submission order)."
    )
)
body.append(
    table(
        ["Field", "Value"],
        [
            ["QA batch ID", batch_id],
            ["Lot number (cbvmda:lotNumber)", lot_number],
            ["Run ID", run_id],
            ["Event ID count", f"{len(event_ids):,}"],
            ["Machine-readable copy", str(RESULTS_DIR / "event-ids.txt")],
        ],
        [3600, 5200],
    )
)
body.append(heading("A.1 Full eventID list (5,000)", 2))
body.append(
    para(
        [
            run(
                f"Index 0001–{len(event_ids):04d}. Format: NNNN  urn:uuid:…",
                italic=True,
                color="595959",
            )
        ]
    )
)

# Compact lines — small font so the appendix is shareable but complete
for idx, eid in enumerate(event_ids, start=1):
    body.append(
        f'<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>'
        f'</w:pPr>{run(f"{idx:04d}  {eid}", sz="16")}</w:p>'
    )

body.append(
    para(
        [
            run(
                "Prepared from executed Partner API verification against TrackIQ on 2026-10-02 "
                f"(batch {batch_id}).",
                italic=True,
                color="595959",
            )
        ],
        spacing_after=80,
    )
)

write_docx(OUT_PATH, "TrackIQ Outbox Sequence Fix Verification", body)
print(f"Wrote {OUT_PATH}")
print(f"Event IDs embedded: {len(event_ids)}")
print(f"Batch ID: {batch_id}")
