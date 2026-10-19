"""Fill the MoH Integration/UAT Test Report template from the latest QA test sheet.

Source Excel: Test-sheets/YYYY-MM-DD/TnT_QA_Test_Sheet_YYYY-MM-DD.xlsx
Template:     Downloads/Test Report Template v1 (1).dotx  (or path via argv)
Out:          reports/TnT_Integration_UAT_Test_Report_YYYY-MM-DD.docx
"""
from __future__ import annotations

import re
import sys
import zipfile
from collections import Counter, defaultdict
from copy import deepcopy
from datetime import date
from pathlib import Path

import openpyxl
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_XLSX = ROOT / "Test-sheets" / "2026-09-28" / "TnT_QA_Test_Sheet_2026-09-28.xlsx"
DEFAULT_DOTX = Path(r"C:\Users\Collins\Downloads\Test Report Template v1 (1).dotx")
REPORT_DATE = "2026-09-28"
SUBSYSTEM = "Kenya National Track & Trace Hub (TnT)"
ENV_URL = "https://tnt-demo.apeiro-digital.com"

# Module tabs treated as Integration (consortium QA). Formal MoH UAT is separate.
SKIP_SHEETS = {"Intro", "Test Data Log"}

STATUS_NORMALIZE = {
    "PASS": "Passed",
    "FAIL": "Failed",
    "FAIL / PENDING": "Failed",
    "BLOCKED": "Blocked",
    "NOT RUN": "Not Run",
    "PENDING": "In-progress",
    "NEEDS CONFIRMATION": "In-progress",
    "N/A": "Not Run",
}


def convert_dotx_to_docx(dotx: Path, docx_path: Path) -> None:
    with zipfile.ZipFile(dotx, "r") as zin, zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "[Content_Types].xml":
                data = data.replace(
                    b"application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
                    b"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
                )
            zout.writestr(item, data)


def set_run_text(run, text: str) -> None:
    run.text = text


def replace_text_in_paragraph(paragraph, mapping: dict[str, str]) -> None:
    if not paragraph.text:
        return
    full = paragraph.text
    new = full
    for old, repl in mapping.items():
        if old in new:
            new = new.replace(old, repl)
    if new == full:
        return
    # Prefer rewriting the whole paragraph into the first run to avoid split runs.
    if paragraph.runs:
        paragraph.runs[0].text = new
        for r in paragraph.runs[1:]:
            r.text = ""
    else:
        paragraph.add_run(new)


def replace_everywhere(doc: Document, mapping: dict[str, str]) -> None:
    for p in doc.paragraphs:
        replace_text_in_paragraph(p, mapping)
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    replace_text_in_paragraph(p, mapping)
    # Content controls / SDTs and any leftover body text nodes
    body = doc.element.body
    for t in body.iter(qn("w:t")):
        if t.text:
            new = t.text
            for old, repl in mapping.items():
                if old in new:
                    new = new.replace(old, repl)
            t.text = new
    for section in doc.sections:
        for part in (section.header, section.footer):
            for p in part.paragraphs:
                replace_text_in_paragraph(p, mapping)


def set_paragraph_text(paragraph, text: str) -> None:
    if paragraph.runs:
        paragraph.runs[0].text = text
        for r in paragraph.runs[1:]:
            r.text = ""
    else:
        paragraph.add_run(text)


def insert_paragraph_after(paragraph, text: str = "", style: str | None = None):
    new_p = OxmlElement("w:p")
    paragraph._p.addnext(new_p)
    from docx.text.paragraph import Paragraph

    p = Paragraph(new_p, paragraph._parent)
    if style:
        try:
            p.style = style
        except Exception:
            pass
    if text:
        p.add_run(text)
    return p


def insert_table_after(paragraph, rows: int, cols: int):
    """Insert a new table immediately after the given paragraph; return the Table."""
    tbl = doc_add_table_xml(cols)
    # Build minimal table then let python-docx wrap it — easier: use document and move.
    # We'll attach via the paragraph's parent.
    from docx.table import Table

    # Create via a temporary approach on the document body
    # Actually use deep copy of an existing simple table structure from oxml
    tbl = OxmlElement("w:tbl")
    tblPr = OxmlElement("w:tblPr")
    tblW = OxmlElement("w:tblW")
    tblW.set(qn("w:w"), "0")
    tblW.set(qn("w:type"), "auto")
    tblPr.append(tblW)
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "4")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "BFBFBF")
        borders.append(el)
    tblPr.append(borders)
    tbl.append(tblPr)
    grid = OxmlElement("w:tblGrid")
    for _ in range(cols):
        gc = OxmlElement("w:gridCol")
        gc.set(qn("w:w"), str(9000 // cols))
        grid.append(gc)
    tbl.append(grid)
    for _ in range(rows):
        tr = OxmlElement("w:tr")
        for _c in range(cols):
            tc = OxmlElement("w:tc")
            tcPr = OxmlElement("w:tcPr")
            tcW = OxmlElement("w:tcW")
            tcW.set(qn("w:w"), str(9000 // cols))
            tcW.set(qn("w:type"), "dxa")
            tcPr.append(tcW)
            tc.append(tcPr)
            p = OxmlElement("w:p")
            tc.append(p)
            tr.append(tc)
        tbl.append(tr)
    paragraph._p.addnext(tbl)
    return Table(tbl, paragraph._parent)


def doc_add_table_xml(cols: int):
    return None


def shade_cell(cell, fill: str) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tcPr.append(shd)


def set_cell(cell, text: str, bold: bool = False, fill: str | None = None) -> None:
    cell.text = ""
    p = cell.paragraphs[0]
    run = p.add_run(str(text) if text is not None else "")
    run.font.size = Pt(8)
    run.font.name = "Arial"
    if bold:
        run.bold = True
    if fill:
        shade_cell(cell, fill)
        if fill.upper() in {"1F4E78", "0D3B66"}:
            run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)


def clear_table_body(table, keep_header: bool = True) -> None:
    start = 1 if keep_header else 0
    # Delete from bottom to avoid index issues
    while len(table.rows) > start:
        row = table.rows[-1]
        table._tbl.remove(row._tr)


def add_row(table):
    return table.add_row()


def fill_header_row(table, headers: list[str]) -> None:
    for i, h in enumerate(headers):
        set_cell(table.rows[0].cells[i], h, bold=True, fill="1F4E78")


def looks_like_test_id(value) -> bool:
    if not value or not isinstance(value, str):
        return False
    v = value.strip()
    if v in {"Test ID", "j"} or " " in v and not re.match(r"^[A-Z0-9].*-\d", v):
        # allow TL-1596-TC03 etc.
        pass
    if v == "Test ID":
        return False
    # AUTH-001, MFG-BATCH-EDGE-001, TL-1596-TC03, API-MFG-COMM-001
    return bool(re.match(r"^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$", v)) or bool(
        re.match(r"^TL-\d+-.*$", v)
    )


def load_cases(xlsx: Path):
    wb = openpyxl.load_workbook(xlsx, data_only=True)
    intro = {}
    if "Intro" in wb.sheetnames:
        ws = wb["Intro"]
        for r in range(1, min(20, ws.max_row + 1)):
            k, v = ws.cell(r, 1).value, ws.cell(r, 2).value
            if k and v:
                intro[str(k).strip()] = v

    cases = []
    scenarios = []  # per sheet section
    scenario_id = 0
    current_scenario = None
    current_area = None

    for sheet_name in wb.sheetnames:
        if sheet_name in SKIP_SHEETS:
            continue
        ws = wb[sheet_name]
        current_area = sheet_name
        current_scenario = None
        for r in range(1, ws.max_row + 1):
            a = ws.cell(r, 1).value
            b = ws.cell(r, 2).value
            # Section header: text in col A, rest empty-ish, not a test id
            if a and isinstance(a, str) and not looks_like_test_id(a) and a != "Test ID":
                # likely section title
                if b is None or (isinstance(b, str) and b.strip() == ""):
                    title = a.strip()
                    # Skip junk/typo headers (e.g. lone "j" in Distributor sheet A1)
                    if len(title) < 4 or title.lower() in {"j", "x", "test", "n/a"}:
                        continue
                    scenario_id += 1
                    sid = f"TS-{scenario_id:03d}"
                    current_scenario = {
                        "id": sid,
                        "name": title[:120],
                        "area": sheet_name,
                        "description": title,
                        "statuses": Counter(),
                    }
                    scenarios.append(current_scenario)
                    continue
            if a == "Test ID":
                continue
            if not looks_like_test_id(a):
                continue
            status_raw = ws.cell(r, 8).value
            status_key = str(status_raw).strip().upper() if status_raw else "NOT RUN"
            if status_key in {"", "NONE"}:
                status_key = "NOT RUN"
            status = STATUS_NORMALIZE.get(status_key, status_key.title())
            desc = ws.cell(r, 2).value or ""
            comments = ws.cell(r, 9).value or ""
            actual = ws.cell(r, 7).value or ""
            expected = ws.cell(r, 6).value or ""
            if current_scenario is None:
                scenario_id += 1
                sid = f"TS-{scenario_id:03d}"
                current_scenario = {
                    "id": sid,
                    "name": f"{sheet_name} – General",
                    "area": sheet_name,
                    "description": f"Cases under {sheet_name}",
                    "statuses": Counter(),
                }
                scenarios.append(current_scenario)
            current_scenario["statuses"][status] += 1
            cases.append(
                {
                    "id": str(a).strip(),
                    "name": str(desc).strip()[:80],
                    "description": str(desc).strip(),
                    "fr": "",  # not mapped in workbook
                    "scenario_id": current_scenario["id"],
                    "area": sheet_name,
                    "status": status,
                    "status_raw": status_key,
                    "comments": str(comments).strip() if comments else "",
                    "actual": str(actual).strip() if actual else "",
                    "expected": str(expected).strip() if expected else "",
                }
            )

    # Scenario roll-up status
    for sc in scenarios:
        st = sc["statuses"]
        if not st:
            sc["rollups"] = "Not Run"
        elif st.get("Failed", 0) > 0:
            sc["rollups"] = "Failed"
        elif st.get("Blocked", 0) > 0:
            sc["rollups"] = "Blocked"
        elif st.get("In-progress", 0) > 0:
            sc["rollups"] = "In-progress"
        elif st.get("Not Run", 0) and st.get("Passed", 0) == 0:
            sc["rollups"] = "Not Run"
        elif st.get("Not Run", 0) and st.get("Passed", 0):
            sc["rollups"] = "In-progress"
        else:
            sc["rollups"] = "Passed"

    return intro, scenarios, cases


def severity_for(case: dict) -> str:
    text = (case["comments"] + " " + case["description"]).lower()
    tid = case["id"]
    if case["status"] == "Blocked":
        return "Blocker"
    if "404" in text or "defect" in text or "crash" in text:
        return "Critical"
    if tid.startswith("API-") and case["status"] == "Failed":
        return "Major"
    if "mandatory" in text:
        return "Major"
    if "advisory" in text:
        return "Minor"
    return "Major"


def defect_status_for(case: dict) -> str:
    c = case["comments"].lower()
    if "resolved" in c or "fixed" in c and "still" not in c:
        return "Open"
    if case["status"] == "Blocked":
        return "Open"
    return "Open"


def build_defects(cases: list[dict]) -> list[dict]:
    defects = []
    n = 0
    for case in cases:
        if case["status"] not in {"Failed", "Blocked"}:
            continue
        n += 1
        did = f"DF-{n:03d}"
        case["defect_ids"] = did
        desc = case["comments"] or case["actual"] or case["description"]
        defects.append(
            {
                "id": did,
                "description": desc[:500],
                "cases": case["id"],
                "severity": severity_for(case),
                "status": defect_status_for(case),
            }
        )
    return defects


def metrics_lines(cases: list[dict]) -> list[tuple[str, str]]:
    c = Counter(x["status"] for x in cases)
    total = len(cases)
    executed = total - c.get("Not Run", 0)
    passed = c.get("Passed", 0)
    failed = c.get("Failed", 0)
    blocked = c.get("Blocked", 0)
    not_run = c.get("Not Run", 0)
    inprog = c.get("In-progress", 0)
    pass_rate = f"{(passed / executed * 100):.1f}%" if executed else "n/a"
    return [
        ("Total test cases", str(total)),
        ("Executed", str(executed)),
        ("Passed", str(passed)),
        ("Failed", str(failed)),
        ("Blocked", str(blocked)),
        ("In-progress", str(inprog)),
        ("Not Run", str(not_run)),
        ("Pass rate (of executed)", pass_rate),
    ]


def fill_kv_table_after_placeholder(doc: Document, placeholder_substr: str, rows: list[tuple[str, str]]):
    """Replace a placeholder paragraph with text + insert a 2-col metrics table after it."""
    target = None
    for p in doc.paragraphs:
        if placeholder_substr in p.text:
            target = p
            break
    if not target:
        return
    set_paragraph_text(target, "Summary metrics for this release (sourced from TnT QA Test Sheet):")
    table = insert_table_after(target, len(rows) + 1, 2)
    set_cell(table.rows[0].cells[0], "Metric", bold=True, fill="1F4E78")
    set_cell(table.rows[0].cells[1], "Value", bold=True, fill="1F4E78")
    for i, (k, v) in enumerate(rows, start=1):
        set_cell(table.rows[i].cells[0], k)
        set_cell(table.rows[i].cells[1], v)


def populate_table(table, headers: list[str], data_rows: list[list[str]], max_rows: int | None = None):
    clear_table_body(table, keep_header=True)
    # ensure header labels
    for i, h in enumerate(headers):
        if i < len(table.columns):
            set_cell(table.rows[0].cells[i], h, bold=True, fill="1F4E78")
    rows = data_rows if max_rows is None else data_rows[:max_rows]
    for row_data in rows:
        row = add_row(table)
        for i, val in enumerate(row_data):
            if i < len(row.cells):
                set_cell(row.cells[i], val)


def find_tables_by_first_header(doc: Document, header: str):
    """Return tables whose first header cell starts with `header` (document order)."""
    found = []
    for table in doc.tables:
        if not table.rows:
            continue
        first = (table.rows[0].cells[0].text or "").strip()
        if first.startswith(header):
            found.append(table)
    return found


def area_status_summary(cases: list[dict]) -> list[list[str]]:
    by_area: dict[str, Counter] = defaultdict(Counter)
    for c in cases:
        by_area[c["area"]][c["status"]] += 1
    rows = []
    for area, st in by_area.items():
        total = sum(st.values())
        rows.append(
            [
                area,
                str(total),
                str(st.get("Passed", 0)),
                str(st.get("Failed", 0)),
                str(st.get("Blocked", 0)),
                str(st.get("Not Run", 0)),
                str(st.get("In-progress", 0)),
            ]
        )
    return rows


def main():
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    dotx = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_DOTX
    out = ROOT / "reports" / f"TnT_Integration_UAT_Test_Report_{REPORT_DATE}.docx"
    out.parent.mkdir(parents=True, exist_ok=True)

    tmp_docx = Path(r"C:\Users\Collins\AppData\Local\Temp\tnt-test-report") / "working.docx"
    tmp_docx.parent.mkdir(parents=True, exist_ok=True)
    convert_dotx_to_docx(dotx, tmp_docx)

    intro, scenarios, cases = load_cases(xlsx)
    defects = build_defects(cases)
    metrics = metrics_lines(cases)
    env = intro.get("Environment", ENV_URL)

    # Link defect ids already set on cases in build_defects
    for c in cases:
        c.setdefault("defect_ids", "")

    doc = Document(str(tmp_docx))

    # Title / name replacements (cover SDT + body)
    mapping = {
        "<insert name>": SUBSYSTEM,
        "<insert name> solution / scope": f"{SUBSYSTEM} solution / scope",
        "<insert name> system": f"{SUBSYSTEM} system",
    }
    replace_everywhere(doc, mapping)

    # Version control row 2
    vc = doc.tables[0]
    vc.rows[2].cells[0].text = "2.0"
    vc.rows[2].cells[1].text = "TnT QA"
    vc.rows[2].cells[2].text = (
        f"Filled from QA Test Sheet {REPORT_DATE} — Integration execution results for {SUBSYSTEM}"
    )
    vc.rows[2].cells[3].text = date.today().strftime("%d-%b-%Y")

    # Add TnT acronyms to acronym table
    acronyms = doc.tables[2]
    extra = [
        ("TnT", "Track and Trace (Kenya National Track & Trace Hub)"),
        ("EPCIS", "Electronic Product Code Information Services (GS1)"),
        ("GLN", "Global Location Number"),
        ("GTIN", "Global Trade Item Number"),
        ("SGTIN", "Serialized Global Trade Item Number"),
        ("SSCC", "Serial Shipping Container Code"),
        ("PPB", "Pharmacy and Poisons Board (Regulator)"),
        ("UAT", "User Acceptance Testing"),
    ]
    existing = {r.cells[0].text.strip() for r in acronyms.rows}
    for acr, desc in extra:
        if acr not in existing:
            row = acronyms.add_row()
            row.cells[0].text = acr
            row.cells[1].text = desc

    # Scope placeholders
    scope_intro = (
        f"This report covers Integration / System QA for the {SUBSYSTEM}, "
        f"exercised against the demo environment ({env}). "
        "Coverage includes role-based UI flows (Manufacturer, Distributor/KEMSA, Regulator/PPB, "
        "Partner Portal, Master Data Registry) and Partner EPCIS API event suites "
        "(Manufacturer, Distributor, Facility, and Special Events), as recorded in the "
        f"TnT QA Test Case Workbook dated {REPORT_DATE}."
    )
    release_scope = (
        "In-scope for this release cycle: authentication and access control; manufacturer batch/"
        "pack/ship UI; distributor receive/forward UI; regulator package approval, recalls, events/"
        "journey, analytics and rules; error declaration; master data registry; partner portal/"
        "public scanner; and EPCIS 2.0 JSON event APIs (commission, pack, ship, receive, dispense, "
        "special events, validation/error declaration).\n"
        "Out-of-scope for this workbook: production cutover, county facility UAT workshops, "
        "performance/load certification, and security penetration testing (covered in separate findings reports)."
    )
    in_scope = (
        "Functional areas exercised (mapped to workbook tabs rather than FR-XXX IDs, which are not "
        "assigned in the current QA sheet):\n"
        + "; ".join(sorted({c["area"] for c in cases}))
        + "."
    )
    out_scope = (
        "Formal MoH / CIC facilitated User Acceptance Testing with end-user sign-off; "
        "non-functional performance and security deep-dives; disaster-recovery drills; "
        f"and any requirements not represented in the {REPORT_DATE} QA workbook."
    )

    for p in doc.paragraphs:
        t = p.text.strip()
        if t.startswith("<introduction of the specific sub-system"):
            set_paragraph_text(p, scope_intro)
        elif t.startswith("<description of in-scope"):
            set_paragraph_text(p, release_scope)
        elif t.startswith("<List of requirements") and "will be tested" in t:
            set_paragraph_text(p, in_scope)
        elif t.startswith("<List of requirements") and "will not be tested" in t:
            set_paragraph_text(p, out_scope)

    # Integration intro
    integ_areas = ", ".join(sorted({c["area"] for c in cases}))
    integ_intro = (
        f"Integration testing was conducted by the Safaricom Consortium QA team (Apeiro / TnT QA) "
        f"against {env}. Areas covered: {integ_areas}."
    )
    approach = (
        "Hybrid approach: (1) manual exploratory and scripted UI cases in the QA workbook; "
        "(2) Playwright automated UI smoke/lifecycle where indicated in COMMENTS; "
        "(3) Partner API / EPCIS event submission via Postman/Newman and the internal QA Dashboard "
        "run sessions; (4) live defect notes captured in the COMMENTS column of each case."
    )
    teams = (
        "Execution: TnT QA (workbook authoring, live demo execution, API edge validation). "
        "Supporting: development counterparts (Victor, Nelson, Nikita and others named in case "
        "comments) for defect triage. External MoH/CIC UAT participants: not engaged in this cycle."
    )
    entry_exit = (
        "Entry criteria (assessed): demo environment available; role test accounts for PPB Admin, "
        "KEMSA Distributor, and Manufacturer; EPCIS partner credentials; QA workbook prepared.\n"
        "Exit criteria (assessed): all P0/blocker defects closed — NOT MET; critical open UI/API "
        f"defects remain ({sum(1 for d in defects if d['severity'] in ('Blocker','Critical'))} "
        f"Blocker/Critical among {len(defects)} logged defects). Pass rate of executed cases is "
        f"{dict(metrics)['Pass rate (of executed)']}."
    )
    schedule = (
        f"Workbook generated/updated through {REPORT_DATE}. Live UI/API executions span August–"
        f"September 2026 sessions (see case COMMENTS and Test Data Log). This report freeze date: "
        f"{date.today().isoformat()}."
    )

    # UAT section — not separately executed
    uat_intro = (
        "Formal User Acceptance Testing with Ministry of Health / Contract Implementation Committee "
        "end users was not executed as a separate phase in this workbook cycle. The results below "
        "are therefore marked Not Run for UAT-specific acceptance; Integration findings above should "
        "be remediated before UAT entry."
    )
    uat_approach = "Not applicable for this report version — UAT pending after Integration exit criteria are met."
    uat_teams = "UAT team to be nominated by MoH / CIC; not assigned in this cycle."
    uat_entry = (
        "Entry criteria for UAT (proposed): Integration exit criteria met; open Blocker/Critical "
        "defects closed or waived; UAT scripts and environment signed off.\n"
        "Exit criteria: MoH/CIC acceptance signatures in Section 7."
    )
    uat_schedule = "UAT schedule: TBD pending Integration defect closure."

    tools = (
        "Test management / case repository: TnT_QA_Test_Sheet Excel workbook "
        f"(Test-sheets/{REPORT_DATE}/).\n"
        "UI automation: Playwright (auth.spec.js and lifecycle suites referenced in case comments).\n"
        "API execution: Postman/Newman Partner API collection; QA Dashboard E2E run sessions "
        "(e.g. run_1790585786296_ad94e9 on 2026-09-28).\n"
        "Defect tracking: COMMENTS column in the workbook and this report’s Defects List "
        "(DF-xxx). Evidence: reports/newman/evidence and run_data/created-entities.json where cited."
    )
    environments = (
        f"Primary environment: {env} (demo).\n"
        "Roles exercised: PPB Admin, KEMSA Distributor, Manufacturer, Partner API clients "
        "(manufacturer / distributor / facility)."
    )
    data_txt = (
        "Synthetic demo master data (products/GTINs, GLNs, partner credentials). Batches and "
        "shipments created during execution are logged in the workbook Test Data Log and "
        "run_data/created-entities.json (e.g. BATCH-20260804-*, SHP-20260804-*)."
    )

    conclusion = (
        f"Of {len(cases)} Integration test cases, {dict(metrics)['Passed']} Passed, "
        f"{dict(metrics)['Failed']} Failed, {dict(metrics)['Blocked']} Blocked, and "
        f"{dict(metrics)['Not Run']} Not Run. "
        "Core auth and many UI happy-paths are stable; material gaps remain in Partner Portal "
        "certification-status updates, several EPCIS validation/edge rules versus the onboarding "
        "guide, regulator recall/approval UI defects, and blocked distributor API chains."
    )
    recommendation = (
        "Do not promote to production / do not start formal MoH UAT until Blocker and Critical "
        "defects are resolved (notably broken regulator recall route, certification-status update "
        "failures on error-handling and facility special events, and high-severity EPCIS validation "
        "gaps). Re-run failed/blocked suites after fixes, then schedule UAT with CIC."
    )

    # Capture template tables BEFORE inserting any new ones (indices would shift otherwise).
    scenario_tables = find_tables_by_first_header(doc, "Test Scenario ID")
    case_tables = find_tables_by_first_header(doc, "Test Case ID")
    defect_tables = find_tables_by_first_header(doc, "Defect ID")
    if len(scenario_tables) < 2 or len(case_tables) < 2 or len(defect_tables) < 2:
        raise RuntimeError(
            f"Template tables not found as expected: scenarios={len(scenario_tables)} "
            f"cases={len(case_tables)} defects={len(defect_tables)}"
        )
    integ_scenario_tbl, uat_scenario_tbl = scenario_tables[0], scenario_tables[1]
    integ_case_tbl, uat_case_tbl = case_tables[0], case_tables[1]
    integ_defect_tbl, uat_defect_tbl = defect_tables[0], defect_tables[1]

    def report_status(status: str) -> str:
        return status if status in {"Passed", "Not Run"} else ""

    scenario_rows = [
        [s["id"], s["name"][:60], s["area"], s["description"][:120], report_status(s["rollups"])]
        for s in scenarios
    ]
    populate_table(
        integ_scenario_tbl,
        [
            "Test Scenario ID",
            "Test Scenario Name",
            "Test Area",
            "Scenario Description",
            "Scenario Status",
        ],
        scenario_rows,
    )
    # Cases grouped by module; within each: Passed → Not Run → empty (manual)
    status_rank = {"Passed": 0, "Not Run": 1, "": 2}
    module_order: list[str] = []
    for c in cases:
        if c["area"] not in module_order:
            module_order.append(c["area"])
    case_rows: list[list[str]] = []
    for area in module_order:
        group = [c for c in cases if c["area"] == area]
        group.sort(key=lambda c: (status_rank[report_status(c["status"])], c["id"]))
        case_rows.append(
            [f"MODULE: {area}", "", "", "", f"{len(group)} cases", "", ""]
        )
        for c in group:
            case_rows.append(
                [
                    c["id"],
                    c["name"][:60],
                    c["fr"] or "—",
                    c["scenario_id"],
                    c["description"][:120],
                    c.get("defect_ids", "") or "—",
                    report_status(c["status"]),
                ]
            )
    populate_table(
        integ_case_tbl,
        [
            "Test Case ID",
            "Test Case Name",
            "FR / NF / UC reference",
            "Test Scenario ID",
            "Test Case Description",
            "Defect ID(s)",
            "Test Case Status",
        ],
        case_rows,
    )
    # Defect Status left blank for manual update
    defect_rows = [
        [d["id"], d["description"][:200], d["cases"], d["severity"], ""] for d in defects
    ]
    populate_table(
        integ_defect_tbl,
        [
            "Defect ID",
            "Defect Description and Resolution",
            "Associated Test Case(s)",
            "Severity",
            "Defect Status",
        ],
        defect_rows,
    )
    populate_table(
        uat_scenario_tbl,
        [
            "Test Scenario ID",
            "Test Scenario Name",
            "Test Area",
            "Scenario Description",
            "Scenario Status",
        ],
        [["—", "Formal MoH UAT", "UAT", "Not executed in this cycle", "Not Run"]],
    )
    populate_table(
        uat_case_tbl,
        [
            "Test Case ID",
            "Test Case Name",
            "FR / NF / UC reference",
            "Test Scenario ID",
            "Test Case Description",
            "Defect ID(s)",
            "Test Case Status",
        ],
        [["—", "No UAT cases executed", "—", "—", "Formal UAT pending", "—", "Not Run"]],
    )
    populate_table(
        uat_defect_tbl,
        [
            "Defect ID",
            "Defect Description and Resolution",
            "Associated Test Case(s)",
            "Severity",
            "Defect Status",
        ],
        [["—", "No UAT defects — phase not executed", "—", "—", "—"]],
    )

    # Process paragraphs carefully for Integration vs UAT duplicates
    seen_metrics = 0
    seen_scenarios_ph = 0
    seen_team_phase = 0
    seen_approach = 0
    seen_teams = 0
    seen_entry = 0
    seen_tc_details = 0
    seen_def_details = 0
    seen_schedule = 0

    for p in doc.paragraphs:
        t = p.text.strip()
        if not t.startswith("<") and "List All Test Areas" not in t and "insert test metrics" not in t:
            if not t.lstrip().startswith("<"):
                continue

        if "list the consortium team that conducted the testing for this phase" in t:
            seen_team_phase += 1
            set_paragraph_text(p, integ_intro if seen_team_phase == 1 else uat_intro)
        elif "insert test metrics table" in t:
            seen_metrics += 1
            if seen_metrics == 1:
                set_paragraph_text(
                    p,
                    "Summary metrics for Integration (sourced from TnT QA Test Sheet "
                    f"{REPORT_DATE}):",
                )
                table = insert_table_after(p, len(metrics) + 1, 2)
                set_cell(table.rows[0].cells[0], "Metric", bold=True, fill="1F4E78")
                set_cell(table.rows[0].cells[1], "Value", bold=True, fill="1F4E78")
                for i, (k, v) in enumerate(metrics, start=1):
                    set_cell(table.rows[i].cells[0], k)
                    set_cell(table.rows[i].cells[1], v)
                area_rows = area_status_summary(cases)
                anchor = insert_paragraph_after(p, "Results by test area:")
                table._tbl.addnext(anchor._p)
                area_tbl = insert_table_after(anchor, len(area_rows) + 1, 7)
                area_headers = [
                    "Test Area",
                    "Total",
                    "Passed",
                    "Failed",
                    "Blocked",
                    "Not Run",
                    "In-progress",
                ]
                for i, h in enumerate(area_headers):
                    set_cell(area_tbl.rows[0].cells[i], h, bold=True, fill="1F4E78")
                for i, row in enumerate(area_rows, start=1):
                    for j, val in enumerate(row):
                        set_cell(area_tbl.rows[i].cells[j], val)
            else:
                set_paragraph_text(
                    p,
                    "UAT metrics: Not Run — formal UAT not executed in this cycle. "
                    "See Integration metrics above.",
                )
        elif "List All Test Areas for the Integration Test Phase" in t or (
            "List All Test Areas for the UAT Test Phase" in t
        ):
            seen_scenarios_ph += 1
            if seen_scenarios_ph == 1:
                set_paragraph_text(
                    p,
                    "Integration test scenarios are rolled up from workbook section headers. "
                    "Scenario status is Failed if any child case Failed; otherwise Blocked / "
                    "In-progress / Passed / Not Run as applicable. See table below.",
                )
            else:
                set_paragraph_text(
                    p,
                    "UAT scenarios: not executed. Placeholder table left empty / Not Run.",
                )
        elif t.startswith("<describe the Test Approach"):
            seen_approach += 1
            set_paragraph_text(p, approach if seen_approach == 1 else uat_approach)
        elif t.startswith("<list the members of the test team"):
            seen_teams += 1
            set_paragraph_text(p, teams if seen_teams == 1 else uat_teams)
        elif t.startswith("<list the entry and exit criteria"):
            seen_entry += 1
            set_paragraph_text(p, entry_exit if seen_entry == 1 else uat_entry)
        elif t.startswith("<insert Test Case details"):
            seen_tc_details += 1
            set_paragraph_text(
                p,
                "Test cases from the QA workbook are listed in the table below."
                if seen_tc_details == 1
                else "UAT test cases: none executed in this cycle.",
            )
        elif t.startswith("<insert details of Defects"):
            seen_def_details += 1
            set_paragraph_text(
                p,
                "Defects derived from Failed/Blocked Integration cases:"
                if seen_def_details == 1
                else "UAT defects: none — UAT not executed.",
            )
        elif t.startswith("<describe the duration and high-level schedule"):
            seen_schedule += 1
            set_paragraph_text(p, schedule if seen_schedule == 1 else uat_schedule)
        elif t.startswith("<Insert descriptions of tools"):
            set_paragraph_text(p, tools)
        elif t.startswith("<description of test environments"):
            set_paragraph_text(p, environments)
        elif t.startswith("<describe test data used"):
            set_paragraph_text(p, data_txt)
        elif t.startswith("<describe outcome of the testing"):
            set_paragraph_text(p, conclusion)
        elif t.startswith("<provide recommendation"):
            set_paragraph_text(p, recommendation)

    for p in doc.paragraphs:
        if "reviewed the Business Requirements Document for the Sub-System" in p.text:
            set_paragraph_text(
                p,
                "The Contract Implementation Committee will review this Integration and UAT Test "
                f"Report for the {SUBSYSTEM} Sub-System and confirm whether it meets the contract "
                "terms, user requirements, and customer specifications prior to production promotion.",
            )

    for p in doc.paragraphs:
        if p.text.strip().startswith("Annex 2"):
            set_paragraph_text(p, f"Annex 2 – Source QA Test Sheet ({REPORT_DATE})")
            insert_paragraph_after(
                p,
                f"Source file: Test-sheets/{REPORT_DATE}/TnT_QA_Test_Sheet_{REPORT_DATE}.xlsx. "
                f"Environment: {env}. Generated report: {out.name}.",
            )
            break

    doc.save(str(out))
    print(f"Wrote {out}")
    print(f"Cases={len(cases)} Scenarios={len(scenarios)} Defects={len(defects)}")
    print("Metrics:", dict(metrics))


if __name__ == "__main__":
    main()
