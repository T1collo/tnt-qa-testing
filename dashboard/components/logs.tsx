"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type RunSummary = {
  id: string;
  role: string;
  startedAt: string;
  status: string;
  total: number;
  passed: number;
  skipped?: number;
};

type WorkbookRow = {
  sheetName: string;
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
  variants: ResultVariant[];
  ok: boolean; skipped?: boolean;
  error?: string;
  workbook: WorkbookRow | null;
};

function buildCurl(variant: ResultVariant) {
  // Portal steps are browser actions; their "request" is the script that performs them.
  if (variant.method === "UI") return `# Browser step on ${variant.url}\n${variant.requestBody ?? ""}`;
  const headers = Object.entries(variant.requestHeaders || {})
    .map(([k, v]) => `  -H "${k}: ${v === "***" ? "$YOUR_API_KEY" : v}"`)
    .join(" \\\n");
  const bodyFlag = variant.requestBody
    ? ` \\\n  --data-raw '${variant.requestBody.replace(/'/g, "'\\''")}'`
    : "";
  return `curl -X ${variant.method} "${variant.url}" \\\n${headers}${bodyFlag}`;
}

function FailedTestRow({ result }: { result: RunResult }) {
  const [open, setOpen] = useState(false);
  const wb = result.workbook;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="overflow-hidden py-0">
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-muted/50">
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-muted-foreground">{result.testId}</span>
              <span>{wb?.description || result.eventType}</span>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant="destructive">FAIL</Badge>
              <ChevronDown className={`size-4 text-muted-foreground transition-transform duration-(--duration-enter) ease-(--ease-emphasis) ${open ? "rotate-180" : ""}`} />
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-4 border-t bg-muted/30 px-4 py-4 text-sm">
            {wb && (
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  What this test checks (reference — {wb.sheetName})
                </h4>
                <p className="whitespace-pre-wrap">{wb.description}</p>
                {wb.testSteps && (
                  <>
                    <h4 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Steps to recreate manually
                    </h4>
                    <p className="whitespace-pre-wrap">{wb.testSteps}</p>
                  </>
                )}
                {wb.expectedResult && (
                  <>
                    <h4 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Expected result
                    </h4>
                    <p className="whitespace-pre-wrap">{wb.expectedResult}</p>
                  </>
                )}
              </div>
            )}

            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Postman collection reference
              </h4>
              <p className="font-mono text-xs">{(result.path || []).join(" > ")}</p>
            </div>

            {(result.variants || []).map((v, i) => (
              <div key={i} className="rounded-md border bg-background">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <span className="text-xs font-medium">{v.variant}</span>
                  <span className="text-xs text-muted-foreground">
                    {v.status ? `HTTP ${v.status}` : v.error ? "network error" : "—"} · {v.durationMs}ms
                  </span>
                </div>
                <div className="space-y-2 p-3">
                  <div>
                    <div className="mb-1 text-xs text-muted-foreground">
                      Copy-pasteable repro (substitute your own token):
                    </div>
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-slate-900 p-3 text-xs text-slate-100">
                      {buildCurl(v)}
                    </pre>
                  </div>
                  {v.responseBody && (
                    <div>
                      <div className="mb-1 text-xs text-muted-foreground">Actual response received:</div>
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                        {v.responseBody}
                      </pre>
                    </div>
                  )}
                  {v.error && <div className="text-xs text-destructive">Network error: {v.error}</div>}
                </div>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

export function Logs() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<{ id: string; results: RunResult[] } | null>(null);
  const [runsLoaded, setRunsLoaded] = useState(false);
  // A failed request used to leave the page on "Loading…" forever; it now says so.
  const [loadError, setLoadError] = useState<string | null>(null);

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
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(`Could not load run ${selectedRunId} (${err.message}).`);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  const loading =
    !loadError && (!runsLoaded || (!!selectedRunId && runDetail?.id !== selectedRunId));
  const failed = (runDetail?.results || []).filter((r) => !r.ok && !r.skipped);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Every failure from a run, with a plain-English explanation and a copy-pasteable repro.
        </p>
        {runs.length > 0 && (
          <Select value={selectedRunId ?? undefined} onValueChange={setSelectedRunId}>
            <SelectTrigger className="w-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
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
        <Card>
          <CardContent className="text-sm text-muted-foreground">Loading…</CardContent>
        </Card>
      ) : failed.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-emerald-600 dark:text-emerald-400">
            Every test in this run passed — nothing to show here.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {failed.map((r) => (
            <FailedTestRow key={r.stepKey || r.testId} result={r} />
          ))}
        </div>
      )}
    </div>
  );
}

export default Logs;
