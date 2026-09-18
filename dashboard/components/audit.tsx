"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Database, Loader2, RefreshCw, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Summary = {
  dbPath: string;
  unavailable?: string;
  runs: { kind: string; status: string; n: number }[];
  results: { outcome: string; n: number }[];
  topCodes: { code: string; kind: string; n: number }[];
};
type AuditRun = {
  id: string;
  kind: string;
  role: string | null;
  status: string;
  started_at: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
};
type ResultRow = {
  id: number;
  run_id: string;
  test_id: string | null;
  title: string | null;
  role: string | null;
  outcome: "pass" | "fail" | "skipped";
  variant: string | null;
  http_status: number | null;
  duration_ms: number | null;
  error: string | null;
  recorded_at: string;
  codes: string | null;
};
type ResultDetail = ResultRow & {
  method: string | null;
  url: string | null;
  event_id: string | null;
  request_headers: string | null;
  request_body: string | null;
  response_body: string | null;
  document_path: string | null;
  issues: { kind: string; code: string | null; field: string | null; severity: string | null; message: string | null }[];
  events: SentEvent[];
  returned_event_ids: string[];
};
type SentEvent = {
  eventID: string | null;
  type: string | null;
  bizStep: string | null;
  parentID: string | null;
  epcList: string[];
  childEPCs: string[];
};
type RunAudit = AuditRun & {
  base_url: string | null;
  finished_at: string | null;
  error: string | null;
  logs: { at: string; level: string; message: string }[];
  batches: { product: string | null; gtin: string | null; batch_no: string | null; expiry: string | null; ok: number; error: string | null }[];
};

const ALL = "all";
const PAGE_SIZE = 50;
const KIND_LABEL: Record<string, string> = { api: "Role suite", e2e: "Journey", ui: "Browser" };

const when = (iso: string) => new Date(iso).toLocaleString();

type Filters = { runId: string; outcome: string; code: string; testId: string; q: string };

function resultsUrl(f: Filters) {
  const params = new URLSearchParams({ view: "results", limit: "1000" });
  if (f.runId !== ALL) params.set("runId", f.runId);
  if (f.outcome !== ALL) params.set("outcome", f.outcome);
  if (f.code !== ALL) params.set("code", f.code);
  if (f.testId.trim()) params.set("testId", f.testId.trim());
  if (f.q.trim()) params.set("q", f.q.trim());
  return `/api/audit?${params}`;
}

function pretty(text: string | null) {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  return (
    <Badge variant={outcome === "pass" ? "default" : outcome === "skipped" ? "outline" : "destructive"}>
      {outcome === "pass" ? "PASS" : outcome === "skipped" ? "SKIPPED" : "FAIL"}
    </Badge>
  );
}

// Hides a scroll container's bar while keeping it scrollable (wheel, touch, keyboard).
const NO_SCROLLBAR = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1500);
  }
  return (
    <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
      {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
    </Button>
  );
}

const EPC_PREVIEW = 12;
const shortStep = (bizStep: string | null) => bizStep?.split(":").pop() ?? null;

// A labelled list of identifiers: the first few shown, the rest behind "Show all", and a
// Copy button that always copies the complete list, one per line.
function IdList({ label, ids }: { label: string; ids: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? ids : ids.slice(0, EPC_PREVIEW);
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">
          {label} <span className="tabular-nums">({ids.length.toLocaleString()})</span>
        </h4>
        <CopyButton text={ids.join("\n")} label={label} />
      </div>
      <ul className="rounded-2xl border px-4 py-2 font-mono text-xs break-all">
        {shown.map((id, i) => (
          <li key={`${id}-${i}`} className="py-0.5">
            {id}
          </li>
        ))}
      </ul>
      {ids.length > EPC_PREVIEW && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show fewer" : `Show all ${ids.length.toLocaleString()}`}
        </Button>
      )}
    </div>
  );
}

// Event IDs and EPCs the request carried, event by event, plus the IDs the platform returned
// when they are not simply the ones that were sent.
function EventSummary({ detail }: { detail: ResultDetail }) {
  const sentIds = detail.events.map((e) => e.eventID).filter((id): id is string => Boolean(id));
  const returned = detail.returned_event_ids || [];
  const sameAsSent = returned.length === sentIds.length && returned.every((id, i) => id === sentIds[i]);
  const eventIds = sentIds.length ? sentIds : returned.length ? returned : detail.event_id ? [detail.event_id] : [];
  const epcEvents = detail.events.filter((e) => e.epcList.length || e.childEPCs.length || e.parentID);

  return (
    <div className="space-y-3">
      {eventIds.length > 0 ? (
        <IdList label={sentIds.length ? "Event IDs" : "Event IDs (returned)"} ids={eventIds} />
      ) : (
        <p className="text-xs text-muted-foreground">No event ID recorded for this result.</p>
      )}
      {sentIds.length > 0 && returned.length > 0 && !sameAsSent && (
        <IdList label="Event IDs returned by the platform" ids={returned} />
      )}

      {epcEvents.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {detail.events.length
            ? "The request carried no EPCs."
            : "The request document was not recorded for this result, so its EPC list is unavailable."}
        </p>
      ) : (
        epcEvents.map((e, i) => {
          const heading = epcEvents.length > 1 ? `Event ${i + 1}: ${e.type ?? ""} ${shortStep(e.bizStep) ?? ""} — ` : "";
          return (
            <div key={`${e.eventID}-${i}`} className="space-y-2">
              {e.parentID && (
                <p className="font-mono text-xs break-all">
                  <span className="font-sans text-muted-foreground">{heading}Parent: </span>
                  {e.parentID}
                </p>
              )}
              {e.epcList.length > 0 && <IdList label={`${heading}EPC list`} ids={e.epcList} />}
              {e.childEPCs.length > 0 && <IdList label={`${heading}Child EPCs`} ids={e.childEPCs} />}
            </div>
          );
        })
      )}
    </div>
  );
}

// Full height, wrapped, no inner scrollbar: the dialog scrolls as one.
function CodeBlock({ label, text, copyable = false }: { label: string; text: string; copyable?: boolean }) {
  if (!text) return null;
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
        {copyable && <CopyButton text={text} label={label} />}
      </div>
      <pre className="rounded-2xl bg-muted p-4 font-mono text-xs whitespace-pre-wrap break-all">{text}</pre>
    </div>
  );
}

export function Audit() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [runs, setRuns] = useState<AuditRun[]>([]);
  const [rows, setRows] = useState<ResultRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [runId, setRunId] = useState(ALL);
  const [outcome, setOutcome] = useState(ALL);
  const [code, setCode] = useState(ALL);
  const [testId, setTestId] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ResultDetail | null>(null);
  const [runAudit, setRunAudit] = useState<RunAudit | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/audit?view=summary").then((r) => r.json()),
      fetch("/api/audit?view=runs&limit=200").then((r) => r.json()),
      fetch(resultsUrl({ runId: ALL, outcome: ALL, code: ALL, testId: "", q: "" })).then((r) => r.json()),
    ])
      .then(([s, r, res]) => {
        setSummary(s);
        setRuns(r.runs || []);
        setRows(res.results || []);
      })
      .catch(() => setError("Could not reach the audit log. Is the dashboard server running?"));
  }, []);

  // Dropdowns search as soon as they change; the text boxes search on Search / Enter.
  async function search(overrides: Partial<Filters> = {}) {
    const filters = { runId, outcome, code, testId, q, ...overrides };
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(resultsUrl(filters));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.results || []);
      setPage(0);
    } catch (err) {
      setError(`Search failed (${(err as Error).message}).`);
    } finally {
      setLoading(false);
    }
  }

  function changeRun(value: string) {
    setRunId(value);
    void search({ runId: value });
  }
  function changeOutcome(value: string) {
    setOutcome(value);
    void search({ outcome: value });
  }
  function changeCode(value: string) {
    setCode(value);
    void search({ code: value });
  }

  useEffect(() => {
    if (runId === ALL) return;
    let cancelled = false;
    fetch(`/api/audit?view=run&id=${encodeURIComponent(runId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setRunAudit(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runId]);

  function openDetail(id: number) {
    setDetailId(id);
    setDetail(null);
    fetch(`/api/audit?view=result&id=${id}`)
      .then((r) => r.json())
      .then(setDetail)
      .catch(() => setDetail(null));
  }

  const counts = useMemo(() => {
    const byOutcome = Object.fromEntries((summary?.results || []).map((r) => [r.outcome, r.n]));
    const runTotal = (summary?.runs || []).reduce((n, r) => n + r.n, 0);
    return { runTotal, pass: byOutcome.pass || 0, fail: byOutcome.fail || 0, skipped: byOutcome.skipped || 0 };
  }, [summary]);

  const pageRows = (rows || []).slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil((rows?.length || 0) / PAGE_SIZE));
  const selectedRun = runId === ALL ? null : runAudit?.id === runId ? runAudit : null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Every run and every result — passes, failures and skips — with the request, the platform&apos;s
        response and each warning it raised. Stored locally in SQLite for review and audit.
      </p>

      {summary?.unavailable ? (
        <Card>
          <CardContent className="text-sm text-destructive" role="alert">
            The audit database is unavailable: {summary.unavailable}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Runs recorded", value: counts.runTotal },
            { label: "Passed results", value: counts.pass },
            { label: "Failed results", value: counts.fail },
            { label: "Skipped results", value: counts.skipped },
          ].map((s) => (
            <Card key={s.label} className="gap-1 py-4">
              <CardHeader className="px-4">
                <CardDescription>{s.label}</CardDescription>
                <CardTitle className="text-2xl tabular-nums">
                  {summary ? s.value.toLocaleString() : "—"}
                </CardTitle>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardContent>
          <form
            className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_repeat(2,minmax(0,1fr))_minmax(0,1.2fr)]"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="audit-run">Run</Label>
              <Select value={runId} onValueChange={changeRun}>
                <SelectTrigger id="audit-run" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value={ALL}>All runs</SelectItem>
                  {runs.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {when(r.started_at)} · {KIND_LABEL[r.kind] ?? r.kind}
                      {r.role && r.kind === "api" ? ` (${r.role})` : ""} · {r.passed}/{r.total - r.skipped} passed
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="audit-outcome">Outcome</Label>
              <Select value={outcome} onValueChange={changeOutcome}>
                <SelectTrigger id="audit-outcome" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any outcome</SelectItem>
                  <SelectItem value="pass">Passed</SelectItem>
                  <SelectItem value="fail">Failed</SelectItem>
                  <SelectItem value="skipped">Skipped</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="audit-code">Platform code</Label>
              <Select value={code} onValueChange={changeCode}>
                <SelectTrigger id="audit-code" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value={ALL}>Any code</SelectItem>
                  {(summary?.topCodes || []).map((c) => (
                    <SelectItem key={`${c.kind}-${c.code}`} value={c.code}>
                      {c.code} ({c.n.toLocaleString()})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 space-y-1.5 md:col-span-2 xl:col-span-1">
              <Label htmlFor="audit-q">Test ID or text</Label>
              <div className="flex gap-2">
                <Input
                  id="audit-testid"
                  aria-label="Test ID contains"
                  value={testId}
                  onChange={(e) => setTestId(e.target.value)}
                  placeholder="Test ID"
                  className="w-28 shrink-0"
                />
                <Input
                  id="audit-q"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Event ID, message…"
                  className="min-w-0"
                />
                <Button type="submit" variant="outline" disabled={loading} aria-label="Search">
                  {loading ? <Loader2 className="animate-spin" /> : <Search />}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      {selectedRun && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {KIND_LABEL[selectedRun.kind] ?? selectedRun.kind} run — {selectedRun.status}
            </CardTitle>
            <CardDescription>
              <span className="font-mono">{selectedRun.id}</span> · {when(selectedRun.started_at)}
              {selectedRun.finished_at ? ` → ${when(selectedRun.finished_at)}` : ""} · {selectedRun.passed} passed,{" "}
              {selectedRun.failed} failed, {selectedRun.skipped} skipped
              {selectedRun.base_url && <span className="block font-mono text-xs">{selectedRun.base_url}</span>}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-2">
            <div className="min-w-0">
              <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Run log</h3>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
                {selectedRun.logs
                  .map((l) => `${new Date(l.at).toLocaleString()}  ${l.level.padEnd(6)} ${l.message}`)
                  .join("\n") ||
                  "No log lines."}
              </pre>
            </div>
            <div className="min-w-0">
              <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Portal batches</h3>
              {selectedRun.batches.length === 0 ? (
                <p className="text-sm text-muted-foreground">This run created no portal batches.</p>
              ) : (
                <ul className="max-h-48 divide-y overflow-auto rounded-md border text-xs">
                  {selectedRun.batches.map((b, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 px-3 py-1.5">
                      <span className="min-w-0 truncate">{b.product ?? b.gtin}</span>
                      <span className={b.ok ? "shrink-0 font-mono" : "shrink-0 text-destructive"}>
                        {b.ok ? `${b.batch_no} · ${b.expiry}` : b.error}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="py-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground" aria-live="polite">
            <Database className="size-4" aria-hidden="true" />
            {rows === null
              ? "Loading results…"
              : `${rows.length.toLocaleString()}${rows.length === 1000 ? "+" : ""} result${rows.length === 1 ? "" : "s"}`}
          </span>
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => void search()} disabled={loading}>
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Previous page"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft />
            </Button>
            <span className="px-1 text-xs text-muted-foreground tabular-nums">
              {page + 1} / {pageCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Next page"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>

        {error ? (
          <p className="px-4 py-6 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : rows !== null && rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No results match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recorded</TableHead>
                  <TableHead>Test</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Variant</TableHead>
                  <TableHead className="text-right">HTTP</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Platform codes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((r) => (
                  <TableRow
                    key={r.id}
                    tabIndex={0}
                    role="button"
                    aria-label={`Open ${r.test_id ?? "result"} ${r.title ?? ""}`}
                    onClick={() => openDetail(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDetail(r.id);
                      }
                    }}
                    className="cursor-pointer focus-visible:bg-muted focus-visible:outline-none"
                  >
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      {when(r.recorded_at)}
                    </TableCell>
                    <TableCell className="max-w-80">
                      <span className="block font-mono text-xs text-muted-foreground">{r.test_id}</span>
                      <span className="block truncate">{r.title}</span>
                    </TableCell>
                    <TableCell className="text-xs capitalize">{r.role ?? "—"}</TableCell>
                    <TableCell className="text-xs">{r.variant ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{r.http_status ?? "—"}</TableCell>
                    <TableCell>
                      <OutcomeBadge outcome={r.outcome} />
                    </TableCell>
                    <TableCell className="max-w-72">
                      <span className="block truncate font-mono text-xs text-muted-foreground" title={r.codes ?? ""}>
                        {r.codes?.split(",").join(", ") || "—"}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <Dialog open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        {/* One column, top to bottom: details and platform codes, then headers, request body and
            response. The body scrolls as one; each long code block also caps its own height. */}
        <DialogContent className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] rounded-3xl sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{detail?.title ?? "Result"}</DialogTitle>
            <DialogDescription>
              {detail ? (
                <>
                  <span className="font-mono">{detail.test_id}</span> · {detail.variant} ·{" "}
                  {when(detail.recorded_at)} · <span className="font-mono break-all">{detail.run_id}</span>
                </>
              ) : (
                "Loading…"
              )}
            </DialogDescription>
          </DialogHeader>

          {detail ? (
            <div className={`flex min-h-0 min-w-0 flex-col gap-5 overflow-y-auto ${NO_SCROLLBAR}`}>
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <OutcomeBadge outcome={detail.outcome} />
                  {detail.http_status !== null && <Badge variant="outline">HTTP {detail.http_status}</Badge>}
                  {detail.duration_ms !== null && (
                    <Badge variant="outline" className="tabular-nums">
                      {detail.duration_ms} ms
                    </Badge>
                  )}
                </div>
                {detail.url && (
                  <p className="font-mono text-xs break-all">
                    {detail.method} {detail.url}
                  </p>
                )}
                <EventSummary detail={detail} />
                {detail.error && (
                  <p className="text-sm text-destructive" role="alert">
                    {detail.error}
                  </p>
                )}
                <div className="flex flex-col gap-1">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    Platform codes ({detail.issues.length})
                  </h4>
                  {detail.issues.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No platform codes in this response.</p>
                  ) : (
                    <ul className="divide-y rounded-2xl border text-xs">
                      {detail.issues.map((i, n) => (
                        <li key={n} className="px-3 py-1.5">
                          <span className={i.kind === "warning" ? "font-mono" : "font-mono text-destructive"}>
                            {i.code}
                          </span>
                          {i.field && <span className="text-muted-foreground"> · {i.field}</span>}
                          <span className="block text-muted-foreground">{i.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="flex min-w-0 flex-col gap-3">
                <CodeBlock label="Request headers (keys masked)" text={pretty(detail.request_headers)} />
                <CodeBlock label="Request body" text={pretty(detail.request_body)} copyable />
                {detail.document_path && !detail.request_body && (
                  <p className="text-xs text-muted-foreground">
                    Document saved at <span className="font-mono break-all">{detail.document_path}</span>
                  </p>
                )}
                <CodeBlock label="Response" text={pretty(detail.response_body)} copyable />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading result…
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default Audit;
