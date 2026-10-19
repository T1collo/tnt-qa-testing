"use client";

import { useEffect, useState } from "react";
import { CheckCheck, ChevronDown, Copy, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toggle } from "@/components/ui/toggle";
import {
  CodeBlock,
  CopyButton,
  DurationPill,
  budgetFor,
  RoleChip,
  StatusPill,
  pretty,
} from "@/components/document-view";
import { cn } from "@/lib/utils";

type RunSummary = {
  id: string;
  role: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  total: number;
  passed: number;
  failed: number;
  skipped?: number;
};

type WorkbookRow = {
  testId: string;
  sheetName: string;
  rowNumber: number;
  description: string | null;
  testSteps: string | null;
  expectedResult: string | null;
};

type ResultVariant = {
  variant: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  documentPath?: string;
  status: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number;
};

type RunResult = {
  stepKey?: string;
  testId: string;
  eventType: string;
  path: string[];
  role?: string;
  variants: ResultVariant[];
  ok: boolean;
  skipped?: boolean;
  error?: string;
  batchId?: string;
  batchSize?: number;
  batchEventCount?: number;
  workbook: WorkbookRow | null;
};

// Columns: index · test id · title · role · status · timing · outcome · chevron. Widths are
// fixed so every row lines up; narrow screens drop the middle columns rather than squeeze them.
// Documents: id · role · events and steps · endpoint · status · timing · chevron.
const DOC_GRID =
  "grid items-center gap-3 grid-cols-[2rem_minmax(0,1fr)_5.5rem_1rem] " +
  "md:grid-cols-[2rem_7rem_minmax(0,1fr)_5.5rem_5.5rem_1rem] " +
  "lg:grid-cols-[2rem_7rem_11rem_minmax(0,1fr)_5.5rem_5.5rem_1rem]";

const ROW_GRID =
  "grid items-center gap-3 grid-cols-[1.75rem_minmax(0,1fr)_4.5rem_1rem] " +
  "sm:grid-cols-[1.75rem_minmax(0,1fr)_5.5rem_4.5rem_1rem] " +
  "md:grid-cols-[1.75rem_10.5rem_minmax(0,1fr)_7rem_5.5rem_4.5rem_1rem] " +
  "lg:grid-cols-[1.75rem_10.5rem_minmax(0,1fr)_7rem_5.5rem_5.5rem_4.5rem_1rem]";

type Outcome = "pass" | "fail" | "skipped";
const outcomeOf = (r: RunResult): Outcome => (r.ok ? "pass" : r.skipped ? "skipped" : "fail");
const stepKeyOf = (r: RunResult) => r.stepKey || r.testId;

function buildCurl(variant: ResultVariant, body: string | null) {
  // Portal steps are browser actions, not requests; there is no curl for them.
  if (variant.method === "UI") return `# Browser step on ${variant.url}`;
  const headers = Object.entries(variant.requestHeaders || {})
    .map(([k, v]) => `  -H "${k}: ${v === "***" ? "$YOUR_API_KEY" : v}"`)
    .join(" \\\n");
  const data = body ? ` \\\n  --data-raw '${body.replace(/'/g, "'\\''")}'` : "";
  return `curl -X ${variant.method} "${variant.url}" \\\n${headers}${data}`;
}

/** Reads back a document the run saved to disk, for steps too large to store inline. */
async function fetchDocument(runId: string, step: string) {
  const res = await fetch(`/api/runs?id=${encodeURIComponent(runId)}&document=${encodeURIComponent(step)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { text: string };
  return data.text;
}

function StepRow({
  result,
  index,
  documents,
  onNeedDocument,
}: {
  result: RunResult;
  index: number;
  documents: Record<string, string>;
  onNeedDocument: (step: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wb = result.workbook;
  const outcome = outcomeOf(result);
  const step = stepKeyOf(result);
  const primary = result.variants?.[0];
  const onDisk = Boolean(primary && !primary.requestBody && primary.documentPath);
  const shared = (result.batchSize ?? 1) > 1;

  function toggle(next: boolean) {
    setOpen(next);
    if (next && onDisk && !documents[step]) onNeedDocument(step);
  }

  return (
    <Collapsible open={open} onOpenChange={toggle}>
      <Card className="overflow-hidden py-0">
        <CollapsibleTrigger asChild>
          <button className={cn(ROW_GRID, "w-full px-4 py-3 text-left text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none")}>
            <span className="text-right font-mono text-xs text-muted-foreground tabular-nums">{index}</span>
            <span className="hidden truncate font-mono text-xs text-muted-foreground md:block">
              {result.testId}
            </span>
            <span className="min-w-0">
              <span className="block truncate">{result.eventType || wb?.description}</span>
              {outcome === "skipped" && result.error && (
                <span className="block truncate text-xs text-muted-foreground">{result.error}</span>
              )}
            </span>
            <span className="hidden md:block">
              <RoleChip role={result.role} />
            </span>
            <span className="hidden sm:block">
              <StatusPill status={primary?.status} />
            </span>
            <span className="hidden lg:block">
              {outcome !== "skipped" &&
                (shared ? (
                  <span
                    className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground tabular-nums"
                    title={`Sent with ${(result.batchSize ?? 1) - 1} other step${result.batchSize === 2 ? "" : "s"} in document ${result.batchId}, which took ${primary?.durationMs?.toLocaleString()} ms in total`}
                  >
                    {result.batchId}
                  </span>
                ) : (
                  <DurationPill ms={primary?.durationMs} step={step} untimed={primary?.method === "UI"} />
                ))}
            </span>
            <Badge
              variant={outcome === "pass" ? "default" : outcome === "skipped" ? "outline" : "destructive"}
              className="justify-center"
            >
              {outcome === "pass" ? "PASS" : outcome === "skipped" ? "SKIPPED" : "FAIL"}
            </Badge>
            <ChevronDown
              className={cn(
                "size-4 justify-self-end text-muted-foreground transition-transform duration-(--duration-enter) ease-(--ease-emphasis)",
                open && "rotate-180"
              )}
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-4 border-t bg-muted/30 px-4 py-4 text-sm">
            {wb && (
              <div>
                <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  What this test checks (reference — {wb.sheetName})
                </h4>
                <p className="whitespace-pre-wrap">{wb.description}</p>
                {wb.testSteps && (
                  <>
                    <h4 className="mt-3 mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      Steps to recreate manually
                    </h4>
                    <p className="whitespace-pre-wrap">{wb.testSteps}</p>
                  </>
                )}
                {wb.expectedResult && (
                  <>
                    <h4 className="mt-3 mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      Expected result
                    </h4>
                    <p className="whitespace-pre-wrap">{wb.expectedResult}</p>
                  </>
                )}
              </div>
            )}

            <div>
              <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Postman collection reference
              </h4>
              <p className="font-mono text-xs">{(result.path || []).join(" > ")}</p>
              {result.batchSize && result.batchSize > 1 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Sent in document {result.batchId}, shared with {result.batchSize - 1} other step
                  {result.batchSize > 2 ? "s" : ""}.
                </p>
              )}
            </div>

            {outcome === "skipped" ? (
              <div>
                <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Why it did not run
                </h4>
                <p>{result.error || "This step was skipped."}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Nothing was sent to the platform, so there is no request or response to show. Add the
                  token for this role on the Run page and run it again.
                </p>
              </div>
            ) : (
              (result.variants || []).map((v, i) => {
                const body = v.requestBody ?? (i === 0 ? documents[step] : undefined) ?? null;
                return (
                  <div key={i} className="space-y-3 rounded-2xl border bg-background p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium">{v.variant}</span>
                      <span className="flex items-center gap-2">
                        <StatusPill status={v.status} />
                        <DurationPill ms={v.durationMs} step={step} untimed={v.method === "UI"} />
                      </span>
                    </div>
                    <p className="font-mono text-xs break-all">
                      {v.method} {v.url}
                    </p>
                    {body ? (
                      <CodeBlock label="Event body sent" text={pretty(body)} copyable />
                    ) : onDisk && i === 0 ? (
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        Loading the saved document…
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        This run did not record the body it sent for this step.
                      </p>
                    )}
                    <CodeBlock label="Response" text={pretty(v.responseBody)} copyable />
                    <CodeBlock label="Repro (curl)" text={buildCurl(v, body)} copyable />
                    {v.error && <p className="text-xs text-destructive">Network error: {v.error}</p>}
                  </div>
                );
              })
            )}
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

type RunDocument = {
  id: string;
  /** The step whose saved document to read when the body is not stored inline. */
  step: string;
  role?: string;
  events: number;
  steps: number[];
  /** Step keys in this document - their targets add up to the document's target. */
  stepKeys: string[];
  ok: boolean;
  variants: ResultVariant[];
};

/**
 * One row per document the run actually posted. In "combined per role" mode a document carries
 * several steps, so this is where the whole bundle for a role lives - the step rows below show
 * the same document once per step.
 */
function documentsOf(results: RunResult[]): RunDocument[] {
  const byDocument = new Map<string, RunDocument>();
  results.forEach((result, i) => {
    if (result.skipped || !result.variants?.length) return;
    const id = result.batchId || stepKeyOf(result);
    const existing = byDocument.get(id);
    if (existing) {
      existing.steps.push(i + 1);
      existing.stepKeys.push(stepKeyOf(result));
      existing.ok = existing.ok && result.ok;
      return;
    }
    byDocument.set(id, {
      id,
      step: stepKeyOf(result),
      role: result.role,
      events: result.batchEventCount ?? 1,
      steps: [i + 1],
      stepKeys: [stepKeyOf(result)],
      ok: result.ok,
      variants: result.variants,
    });
  });
  return [...byDocument.values()];
}

function DocumentRow({
  document,
  documents,
  onNeedDocument,
}: {
  document: RunDocument;
  documents: Record<string, string>;
  onNeedDocument: (step: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const primary = document.variants[0];
  const body = primary.requestBody ?? documents[document.step] ?? null;
  const onDisk = Boolean(!primary.requestBody && primary.documentPath);
  const span =
    document.steps.length > 1
      ? `steps ${document.steps[0]}–${document.steps[document.steps.length - 1]}`
      : `step ${document.steps[0]}`;
  // One request carried every step in this document, so its time is judged against the sum
  // of those steps' targets rather than any single one.
  const budgetMs = document.stepKeys.reduce((n, key) => n + budgetFor(key).ms, 0);
  const endpoint = (() => {
    try {
      return new URL(primary.url).pathname;
    } catch {
      return primary.url;
    }
  })();

  function toggle(next: boolean) {
    setOpen(next);
    if (next && onDisk && !documents[document.step]) onNeedDocument(document.step);
  }

  return (
    <Collapsible open={open} onOpenChange={toggle}>
      <div
        className={cn(
          "rounded-2xl border bg-background",
          !document.ok && "border-destructive/40 bg-destructive/5"
        )}
      >
        <div className="flex items-center gap-2 pr-2">
          <CollapsibleTrigger asChild>
            <button className={cn(DOC_GRID, "min-w-0 flex-1 rounded-l-2xl px-3 py-2 text-left text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none")}>
              <span className="font-mono text-xs text-muted-foreground">{document.id}</span>
              <span className="hidden md:block">
                <RoleChip role={document.role} />
              </span>
              <span className="truncate lg:hidden">
                {document.events} event{document.events === 1 ? "" : "s"} · {span}
              </span>
              <span className="hidden truncate lg:block">
                {document.events} event{document.events === 1 ? "" : "s"} · {span}
              </span>
              <span className="hidden truncate font-mono text-xs text-muted-foreground lg:block">
                {endpoint}
              </span>
              <span className="hidden md:block">
                <StatusPill status={primary.status} />
              </span>
              <span
                className="hidden md:block"
                title={`One request for ${document.stepKeys.length} step${document.stepKeys.length === 1 ? "" : "s"} · combined target p95 < ${budgetMs.toLocaleString()} ms`}
              >
                <DurationPill
                  ms={primary.durationMs}
                  budgetMs={budgetMs}
                  untimed={primary.method === "UI"}
                />
              </span>
              <ChevronDown
                className={cn(
                  "size-4 justify-self-end text-muted-foreground transition-transform duration-(--duration-enter) ease-(--ease-emphasis)",
                  open && "rotate-180"
                )}
              />
            </button>
          </CollapsibleTrigger>
          {body && <CopyButton text={pretty(body)} label={`document ${document.id}`} />}
        </div>
        <CollapsibleContent>
          <div className="space-y-3 border-t px-3 py-3">
            {document.variants.map((v, i) => {
              const text = i === 0 ? body : (v.requestBody ?? null);
              return text ? (
                <CodeBlock
                  key={i}
                  label={`Whole document sent${document.variants.length > 1 ? ` (${v.variant})` : ""}`}
                  text={pretty(text)}
                  copyable
                />
              ) : (
                <p key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                  {onDisk && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                  {onDisk ? "Loading the saved document…" : "This run did not record the body it sent."}
                </p>
              );
            })}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

const FILTERS: { key: "all" | Outcome; label: string }[] = [
  { key: "all", label: "All" },
  { key: "fail", label: "Failed" },
  { key: "skipped", label: "Skipped" },
  { key: "pass", label: "Passed" },
];

export function Logs() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<{ id: string; results: RunResult[] } | null>(null);
  const [runsLoaded, setRunsLoaded] = useState(false);
  // A failed request used to leave the page on "Loading…" forever; it now says so.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Outcome>("all");
  // Documents read back from disk for steps too large to store inline, keyed by step.
  const [documents, setDocuments] = useState<Record<string, string>>({});
  const [copyState, setCopyState] = useState<"idle" | "working" | "copied" | "failed">("idle");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/runs")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (cancelled) return;
        setRuns(d.runs || []);
        setRunsLoaded(true);
        if (d.runs?.[0]) setSelectedRunId(d.runs[0].id);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setRunsLoaded(true);
        setLoadError(`Could not load the run list (${err.message}). Is the dashboard server running?`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    let cancelled = false;
    fetch(`/api/runs?id=${encodeURIComponent(selectedRunId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (cancelled) return;
        setLoadError(null);
        setRunDetail(d);
        setDocuments({});
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(`Could not load run ${selectedRunId} (${err.message}).`);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  function loadDocument(step: string) {
    if (!selectedRunId || documents[step]) return;
    fetchDocument(selectedRunId, step)
      .then((text) => setDocuments((prev) => ({ ...prev, [step]: text })))
      .catch(() => {});
  }

  /** The whole run as one JSON array: every step, what it sent, and what came back. */
  async function copyWholeRun() {
    if (!runDetail || !selectedRunId) return;
    const runId = selectedRunId;
    setCopyState("working");
    const parse = (text: string | null | undefined) => {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    try {
      const steps = await Promise.all(
        runDetail.results.map(async (r, i) => {
          const step = stepKeyOf(r);
          const first = r.variants?.[0];
          let body: string | null = first?.requestBody ?? documents[step] ?? null;
          if (!body && first?.documentPath) {
            body = await fetchDocument(runId, step).catch(() => null);
          }
          return {
            step: i + 1,
            testId: r.testId,
            title: r.eventType,
            role: r.role ?? null,
            outcome: outcomeOf(r),
            reason: r.error ?? null,
            variants: (r.variants || []).map((variant, n) => ({
              variant: variant.variant,
              method: variant.method,
              url: variant.url,
              status: variant.status,
              durationMs: variant.durationMs,
              request: parse(n === 0 ? body : variant.requestBody),
              response: parse(variant.responseBody),
            })),
          };
        })
      );
      await navigator.clipboard.writeText(JSON.stringify({ run: runDetail.id, steps }, null, 2));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 2000);
  }

  const loading =
    !loadError && (!runsLoaded || (!!selectedRunId && runDetail?.id !== selectedRunId));
  const results = runDetail?.results || [];
  const counts = {
    all: results.length,
    fail: results.filter((r) => outcomeOf(r) === "fail").length,
    skipped: results.filter((r) => outcomeOf(r) === "skipped").length,
    pass: results.filter((r) => outcomeOf(r) === "pass").length,
  };
  const shown = filter === "all" ? results : results.filter((r) => outcomeOf(r) === filter);
  const documents_ = documentsOf(results);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          Every step of a run — passed, failed and skipped — with the event body that was sent, the
          platform&apos;s response, and a copy-pasteable repro.
        </p>
        {runs.length > 0 && (
          <Select value={selectedRunId ?? undefined} onValueChange={setSelectedRunId}>
            <SelectTrigger className="w-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {runs.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.role} · {new Date(r.startedAt).toLocaleString()} · {r.passed}/
                  {r.total - (r.skipped ?? 0)} passed
                  {r.skipped ? ` · ${r.skipped} skipped` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {loadError ? (
        <Card>
          <CardContent className="text-sm text-destructive" role="alert">
            {loadError}
          </CardContent>
        </Card>
      ) : runs.length === 0 && !loading ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            No runs yet — start one from the Run tab.
          </CardContent>
        </Card>
      ) : loading ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading run">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="py-0">
              <div className={cn(ROW_GRID, "px-4 py-3")}>
                <Skeleton className="h-3 w-5" />
                <Skeleton className="hidden h-3 w-24 md:block" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="hidden h-5 w-24 rounded-full md:block" />
                <Skeleton className="hidden h-5 w-20 rounded-full sm:block" />
                <Skeleton className="hidden h-5 w-16 rounded-full lg:block" />
                <Skeleton className="h-5 w-14 rounded-full" />
                <Skeleton className="size-4 justify-self-end rounded-sm" />
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Tabs defaultValue="steps" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabsList>
              <TabsTrigger value="steps">
                Steps <span className="ml-1 tabular-nums">{results.length}</span>
              </TabsTrigger>
              <TabsTrigger value="documents">
                Documents <span className="ml-1 tabular-nums">{documents_.length}</span>
              </TabsTrigger>
            </TabsList>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copyWholeRun}
              disabled={copyState === "working" || results.length === 0}
            >
              {copyState === "working" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : copyState === "copied" ? (
                <CheckCheck aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
              <span aria-live="polite">
                {copyState === "working"
                  ? "Collecting…"
                  : copyState === "copied"
                    ? "Whole run copied"
                    : copyState === "failed"
                      ? "Copy failed"
                      : "Copy whole run"}
              </span>
            </Button>
          </div>

          <TabsContent value="steps" className="space-y-2">
            <div role="group" aria-label="Filter steps" className="flex flex-wrap gap-2">
              {FILTERS.map((f) => (
                <Toggle
                  key={f.key}
                  size="sm"
                  variant="outline"
                  pressed={filter === f.key}
                  onPressedChange={() => setFilter(f.key)}
                  disabled={f.key !== "all" && counts[f.key] === 0}
                  className="data-[state=on]:border-primary/70 data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
                >
                  {f.label}
                  <span className="tabular-nums">{counts[f.key]}</span>
                </Toggle>
              ))}
            </div>

            {shown.length === 0 ? (
              <Card>
                <CardContent className="text-sm text-muted-foreground">
                  No {FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} steps in this run.
                </CardContent>
              </Card>
            ) : (
              shown.map((r) => (
                <StepRow
                  key={stepKeyOf(r)}
                  result={r}
                  index={results.indexOf(r) + 1}
                  documents={documents}
                  onNeedDocument={loadDocument}
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="documents" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              What actually went over the wire, one row per request. In combined mode a single
              document carries several steps, so a whole role bundle lives here.
            </p>
            {documents_.length === 0 ? (
              <Card>
                <CardContent className="text-sm text-muted-foreground">
                  This run sent no documents.
                </CardContent>
              </Card>
            ) : (
              documents_.map((d) => (
                <DocumentRow
                  key={d.id}
                  document={d}
                  documents={documents}
                  onNeedDocument={loadDocument}
                />
              ))
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

export default Logs;
