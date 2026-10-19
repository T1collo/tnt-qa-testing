"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CircleCheck, CircleX, Clock, Download, RefreshCw, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BarChart } from "@/components/charts/bar-chart";
import { BarChartLoading } from "@/components/charts/bar-chart-loading";
import { Bar } from "@/components/charts/bar";
import { BarXAxis } from "@/components/charts/bar-x-axis";
import { Grid } from "@/components/charts/grid";
import { ChartTooltip } from "@/components/charts/tooltip";

type Run = {
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

type Health = {
  baseUrl: string;
  reachable: boolean;
  status?: number;
  latencyMs: number;
};

function formatDuration(startedAt?: string, finishedAt?: string | null) {
  if (!startedAt || !finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return `${(ms / 1000).toFixed(1)}s`;
}

const ran = (run: { total: number; skipped?: number }) => run.total - (run.skipped ?? 0);

export function Dashboard() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  // Which export is in flight: "all" runs, a single run's id, or none.
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [runsRes, healthRes] = await Promise.all([
      fetch("/api/runs").then((r) => r.json()),
      fetch("/api/health").then((r) => r.json()),
    ]);
    setRuns(runsRes.runs || []);
    setHealth(healthRes);
    setLoading(false);
  }, []);

  useEffect(() => {
    Promise.all([
      fetch("/api/runs").then((r) => r.json()),
      fetch("/api/health").then((r) => r.json()),
    ]).then(([runsRes, healthRes]) => {
      setRuns(runsRes.runs || []);
      setHealth(healthRes);
      setLoading(false);
    });
  }, []);

  // Without a run id the workbook folds in every run; with one, only that run's results.
  async function exportToExcel(runId?: string) {
    setExporting(runId ?? "all");
    setExportError(null);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runId ? { runId } : {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Export failed");
      }
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="(.+)"/);
      const filename = match ? match[1] : "TnT_QA_Test_Cases_export.xlsx";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(null);
    }
  }

  const latest = runs[0];
  const latestRate =
    latest && ran(latest) > 0 ? Math.round((latest.passed / ran(latest)) * 100) : null;

  // The label is also the chart's category key, so it must be unique: runs started in the
  // same minute show seconds, and any still-equal labels get a counter.
  const recentRuns = runs.slice(0, 12);
  const minuteOf = (run: (typeof runs)[number]) =>
    new Date(run.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const minuteCounts = new Map<string, number>();
  for (const run of recentRuns) minuteCounts.set(minuteOf(run), (minuteCounts.get(minuteOf(run)) ?? 0) + 1);
  const usedLabels = new Map<string, number>();
  const chartData = recentRuns
    .map((run) => {
      const base =
        (minuteCounts.get(minuteOf(run)) ?? 0) > 1
          ? new Date(run.startedAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })
          : minuteOf(run);
      const seen = usedLabels.get(base) ?? 0;
      usedLabels.set(base, seen + 1);
      return { label: seen ? `${base} (${seen + 1})` : base, passed: run.passed, failed: run.failed };
    })
    .reverse();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            Pass/fail and system health across API test runs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {exportError && <span className="text-xs text-destructive">{exportError}</span>}
          <Button size="sm" onClick={() => exportToExcel()} disabled={exporting !== null || runs.length === 0}>
            <Download />
            {exporting === "all" ? "Exporting…" : "Export to Excel"}
          </Button>
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>
              {latest ? (
                <>
                  Latest run · <span className="font-mono">{latest.id.split("_").slice(-1)[0]}</span> ·{" "}
                  {new Date(latest.startedAt).toLocaleString()}
                </>
              ) : (
                "Latest run"
              )}
            </CardDescription>
            <CardTitle className="text-3xl">
              {latest ? `${latestRate}%` : loading ? "—" : "No runs"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {latest ? (
              <>
                {latest.passed}/{ran(latest)} passed
                {latest.failed ? ` · ${latest.failed} failed` : ""}
                {latest.skipped ? ` · ${latest.skipped} skipped (no token for that role)` : ""} ·{" "}
                {latest.role} · {formatDuration(latest.startedAt, latest.finishedAt)}
              </>
            ) : (
              "Start one from the Run tab."
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>System health</CardDescription>
            <CardTitle
              className={`flex items-center gap-1.5 text-2xl ${
                health?.reachable ? "text-success" : "text-destructive"
              }`}
            >
              {health ? (
                health.reachable ? (
                  <CircleCheck className="size-5" />
                ) : (
                  <CircleX className="size-5" />
                )
              ) : (
                <Clock className="size-5 animate-pulse" />
              )}
              {health ? (health.reachable ? "Reachable" : "Down") : "Checking…"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-muted-foreground">
            <div className="truncate">
              {health
                ? `${health.baseUrl} ${health.status ? `· HTTP ${health.status}` : ""} · ${health.latencyMs}ms`
                : ""}
            </div>
            <Link
              href="/health"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              View history
              <ArrowRight className="size-3" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Run history</CardDescription>
            <CardTitle className="text-3xl">{runs.length}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            runs recorded (last 200 kept)
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pass / fail</CardTitle>
          <CardDescription>Last {chartData.length || 0} runs, oldest to newest</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <BarChartLoading aspectRatio="21 / 9" className="w-full" />
          ) : chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No runs yet — start one from the Run tab.
            </p>
          ) : (
            <BarChart data={chartData} xDataKey="label" stacked aspectRatio="21 / 9" className="w-full">
              <Grid horizontal />
              <Bar dataKey="passed" fill="var(--success)" lineCap={4} />
              <Bar dataKey="failed" fill="var(--destructive)" lineCap={4} />
              <BarXAxis />
              <ChartTooltip />
            </BarChart>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <div className="divide-y">
              {runs.slice(0, 15).map((run) => {
                const rate = ran(run) > 0 ? Math.round((run.passed / ran(run)) * 100) : 0;
                return (
                  <div key={run.id} className="flex items-center gap-3 px-6 py-2.5 text-sm">
                    <span className="w-24 shrink-0 text-muted-foreground">{run.role}</span>
                    <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">
                      {run.id.split("_").slice(-1)[0]}
                    </span>
                    <Badge variant={rate === 100 ? "default" : rate > 0 ? "secondary" : "destructive"}>
                      {rate}%
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {run.passed}/{ran(run)} passed
                      {run.skipped ? ` · ${run.skipped} skipped` : ""}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {new Date(run.startedAt).toLocaleString()}
                    </span>
                    {/* Re-runs under the same run id (results replaced), with the run's settings
                        pre-filled on the Run page, where the API tokens are entered. */}
                    <Button asChild variant="ghost" size="sm" className="shrink-0">
                      <Link
                        href={`/?rerun=${encodeURIComponent(run.id)}`}
                        aria-label={`Re-run ${run.id}`}
                        aria-disabled={run.status === "running" || undefined}
                        className={run.status === "running" ? "pointer-events-none opacity-50" : undefined}
                        tabIndex={run.status === "running" ? -1 : undefined}
                      >
                        <RotateCcw aria-hidden="true" />
                        Re-run
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => exportToExcel(run.id)}
                      disabled={exporting !== null}
                      aria-label={`Export run ${run.id} to Excel`}
                    >
                      <Download aria-hidden="true" />
                      {exporting === run.id ? "Exporting…" : "Excel"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default Dashboard;
