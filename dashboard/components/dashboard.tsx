"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { curveMonotoneX } from "@visx/curve";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  Download,
  Gauge,
  History,
  Layers,
  MonitorPlay,
  MoreVertical,
  RefreshCw,
  RotateCcw,
  Route,
  ScrollText,
  Server,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { LineChart } from "@/components/charts/line-chart";
import { Line } from "@/components/charts/line";
import { Grid } from "@/components/charts/grid";
import { XAxis } from "@/components/charts/x-axis";
import { ChartTooltip } from "@/components/charts/tooltip";
import { DotMatrix, type DotColumn } from "@/components/dot-matrix";
import { ReachabilityCalendar } from "@/components/reachability-calendar";
import { HealthRings } from "@/components/health-rings";
import { Delta, Panel, PanelFigure } from "@/components/panel";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

gsap.registerPlugin(useGSAP);

type Run = {
  id: string;
  role: string;
  documentMode?: string | null;
  baseUrl?: string | null;
  health?: { reachable?: boolean; latencyMs?: number | null } | null;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  total: number;
  passed: number;
  failed: number;
  skipped?: number;
};

const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const TREND_DAYS = 14;
const MATRIX_ROWS = 8;
const LATENCY_RUNS = 40;

const attempted = (r: Run) => Math.max(0, (r.total || 0) - (r.skipped ?? 0));
const rateOf = (passed: number, tried: number) => (tried > 0 ? (passed / tried) * 100 : null);
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// Which part of the suite a run belongs to, from the role its run record carries.
const SUITES = [
  { key: "api", label: "Single role (API)", icon: Server, match: (r: Run) => ["manufacturer", "distributor", "facility"].includes(r.role) },
  { key: "e2e", label: "End-to-end journey", icon: Route, match: (r: Run) => r.role === "end-to-end" },
  { key: "ui", label: "Browser UI", icon: MonitorPlay, match: (r: Run) => r.role === "ui" },
  { key: "load", label: "Load (k6)", icon: Activity, match: (r: Run) => r.role === "load" },
] as const;

function suiteOf(run: Run) {
  return SUITES.find((s) => s.match(run)) ?? null;
}

function scopeOf(run: Run) {
  if (run.role === "load") return (run.documentMode || "load").split("+").join(", ");
  if (run.role === "ui") return run.documentMode === "headed" ? "headed" : "headless";
  if (run.role === "end-to-end") return run.documentMode || "journey";
  return run.role;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(iso: string, now: number) {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return relative.format(s, "second");
  if (abs < 3600) return relative.format(Math.round(s / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(s / 3600), "hour");
  return relative.format(Math.round(s / 86400), "day");
}

function host(url?: string | null) {
  if (!url) return "—";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type Outcome = { label: string; tone: "success" | "destructive" | "warning" | "muted" };
function outcomeOf(run: Run): Outcome {
  if (run.status === "running") return { label: "Running", tone: "muted" };
  if (run.status === "error") return { label: "Error", tone: "destructive" };
  if (run.status === "stopped") return { label: "Stopped", tone: "warning" };
  if (attempted(run) === 0) return { label: "Nothing ran", tone: "warning" };
  return run.failed > 0 ? { label: "Failed", tone: "destructive" } : { label: "Passed", tone: "success" };
}

const TONE: Record<Outcome["tone"], string> = {
  success: "border-success/30 bg-success/10 text-success",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  warning: "border-warning/30 bg-warning/10 text-warning",
  muted: "border-border bg-muted text-muted-foreground",
};

function StatusChip({ outcome }: { outcome: Outcome }) {
  return (
    <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium", TONE[outcome.tone])}>
      {outcome.label}
    </span>
  );
}

type SortKey = "startedAt" | "passRate";

export function Dashboard() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "startedAt", dir: "desc" });
  const rootRef = useRef<HTMLDivElement>(null);
  // A phone gets a taller trend chart with fewer date ticks, so labels never collide.
  const isMobile = useIsMobile();

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/runs");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { runs?: Run[] };
      setRuns(data.runs || []);
      setLoadError(null);
      setNow(Date.now());
    } catch (err) {
      setLoadError(`Could not load the run history (${err instanceof Error ? err.message : "request failed"}).`);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Initial load; `load` only sets state once the request settles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // One quiet reveal when the data first lands: panels rise in, bars fill from the left.
  // Reduced motion gets the final state with no movement.
  const loaded = runs !== null;
  useGSAP(
    () => {
      if (!loaded) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from("[data-panel]", { opacity: 0, y: 10, duration: 0.35, ease: "power2.out", stagger: 0.04 });
        gsap.from("[data-bar-fill]", { scaleX: 0, transformOrigin: "left center", duration: 0.6, ease: "power2.out", delay: 0.15 });
      });
      return () => mm.revert();
    },
    { scope: rootRef, dependencies: [loaded] }
  );

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
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = match ? match[1] : "TnT_QA_Test_Cases_export.xlsx";
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

  const stats = useMemo(() => {
    const all = runs ?? [];
    const today = startOfDay(now);
    const inWindow = (r: Run, fromDays: number, toDays: number) => {
      const t = new Date(r.startedAt).getTime();
      return t >= today - (fromDays - 1) * DAY && t < today + DAY - toDays * DAY;
    };
    const current = all.filter((r) => inWindow(r, WINDOW_DAYS, 0));
    const previous = all.filter((r) => inWindow(r, WINDOW_DAYS * 2, WINDOW_DAYS));

    // Availability: was the environment reachable when each run started?
    const probed = (list: Run[]) => list.filter((r) => typeof r.health?.reachable === "boolean");
    const uptime = (list: Run[]) => {
      const p = probed(list);
      return p.length ? (p.filter((r) => r.health?.reachable).length / p.length) * 100 : null;
    };
    const availability: DotColumn[] = Array.from({ length: WINDOW_DAYS }, (_, i) => {
      const dayStart = today - (WINDOW_DAYS - 1 - i) * DAY;
      const day = probed(all).filter((r) => {
        const t = new Date(r.startedAt).getTime();
        return t >= dayStart && t < dayStart + DAY;
      });
      const down = day.filter((r) => !r.health?.reachable).length;
      const date = new Date(dayStart).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return {
        key: String(dayStart),
        title: day.length ? `${date}: ${day.length} run${day.length === 1 ? "" : "s"}, ${down} unreachable` : `${date}: no runs`,
        filled: Math.min(MATRIX_ROWS, day.length),
        alert: Math.min(MATRIX_ROWS, down),
      };
    });
    const downDays = availability.filter((c) => (c.alert ?? 0) > 0).length;

    // Pass rate over attempted tests (skipped tests ran nowhere, so they do not count).
    const sum = (list: Run[], f: (r: Run) => number) => list.reduce((n, r) => n + f(r), 0);
    const passRate = (list: Run[]) => rateOf(sum(list, (r) => r.passed), sum(list, attempted));
    const tried = sum(current, attempted);
    const passedNow = sum(current, (r) => r.passed);
    const failedNow = sum(current, (r) => r.failed);

    // Host probe latency, oldest to newest, as the height of each column.
    const timed = all
      .filter((r) => typeof r.health?.latencyMs === "number")
      .slice(0, LATENCY_RUNS)
      .reverse();
    const latencies = timed.map((r) => r.health!.latencyMs as number);
    const sorted = [...latencies].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
    const median = pct(50);
    const p90 = pct(90);
    // Log scale: 20 ms fills one dot, 3 s fills the column.
    const level = (ms: number) =>
      Math.max(1, Math.min(MATRIX_ROWS, Math.round((Math.log(Math.max(ms, 20) / 20) / Math.log(3000 / 20)) * MATRIX_ROWS)));
    const latency: DotColumn[] = timed.map((r) => ({
      key: r.id,
      title: `${new Date(r.startedAt).toLocaleString()}: ${r.health!.latencyMs} ms`,
      filled: level(r.health!.latencyMs as number),
      mode: "peak",
    }));

    // Per suite, last 30 days.
    const suites = SUITES.map((s) => {
      const list = current.filter(s.match);
      return { ...s, runs: list.length, rate: passRate(list) };
    });

    // Daily passed / failed counts for the trend line.
    const trend = Array.from({ length: TREND_DAYS }, (_, i) => {
      const dayStart = today - (TREND_DAYS - 1 - i) * DAY;
      const day = all.filter((r) => {
        const t = new Date(r.startedAt).getTime();
        return t >= dayStart && t < dayStart + DAY;
      });
      return { date: new Date(dayStart), passed: sum(day, (r) => r.passed), failed: sum(day, (r) => r.failed) };
    });
    const trendTotal = trend.reduce((n, d) => n + d.passed + d.failed, 0);
    const todayCount = trend[trend.length - 1].passed + trend[trend.length - 1].failed;

    const nowRate = passRate(current);
    const prevRate = passRate(previous);
    const nowUp = uptime(current);
    const prevUp = uptime(previous);
    return {
      current,
      uptime: nowUp,
      uptimeDelta: nowUp !== null && prevUp !== null ? nowUp - prevUp : null,
      probedCount: probed(current).length,
      availability,
      downDays,
      passRate: nowRate,
      passDelta: nowRate !== null && prevRate !== null ? nowRate - prevRate : null,
      tried,
      passedNow,
      failedNow,
      latency,
      median,
      p90,
      suites,
      trend,
      trendTotal,
      todayCount,
      latestAt: all[0]?.startedAt ?? null,
    };
  }, [runs, now]);

  const tableRuns = useMemo(() => {
    const list = [...(runs ?? [])];
    const key = (r: Run) =>
      sort.key === "startedAt" ? new Date(r.startedAt).getTime() : (rateOf(r.passed, attempted(r)) ?? -1);
    list.sort((a, b) => (sort.dir === "asc" ? key(a) - key(b) : key(b) - key(a)));
    return list;
  }, [runs, sort]);
  const pageCount = Math.max(1, Math.ceil(tableRuns.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageRuns = tableRuns.slice(safePage * pageSize, safePage * pageSize + pageSize);

  function toggleSort(key: SortKey) {
    setPage(0);
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  }

  const fmtPct = (v: number | null) => (v === null ? "—" : `${v.toFixed(v >= 99.95 || v === 0 ? 0 : 1)}%`);
  const showSkeleton = runs === null && !loadError;

  return (
    <div ref={rootRef} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Environment health and test results across every run, last {WINDOW_DAYS} days.
        </p>
        <div className="flex items-center gap-2">
          {exportError && (
            <span role="alert" className="text-xs text-destructive">
              {exportError}
            </span>
          )}
          <Button size="sm" variant="outline" onClick={load} disabled={refreshing}>
            <RefreshCw className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => exportToExcel()} disabled={exporting !== null || !runs?.length}>
            <Download aria-hidden="true" />
            {exporting === "all" ? "Exporting…" : "Export to Excel"}
          </Button>
        </div>
      </div>

      <HealthRings runs={runs && runs.filter((r) => now - new Date(r.startedAt).getTime() < WINDOW_DAYS * DAY)} />

      {loadError && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <span className="text-destructive">{loadError}</span>
          <Button size="sm" variant="outline" onClick={load} disabled={refreshing}>
            Try again
          </Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Environment availability" icon={ShieldCheck}>
          <PanelFigure
            label="Reachable at run start"
            value={showSkeleton ? <Skeleton className="h-9 w-28" /> : fmtPct(stats.uptime)}
            note={<Delta value={stats.uptimeDelta} context={`vs prior ${WINDOW_DAYS} days`} />}
          />
          <div className="mt-4 flex-1">
            {showSkeleton ? (
              <Skeleton className="h-44 w-full" />
            ) : (
              <ReachabilityCalendar runs={runs ?? []} now={now} />
            )}
          </div>
        </Panel>

        <Panel title="Test pass rate" icon={CircleCheckBig}>
          <PanelFigure
            label="Attempted tests that passed"
            value={showSkeleton ? <Skeleton className="h-9 w-28" /> : fmtPct(stats.passRate)}
            note={<Delta value={stats.passDelta} context={`vs prior ${WINDOW_DAYS} days`} />}
          />
          <div className="mt-4 flex h-36 flex-1 gap-1.5">
            {showSkeleton ? (
              <Skeleton className="h-36 w-full" />
            ) : stats.tried === 0 ? (
              <p className="m-auto text-sm text-muted-foreground">No tests ran in the last {WINDOW_DAYS} days.</p>
            ) : (
              [
                { key: "passed", label: "Passed", count: stats.passedNow, bar: "bg-chart-1", rule: "border-chart-1" },
                { key: "failed", label: "Failed", count: stats.failedNow, bar: "bg-highlight", rule: "border-highlight" },
              ].map((part) => {
                const share = (part.count / stats.tried) * 100;
                return (
                  <div
                    key={part.key}
                    className={cn("flex min-w-0 flex-col justify-between border-l-2 pl-3", part.rule)}
                    // Proportional, with a floor so a small share stays readable.
                    style={{ flexGrow: Math.max(share, 22), flexBasis: 0 }}
                  >
                    <div>
                      <p className="font-mono text-lg tabular-nums">{fmtPct(share)}</p>
                      <p className="text-xs text-muted-foreground">
                        {part.label} · {part.count.toLocaleString()}
                      </p>
                    </div>
                    <div className={cn("h-5 w-full rounded-r-sm", part.bar)} data-bar-fill />
                  </div>
                );
              })
            )}
          </div>
          <div className="mt-3 flex justify-between text-sm text-muted-foreground">
            <span>{stats.tried.toLocaleString()} tests attempted</span>
            <span>{stats.current.length} runs</span>
          </div>
        </Panel>

        <Panel title="Response latency" icon={Gauge}>
          <PanelFigure
            label="Median environment probe"
            value={showSkeleton ? <Skeleton className="h-9 w-28" /> : stats.median === null ? "—" : `${stats.median} ms`}
            note={
              stats.p90 === null
                ? null
                : stats.median !== null && stats.p90 > stats.median * 3
                  ? <span className="text-highlight">Spiky · p90 {stats.p90} ms</span>
                  : `Steady · p90 ${stats.p90} ms`
            }
          />
          <div className="mt-4 flex-1">
            {showSkeleton ? (
              <Skeleton className="h-36 w-full" />
            ) : stats.latency.length === 0 ? (
              <p className="flex h-36 items-center justify-center text-sm text-muted-foreground">No probe timings yet.</p>
            ) : (
              <DotMatrix
                columns={stats.latency}
                rows={MATRIX_ROWS}
                caption={`Environment probe latency for the last ${stats.latency.length} runs: median ${stats.median} ms, 90th percentile ${stats.p90} ms. Taller columns are slower.`}
              />
            )}
          </div>
          <div className="mt-3 flex justify-between text-sm text-muted-foreground">
            <span>Last {stats.latency.length || LATENCY_RUNS} runs</span>
            <span>Latest</span>
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel title="Suite results" icon={Layers}>
          <PanelFigure
            label={`Runs in the last ${WINDOW_DAYS} days`}
            value={showSkeleton ? <Skeleton className="h-9 w-20" /> : stats.current.length.toLocaleString()}
            note={stats.latestAt ? `Updated ${ago(stats.latestAt, now)}` : null}
          />
          <ul className="mt-2 divide-y">
            {stats.suites.map((s) => {
              const health =
                s.rate === null
                  ? { label: "No runs", tone: "muted" as const }
                  : s.rate >= 95
                    ? { label: "Healthy", tone: "success" as const }
                    : s.rate >= 80
                      ? { label: "Watch", tone: "warning" as const }
                      : { label: "Failing", tone: "destructive" as const };
              return (
                <li key={s.key} className="flex items-center gap-3 py-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/60 text-chart-1">
                    <s.icon className="size-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">{s.label}</span>
                      <span className="font-mono text-sm tabular-nums">{fmtPct(s.rate)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3">
                      <div
                        className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
                        role="meter"
                        aria-label={`${s.label} pass rate`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={s.rate === null ? undefined : Math.round(s.rate)}
                        aria-valuetext={s.rate === null ? "No runs" : `${fmtPct(s.rate)} over ${s.runs} runs`}
                      >
                        <div
                          data-bar-fill
                          className={cn(
                            "h-full w-full origin-left rounded-full",
                            health.tone === "destructive" ? "bg-destructive" : health.tone === "warning" ? "bg-highlight" : "bg-chart-1"
                          )}
                          style={{ transform: `scaleX(${(s.rate ?? 0) / 100})` }}
                        />
                      </div>
                      <span className="w-20 shrink-0 text-right">
                        <StatusChip outcome={health} />
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>

        <Panel title="Results trend" icon={TrendingUp}>
          <PanelFigure
            label={`Tests run, last ${TREND_DAYS} days`}
            value={showSkeleton ? <Skeleton className="h-9 w-24" /> : stats.trendTotal.toLocaleString()}
            note={`${stats.todayCount.toLocaleString()} today`}
          />
          <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded-full bg-chart-1" aria-hidden="true" />
              Passed
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded-full bg-highlight" aria-hidden="true" />
              Failed
            </span>
          </div>
          <div className="mt-2 min-h-56 flex-1">
            {showSkeleton ? (
              <Skeleton className="h-56 w-full" />
            ) : stats.trendTotal === 0 ? (
              <p className="flex h-56 items-center justify-center text-sm text-muted-foreground">
                No tests ran in the last {TREND_DAYS} days.
              </p>
            ) : (
              <figure aria-label={`Passed and failed tests per day for the last ${TREND_DAYS} days, ${stats.trendTotal} in total.`}>
                <LineChart data={stats.trend} xDataKey="date" aspectRatio={isMobile ? "4 / 3" : "3 / 1"} className="w-full">
                  <Grid horizontal />
                  {/* Monotone: a smoothed count must never dip below zero or above its real peak. */}
                  <Line dataKey="passed" stroke="var(--chart-1)" strokeWidth={2} curve={curveMonotoneX} />
                  <Line dataKey="failed" stroke="var(--highlight)" strokeWidth={2} curve={curveMonotoneX} />
                  <XAxis numTicks={isMobile ? 3 : 7} />
                  <ChartTooltip />
                </LineChart>
              </figure>
            )}
          </div>
        </Panel>
      </div>

      <Panel
        title="Recent runs"
        icon={History}
        bodyClassName="p-0"
        action={
          <Button asChild variant="ghost" size="sm">
            <Link href="/logs">
              <ScrollText aria-hidden="true" />
              All logs
            </Link>
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="px-4 py-3 font-medium">Run</th>
                <th scope="col" className="px-4 py-3 font-medium">Suite</th>
                <th scope="col" className="px-4 py-3 font-medium">Scope</th>
                <th scope="col" className="px-4 py-3 font-medium">Environment</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                {(
                  [
                    ["passRate", "Pass rate"],
                    ["startedAt", "Started"],
                  ] as const
                ).map(([key, label]) => (
                  <th
                    key={key}
                    scope="col"
                    className="px-2 py-1.5 font-medium"
                    aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <Button variant="ghost" size="sm" onClick={() => toggleSort(key)} className="text-muted-foreground">
                      {label}
                      {sort.key !== key ? (
                        <ArrowUpDown aria-hidden="true" />
                      ) : sort.dir === "asc" ? (
                        <ArrowUp aria-hidden="true" />
                      ) : (
                        <ArrowDown aria-hidden="true" />
                      )}
                    </Button>
                  </th>
                ))}
                <th scope="col" className="w-12 px-4 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {showSkeleton &&
                Array.from({ length: 5 }, (_, i) => (
                  <tr key={i}>
                    <td colSpan={8} className="px-4 py-3">
                      <Skeleton className="h-5 w-full" />
                    </td>
                  </tr>
                ))}
              {runs?.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                    No runs yet.{" "}
                    <Link href="/" className="text-primary underline-offset-4 hover:underline">
                      Start one from the Run page.
                    </Link>
                  </td>
                </tr>
              )}
              {pageRuns.map((run) => {
                const suite = suiteOf(run);
                const rate = rateOf(run.passed, attempted(run));
                const busy = run.status === "running";
                return (
                  <tr key={run.id} className="transition-colors duration-(--duration-quick) hover:bg-muted/40">
                    <td className="px-4 py-2.5 font-mono text-xs">{run.id.split("_").slice(-1)[0]}</td>
                    <td className="px-4 py-2.5">{suite?.label ?? run.role}</td>
                    <td className="max-w-48 truncate px-4 py-2.5 text-muted-foreground" title={scopeOf(run)}>
                      {scopeOf(run)}
                    </td>
                    <td className="max-w-48 truncate px-4 py-2.5 text-muted-foreground" title={run.baseUrl ?? undefined}>
                      {host(run.baseUrl)}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusChip outcome={outcomeOf(run)} />
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums">
                      {fmtPct(rate)}
                      <span className="ml-1.5 font-sans text-xs text-muted-foreground">
                        {run.passed}/{attempted(run)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground" title={new Date(run.startedAt).toLocaleString()}>
                      {ago(run.startedAt, now)}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for run ${run.id}`}>
                            <MoreVertical aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild disabled={busy}>
                            <Link href={`/?rerun=${encodeURIComponent(run.id)}`}>
                              <RotateCcw aria-hidden="true" />
                              Re-run with these settings
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={exporting !== null} onSelect={() => void exportToExcel(run.id)}>
                            <Download aria-hidden="true" />
                            {exporting === run.id ? "Exporting…" : "Export to Excel"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {tableRuns.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5 text-sm">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setPage(safePage - 1)}
                disabled={safePage === 0}
                aria-label="Previous page"
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <span className="px-2 tabular-nums text-muted-foreground" aria-live="polite">
                Page {safePage + 1} of {pageCount}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setPage(safePage + 1)}
                disabled={safePage >= pageCount - 1}
                aria-label="Next page"
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <span className="tabular-nums">
                Showing {safePage * pageSize + 1}–{Math.min(tableRuns.length, (safePage + 1) * pageSize)} of{" "}
                {tableRuns.length}
              </span>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => {
                  setPageSize(Number(v));
                  setPage(0);
                }}
              >
                <SelectTrigger size="sm" className="w-28" aria-label="Rows per page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 25, 50].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      Show {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

export default Dashboard;
