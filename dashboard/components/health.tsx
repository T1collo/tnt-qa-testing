"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  CircleCheck,
  CircleX,
  Clock,
  RefreshCw,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BarChart } from "@/components/charts/bar-chart";
import { BarChartLoading } from "@/components/charts/bar-chart-loading";
import { Bar } from "@/components/charts/bar";
import { BarXAxis } from "@/components/charts/bar-x-axis";
import { ComposedChart } from "@/components/charts/composed-chart";
import { Grid } from "@/components/charts/grid";
import { ChartTooltip } from "@/components/charts/tooltip";
import { SeriesBar } from "@/components/charts/series-bar";
import { XAxis } from "@/components/charts/x-axis";

type HostHealth = {
  reachable: boolean;
  status?: number | null;
  latencyMs?: number | null;
  error?: string | null;
  checkedAt?: string;
  baseUrl?: string;
};

type Snapshot = {
  id: string;
  role: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  baseUrl: string | null;
  health: HostHealth | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number | null;
};

type LiveHealth = {
  baseUrl: string;
  reachable: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
};

type Filters = {
  role: string;
  reachable: string;
  status: string;
  baseUrl: string;
  from: string;
  to: string;
};

const ROLES = ["all", "manufacturer", "distributor", "facility", "end-to-end", "ui"] as const;

function delta(current: number | null | undefined, past: number | null | undefined) {
  if (current == null || past == null) return null;
  const d = Math.round((current - past) * 10) / 10;
  if (d === 0) return "±0";
  return d > 0 ? `+${d}` : `${d}`;
}

function HostBadge({ health, live }: { health?: HostHealth | null; live?: LiveHealth | null }) {
  const src = live || health;
  if (!src) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Clock className="size-4 animate-pulse" /> Checking…
      </span>
    );
  }
  const up = src.reachable;
  return (
    <span className={`inline-flex items-center gap-1.5 ${up ? "text-success" : "text-destructive"}`}>
      {up ? <CircleCheck className="size-4" /> : <CircleX className="size-4" />}
      {up ? "Reachable" : "Down"}
      {src.latencyMs != null ? ` · ${src.latencyMs}ms` : ""}
      {"status" in src && src.status != null ? ` · HTTP ${src.status}` : ""}
    </span>
  );
}

export function Health() {
  const [filters, setFilters] = useState<Filters>({
    role: "all",
    reachable: "all",
    status: "all",
    baseUrl: "",
    from: "",
    to: "",
  });
  const [items, setItems] = useState<Snapshot[]>([]);
  const [current, setCurrent] = useState<Snapshot | null>(null);
  const [past, setPast] = useState<Snapshot | null>(null);
  const [live, setLive] = useState<LiveHealth | null>(null);
  const [probeUrl, setProbeUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.role !== "all") p.set("role", filters.role);
    if (filters.reachable !== "all") p.set("reachable", filters.reachable);
    if (filters.status !== "all") p.set("status", filters.status);
    if (filters.baseUrl.trim()) p.set("baseUrl", filters.baseUrl.trim());
    if (filters.from) p.set("from", new Date(filters.from).toISOString());
    if (filters.to) p.set("to", new Date(`${filters.to}T23:59:59`).toISOString());
    return p.toString();
  }, [filters]);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/health/history?${query}`).then((r) => r.json());
      setItems(res.items || []);
      setCurrent(res.current || null);
      setPast(res.past || null);
    } finally {
      setLoading(false);
    }
  }, [query]);

  const loadLive = useCallback(async (baseUrl?: string) => {
    setProbing(true);
    try {
      const q = baseUrl ? `?baseUrl=${encodeURIComponent(baseUrl)}` : "";
      const res = await fetch(`/api/health${q}`).then((r) => r.json());
      if (!res.error) setLive(res);
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    loadLive();
  }, [loadLive]);

  const latencySeries = useMemo(
    () =>
      [...items]
        .slice(0, 16)
        .reverse()
        .filter((r) => r.health?.latencyMs != null)
        .map((r) => ({
          label: new Date(r.health?.checkedAt || r.startedAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          }),
          latency: r.health!.latencyMs as number,
        })),
    [items]
  );

  const suiteBars = useMemo(
    () =>
      [...items]
        .reverse()
        .filter((r) => r.passRate != null || r.total > 0)
        .map((r) => ({
          date: new Date(r.startedAt),
          passed: r.passed,
          failed: r.failed,
        })),
    [items]
  );

  const suiteDelta = delta(current?.passRate, past?.passRate);
  const failDelta = delta(current?.failed, past?.failed);
  const latencyDelta = delta(current?.health?.latencyMs ?? null, past?.health?.latencyMs ?? null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            Host reachability and suite health — current vs past, with filterable history.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => { loadHistory(); loadLive(probeUrl || undefined); }} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Current</CardDescription>
            <CardTitle className="text-xl">
              {current ? (
                <>
                  <span className="font-mono text-base">{current.id.split("_").slice(-1)[0]}</span>
                  <span className="ml-2 text-sm font-normal text-muted-foreground">{current.role}</span>
                </>
              ) : (
                "No matching runs"
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Live probe</div>
              <HostBadge live={live} />
            </div>
            <div>
              <div className="text-xs text-muted-foreground">At run start</div>
              <HostBadge health={current?.health} />
            </div>
            <div className="text-muted-foreground">
              Suite:{" "}
              <span className="font-medium text-foreground">
                {current?.passRate != null ? `${current.passRate}%` : "—"}
              </span>
              {current ? ` · ${current.passed} passed · ${current.failed} failed` : ""}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Past (previous matching run)</CardDescription>
            <CardTitle className="text-xl">
              {past ? (
                <>
                  <span className="font-mono text-base">{past.id.split("_").slice(-1)[0]}</span>
                  <span className="ml-2 text-sm font-normal text-muted-foreground">{past.role}</span>
                </>
              ) : (
                "No prior run"
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <HostBadge health={past?.health} />
            <div className="text-muted-foreground">
              Suite:{" "}
              <span className="font-medium text-foreground">
                {past?.passRate != null ? `${past.passRate}%` : "—"}
              </span>
              {past ? ` · ${past.passed} passed · ${past.failed} failed` : ""}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              {suiteDelta != null && (
                <Badge variant="secondary">Pass rate {suiteDelta}%</Badge>
              )}
              {failDelta != null && <Badge variant="secondary">Fails {failDelta}</Badge>}
              {latencyDelta != null && (
                <Badge variant="secondary">Latency {latencyDelta}ms</Badge>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Live probe</CardTitle>
          <CardDescription>Check the partner API host now (same probe used before runs).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1 space-y-1.5">
            <Label htmlFor="probe-url">Base URL (optional)</Label>
            <Input
              id="probe-url"
              placeholder="Leave blank for default from .env"
              value={probeUrl}
              onChange={(e) => setProbeUrl(e.target.value)}
            />
          </div>
          <Button onClick={() => loadLive(probeUrl || undefined)} disabled={probing}>
            <Activity />
            {probing ? "Checking…" : "Check now"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select
              value={filters.role}
              onValueChange={(v) => v && setFilters((f) => ({ ...f, role: v }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Reachable</Label>
            <Select
              value={filters.reachable}
              onValueChange={(v) => v && setFilters((f) => ({ ...f, reachable: v }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all</SelectItem>
                <SelectItem value="up">up</SelectItem>
                <SelectItem value="down">down</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Run status</Label>
            <Select
              value={filters.status}
              onValueChange={(v) => v && setFilters((f) => ({ ...f, status: v }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all</SelectItem>
                <SelectItem value="complete">complete</SelectItem>
                <SelectItem value="running">running</SelectItem>
                <SelectItem value="error">error</SelectItem>
                <SelectItem value="failed">failed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Base URL contains</Label>
            <Input
              value={filters.baseUrl}
              onChange={(e) => setFilters((f) => ({ ...f, baseUrl: e.target.value }))}
              placeholder="tnt-demo"
            />
          </div>
          <div className="space-y-1.5">
            <Label>From</Label>
            <Input
              type="date"
              value={filters.from}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>To</Label>
            <Input
              type="date"
              value={filters.to}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Latency over time</CardTitle>
          <CardDescription>Host probe latency (ms) for filtered runs</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <BarChartLoading aspectRatio="21 / 9" className="w-full" />
          ) : latencySeries.length < 2 ? (
            <p className="text-sm text-muted-foreground">Need at least two probes with latency.</p>
          ) : (
            <BarChart data={latencySeries} xDataKey="label" aspectRatio="21 / 9" className="w-full">
              <Grid horizontal />
              <Bar dataKey="latency" fill="var(--chart-1)" lineCap={4} />
              <BarXAxis />
              <ChartTooltip />
            </BarChart>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Suite health over time</CardTitle>
          <CardDescription>
            Pass / fail counts as stacked bars · {suiteBars.length} runs
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <BarChartLoading aspectRatio="2 / 1" className="w-full" />
          ) : suiteBars.length < 2 ? (
            <p className="text-sm text-muted-foreground">
              Need at least two runs with suite results to chart.
            </p>
          ) : (
            <ComposedChart
              margin={{ top: 8, right: 8, bottom: 40, left: 8 }}
              data={suiteBars}
              xDataKey="date"
              aspectRatio="2 / 1"
              barGap={0}
              maxBarSize={32}
              stacked
              className="w-full"
            >
              <Grid horizontal />
              <SeriesBar dataKey="passed" fill="var(--success)" radius={4} />
              <SeriesBar dataKey="failed" fill="var(--destructive)" radius={4} />
              <ChartTooltip showCrosshair={false} />
              <XAxis numTicks={8} />
            </ComposedChart>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
          <CardDescription>
            {loading ? "Loading…" : `${items.length} snapshot${items.length === 1 ? "" : "s"}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {items.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              No health snapshots yet. Start a run — every run records a host probe at start.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Host</TableHead>
                  <TableHead>Reachable</TableHead>
                  <TableHead>Latency</TableHead>
                  <TableHead>Pass %</TableHead>
                  <TableHead>Fails</TableHead>
                  <TableHead>Run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(row.health?.checkedAt || row.startedAt).toLocaleString()}
                    </TableCell>
                    <TableCell>{row.role}</TableCell>
                    <TableCell className="max-w-[180px] truncate text-xs text-muted-foreground">
                      {row.baseUrl || "—"}
                    </TableCell>
                    <TableCell>
                      {row.health ? (
                        <Badge variant={row.health.reachable ? "default" : "destructive"}>
                          {row.health.reachable ? "up" : "down"}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">n/a</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.health?.latencyMs != null ? `${row.health.latencyMs}ms` : "—"}
                    </TableCell>
                    <TableCell>{row.passRate != null ? `${row.passRate}%` : "—"}</TableCell>
                    <TableCell>{row.failed}</TableCell>
                    <TableCell>
                      <Link
                        href="/logs"
                        className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                      >
                        {row.id.split("_").slice(-1)[0]}
                        <ArrowRight className="size-3" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default Health;
