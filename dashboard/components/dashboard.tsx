"use client";

import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import { CircleCheck, CircleX, Clock, Download, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

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

// Semantic colors rather than the theme's neutral --chart-N grayscale tokens - a mostly
// failing run should read as alarming at a glance. Both come from the same tokens as the
// "Reachable" status and the FAIL badges, so the whole app agrees on what pass and fail look
// like, and both are contrast-checked per theme.
// Steps that were actually attempted. A skipped step (no token for that role) was never sent,
// so counting it in the denominator would make a clean run look like a partial failure.
const ran = (run: { total: number; skipped?: number }) => run.total - (run.skipped ?? 0);

const chartConfig = {
  passed: { label: "Passed", color: "var(--success)" },
  failed: { label: "Failed", color: "var(--destructive)" },
} satisfies ChartConfig;

export function Dashboard() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Used by the manual "Refresh" button (a plain event handler, so setState up front is fine).
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

  // Inlined (rather than calling `load`) so every setState call is visibly inside a .then()
  // callback, not the effect's synchronous body - satisfies react-hooks' set-state-in-effect
  // check, which can't statically see past a call to a separate function.
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

  async function exportToExcel() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch("/api/export", { method: "POST" });
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
      setExporting(false);
    }
  }

  const latest = runs[0];
  const latestRate =
    latest && ran(latest) > 0 ? Math.round((latest.passed / ran(latest)) * 100) : null;

  const chartData = runs
    .slice(0, 12)
    .map((run) => ({
      label: new Date(run.startedAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
      // Kept for the tooltip: the axis needs to stay short, but the tooltip has room to say
      // which run and which role a bar belongs to.
      run: `${new Date(run.startedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })} · ${run.role}`,
      passed: run.passed,
      failed: run.failed,
    }))
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
          <Button size="sm" onClick={exportToExcel} disabled={exporting || runs.length === 0}>
            <Download />
            {exporting ? "Exporting…" : "Export to Excel"}
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
            <CardDescription>Latest run</CardDescription>
            <CardTitle className="text-3xl">
              {latest ? `${latestRate}%` : loading ? "—" : "No runs"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {latest ? (
              <>
                {latest.passed}/{ran(latest)} passed
                {latest.skipped ? ` · ${latest.skipped} skipped` : ""} · {latest.role} ·{" "}
                {formatDuration(latest.startedAt, latest.finishedAt)}
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
                health?.reachable ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
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
          <CardContent className="truncate text-xs text-muted-foreground">
            {health
              ? `${health.baseUrl} ${health.status ? `· HTTP ${health.status}` : ""} · ${health.latencyMs}ms`
              : ""}
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
          <CardTitle>Pass rate trend</CardTitle>
          <CardDescription>Last {chartData.length || 0} runs, oldest to newest</CardDescription>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No runs yet — start one from the Run tab.
            </p>
          ) : (
            <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
              <BarChart data={chartData}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  fontSize={11}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(label, payload) =>
                        `${payload?.[0]?.payload?.run ?? ""} · ${label}`
                      }
                    />
                  }
                />
                <Bar dataKey="passed" stackId="a" fill="var(--color-passed)" radius={[0, 0, 4, 4]} />
                <Bar dataKey="failed" stackId="a" fill="var(--color-failed)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
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
