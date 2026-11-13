"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  CircleCheck,
  CircleX,
  Clock,
  Filter,
  Gauge,
  History,
  Layers,
  RefreshCw,
  Rows3,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, PanelFigure } from "@/components/panel";
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
import { Grid } from "@/components/charts/grid";
import { ChartTooltip } from "@/components/charts/tooltip";

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

const ROLES = ["all", "manufacturer", "distributor", "facility", "end-to-end", "ui", "load"] as const;

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

  const latencySeries = useMemo(() => {
    // The chart keys each bar by its label, so two runs in the same minute need telling apart.
    const seen = new Map<string, number>();
    return [...items]
      .slice(0, 16)
      .reverse()
      .filter((r) => r.health?.latencyMs != null)
      .map((r) => {
        const base = new Date(r.health?.checkedAt || r.startedAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return { label: n > 1 ? `${base} #${n}` : base, latency: r.health!.latencyMs as number };
      });
  }, [items]);

  // One evenly spaced bar per day: on a time axis, runs close together draw on top of each other,
  // which hides the failures underneath. Newest 14 days with results; each run is in History.
  const suiteBars = useMemo(() => {
    const byDay = new Map<number, { date: Date; passed: number; failed: number }>();
    for (const r of items) {
      if (r.total === 0) continue;
      const d = new Date(r.startedAt);
      d.setHours(0, 0, 0, 0);
      const day = byDay.get(d.getTime()) ?? { date: d, passed: 0, failed: 0 };
      day.passed += r.passed;
      day.failed += r.failed;
      byDay.set(d.getTime(), day);
    }
    return [...byDay.values()]
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .slice(-14)
      .map((day) => ({
        label: day.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        passed: day.passed,
        failed: day.failed,
      }));
  }, [items]);

  const suiteDelta = delta(current?.passRate, past?.passRate);
  const failDelta = delta(current?.failed, past?.failed);
  const latencyDelta = delta(current?.health?.latencyMs ?? null, past?.health?.latencyMs ?? null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Host reachability and suite health — current vs past, with filterable history.
        </p>
        <Button size="sm" variant="outline" onClick={() => { loadHistory(); loadLive(probeUrl || undefined); }} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Live probe" icon={Activity} bodyClassName="gap-3">
          <PanelFigure
            label="Partner API host, right now"
            value={live ? `${live.latencyMs} ms` : "—"}
            note={live?.status != null ? `HTTP ${live.status}` : undefined}
          />
          <div className="text-sm">
            <HostBadge live={live} />
          </div>
          <div className="mt-auto flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1 space-y-1.5">
              <Label htmlFor="probe-url">Base URL (optional)</Label>
              <Input
                id="probe-url"
                placeholder="Default from .env"
                value={probeUrl}
                onChange={(e) => setProbeUrl(e.target.value)}
              />
            </div>
            <Button variant="outline" onClick={() => loadLive(probeUrl || undefined)} disabled={probing}>
              {probing ? "Checking…" : "Check now"}
            </Button>
          </div>
        </Panel>

        <Panel title="Latest run" icon={Layers} bodyClassName="gap-3">
          <PanelFigure
            label={current ? `Suite pass rate · ${current.role}` : "No matching runs"}
            value={current?.passRate != null ? `${current.passRate}%` : "—"}
            note={current?.id.split("_").slice(-1)[0]}
          />
          {current && (
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Results</dt>
                <dd className="font-mono text-xs tabular-nums">
                  {current.passed} passed · {current.failed} failed
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">At run start</dt>
                <dd>
                  <HostBadge health={current.health} />
                </dd>
              </div>
            </dl>
          )}
        </Panel>

        <Panel title="Previous run" icon={History} bodyClassName="gap-3">
          <PanelFigure
            label={past ? `Suite pass rate · ${past.role}` : "No prior run"}
            value={past?.passRate != null ? `${past.passRate}%` : "—"}
            note={past?.id.split("_").slice(-1)[0]}
          />
          {past && (
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Results</dt>
                <dd className="font-mono text-xs tabular-nums">
                  {past.passed} passed · {past.failed} failed
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">At run start</dt>
                <dd>
                  <HostBadge health={past.health} />
                </dd>
              </div>
              {(suiteDelta != null || failDelta != null || latencyDelta != null) && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Latest vs this run</dt>
                  <dd className="text-right font-mono text-xs tabular-nums">
                    {[
                      suiteDelta != null && `${suiteDelta}% pass`,
                      failDelta != null && `${failDelta} fails`,
                      latencyDelta != null && `${latencyDelta} ms`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </Panel>
      </div>

      <Panel title="Filters" icon={Filter} bodyClassName="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
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
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Latency over time" icon={Gauge}>
          <p className="mb-3 text-sm text-muted-foreground">Host probe latency (ms), filtered runs</p>
          {loading ? (
            <BarChartLoading aspectRatio="2 / 1" className="w-full" />
          ) : latencySeries.length < 2 ? (
            <p className="text-sm text-muted-foreground">Need at least two probes with latency.</p>
          ) : (
            <BarChart data={latencySeries} xDataKey="label" aspectRatio="2 / 1" className="w-full">
              <Grid horizontal />
              <Bar dataKey="latency" fill="var(--chart-1)" lineCap={4} />
              <BarXAxis maxLabels={5} />
              <ChartTooltip />
            </BarChart>
          )}
        </Panel>

        <Panel title="Suite health over time" icon={Layers}>
          <p className="mb-3 text-sm text-muted-foreground">
            Passed and failed tests per day · latest {suiteBars.length} days with runs
          </p>
          {loading ? (
            <BarChartLoading aspectRatio="2 / 1" className="w-full" />
          ) : suiteBars.length < 2 ? (
            <p className="text-sm text-muted-foreground">
              Need results from at least two days to chart.
            </p>
          ) : (
            <>
              <BarChart data={suiteBars} xDataKey="label" aspectRatio="2 / 1" stacked barGap={0.4} className="w-full">
                <Grid horizontal />
                <Bar dataKey="passed" fill="var(--success)" lineCap={2} />
                <Bar dataKey="failed" fill="var(--destructive)" lineCap={2} />
                <BarXAxis maxLabels={7} />
                <ChartTooltip />
              </BarChart>
              <ul className="mt-3 flex gap-4 text-xs text-muted-foreground">
                <li className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-xs bg-success" aria-hidden="true" /> Passed
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-xs bg-destructive" aria-hidden="true" /> Failed
                </li>
              </ul>
            </>
          )}
        </Panel>
      </div>

      <Panel
        title="History"
        icon={Rows3}
        bodyClassName="overflow-hidden p-0"
        action={
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {loading ? "Loading…" : `${items.length} snapshot${items.length === 1 ? "" : "s"}`}
          </span>
        }
      >
          {items.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
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
                        <Badge variant={row.health.reachable ? "success" : "destructive"}>
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
      </Panel>
    </div>
  );
}

export default Health;
