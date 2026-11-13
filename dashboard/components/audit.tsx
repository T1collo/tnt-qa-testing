"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  Database,
  Filter,
  History,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/panel";
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
  CodeBlock,
  EventSummary,
  NO_SCROLLBAR,
  pretty,
  DurationPill,
  RoleChip,
  StatusPill,
} from "@/components/document-view";
import { Skeleton } from "@/components/ui/skeleton";
import type { EventTracking } from "@/lib/run-session";
import { isTestStep } from "@/lib/utils";
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
  step_key: string | null;
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
  /** True when the body was read back from the saved document rather than stored inline. */
  body_from_file?: boolean;
  body_unavailable?: string;
  issues: { kind: string; code: string | null; field: string | null; severity: string | null; message: string | null }[];
  events: SentEvent[];
  returned_event_ids: string[];
  /** Requests a browser or load test sent, read back from the run record. */
  exchanges?: AuditExchange[];
  /** Load tests: every event sent (event ID, EPC, HTTP status). */
  tracking?: EventTracking;
};
type AuditExchange = {
  variant: string | null;
  method: string | null;
  url: string | null;
  http_status: number | null;
  duration_ms: number | null;
  request_body: string | null;
  response_body: string | null;
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

function OutcomeBadge({ outcome }: { outcome: string }) {
  return (
    <Badge variant={outcome === "pass" ? "success" : outcome === "skipped" ? "outline" : "destructive"}>
      {outcome === "pass" ? "PASS" : outcome === "skipped" ? "SKIPPED" : "FAIL"}
    </Badge>
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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Every run and every result — passes, failures and skips — with the request, the platform&apos;s
        response and each warning it raised. Stored locally in SQLite for review and audit.
      </p>

      {summary?.unavailable ? (
        <p className="rounded-xl border p-4 text-sm text-destructive" role="alert">
          The audit database is unavailable: {summary.unavailable}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[
            { label: "Runs recorded", value: counts.runTotal, icon: Database },
            { label: "Passed results", value: counts.pass, icon: CircleCheck },
            { label: "Failed results", value: counts.fail, icon: CircleX },
            { label: "Skipped results", value: counts.skipped, icon: CircleMinus },
          ].map((s) => (
            <Panel key={s.label} title={s.label} icon={s.icon}>
              <div className="font-mono text-3xl font-medium tracking-tight tabular-nums">
                {summary ? s.value.toLocaleString() : <Skeleton className="h-9 w-20" />}
              </div>
            </Panel>
          ))}
        </div>
      )}

      <Panel title="Filters" icon={Filter}>
          <form
            className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.6fr)_repeat(2,minmax(0,1fr))_minmax(0,1.8fr)]"
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
      </Panel>

      {selectedRun && (
        <Panel title="Selected run" icon={History} bodyClassName="gap-4">
          <div className="border-b pb-3 text-sm">
            <p className="font-medium">
              {KIND_LABEL[selectedRun.kind] ?? selectedRun.kind} run — {selectedRun.status}
            </p>
            <p className="mt-1 text-muted-foreground">
              <span className="font-mono">{selectedRun.id}</span> · {when(selectedRun.started_at)}
              {selectedRun.finished_at ? ` → ${when(selectedRun.finished_at)}` : ""} · {selectedRun.passed} passed,{" "}
              {selectedRun.failed} failed, {selectedRun.skipped} skipped
              {selectedRun.base_url && <span className="block font-mono text-xs">{selectedRun.base_url}</span>}
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
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
          </div>
        </Panel>
      )}

      <Panel
        title="Results"
        icon={ListChecks}
        bodyClassName="overflow-hidden p-0"
        action={
          <div className="flex items-center gap-1">
            <span className="hidden pr-2 font-mono text-xs text-muted-foreground tabular-nums sm:inline" aria-live="polite">
              {rows === null
                ? "Loading…"
                : `${rows.length.toLocaleString()}${rows.length === 1000 ? "+" : ""} result${rows.length === 1 ? "" : "s"}`}
            </span>
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
        }
      >
        {error ? (
          <p className="px-4 py-6 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : rows === null || loading ? (
          <div className="overflow-x-auto" aria-busy="true" aria-label="Loading results">
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
                {Array.from({ length: 10 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Skeleton className="h-3 w-32" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-2.5 w-24" />
                      <Skeleton className="mt-1.5 h-3 w-48" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-20 rounded-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3 w-14" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Skeleton className="ml-auto h-5 w-16 rounded-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-14 rounded-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3 w-40" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : rows.length === 0 ? (
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
                    <TableCell>
                      {r.role ? <RoleChip role={r.role} /> : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-xs">{r.variant ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {r.http_status === null ? (
                        <span className="font-mono text-xs text-muted-foreground">—</span>
                      ) : (
                        <StatusPill status={r.http_status} />
                      )}
                    </TableCell>
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
      </Panel>

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
                  <StatusPill status={detail.http_status} />
                  <DurationPill
                    ms={detail.duration_ms}
                    step={detail.step_key || detail.test_id}
                    untimed={isTestStep(detail.method)}
                  />
                </div>
                {detail.url && (
                  <p className="font-mono text-xs break-all">
                    {detail.method} {detail.url}
                  </p>
                )}
                <EventSummary
                  events={detail.events}
                  returnedIds={detail.returned_event_ids || []}
                  fallbackEventId={detail.event_id}
                />
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
                <CodeBlock
                  label={detail.body_from_file ? "Request body (from the saved document)" : "Request body"}
                  text={pretty(detail.request_body)}
                  copyable
                />
                {detail.body_from_file && detail.document_path && (
                  <p className="text-xs text-muted-foreground">
                    Read from <span className="font-mono break-all">{detail.document_path}</span>
                  </p>
                )}
                {detail.body_unavailable && (
                  <p className="text-xs text-destructive" role="alert">
                    The document for this result is no longer on disk: {detail.body_unavailable}
                  </p>
                )}
                <CodeBlock label="Response" text={pretty(detail.response_body)} copyable />
              </div>

              {detail.tracking && detail.tracking.lines.length > 0 && (
                <CodeBlock
                  label={`Events sent — event ID · EPC · HTTP status (${detail.tracking.total.toLocaleString()}${
                    detail.tracking.lines.length < detail.tracking.total
                      ? `, first ${detail.tracking.lines.length.toLocaleString()} shown`
                      : ""
                  })`}
                  text={detail.tracking.lines.join("\n")}
                  copyable
                />
              )}

              {(detail.exchanges ?? []).map((x, i) => (
                <section key={i} className="flex min-w-0 flex-col gap-3 rounded-2xl border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-xs font-medium">
                      Request {i + 1}
                      {x.variant ? ` · ${x.variant}` : ""}
                    </span>
                    <StatusPill status={x.http_status} />
                    <DurationPill ms={x.duration_ms} step={detail.step_key || detail.test_id} />
                  </div>
                  {x.url && (
                    <p className="font-mono text-xs break-all">
                      {x.method} {x.url}
                    </p>
                  )}
                  <EventSummary
                    events={x.events}
                    returnedIds={x.returned_event_ids}
                    missingNote="This request carried no EPCIS events."
                  />
                  <CodeBlock label="Request body" text={pretty(x.request_body)} copyable />
                  <CodeBlock label="Response" text={pretty(x.response_body)} copyable />
                </section>
              ))}
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
