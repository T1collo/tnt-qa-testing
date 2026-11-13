"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, RefreshCw, X } from "lucide-react";
import {
  setLayoutEngine,
  TopologyControls,
  TopologyFilterSidebar,
  TopologyGraph,
  TopologySearch,
} from "@skyhook-io/k8s-ui/topology";
import type {
  GroupingMode,
  HealthStatus,
  NodeKind,
  Topology,
  TopologyEdge,
  TopologyMode,
  TopologyNode,
} from "@skyhook-io/k8s-ui/types";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// The package's web worker cannot load under Next; this is its documented setting for that.
setLayoutEngine("main-thread");

type Status = "pass" | "warn" | "fail" | "discontinued" | "pending" | "not-run";

type MapEvent = {
  id: string;
  testId: string;
  eventType: string;
  path: string;
  endpoint: string;
  status: Status;
  http: number | null;
  durationMs: number | null;
  error: string | null;
  warnings: string[];
  runId: string | null;
  at: string | null;
};

type MapData = {
  baseUrl: string | null;
  environments: string[];
  running: boolean;
  hub: { reachable: boolean | null; latencyMs: number | null; checkedAt: string | null };
  roles: { role: string; label: string; events: MapEvent[] }[];
};

const STATUS_LABEL: Record<Status, string> = {
  pass: "OK",
  warn: "OK, needs a look",
  fail: "Failed",
  discontinued: "Discontinued",
  pending: "Waiting in this run",
  "not-run": "Not run",
};
const HEALTH: Record<Status, HealthStatus> = {
  pass: "healthy",
  warn: "degraded",
  fail: "unhealthy",
  discontinued: "neutral",
  pending: "unknown",
  "not-run": "unknown",
};
// Radar's connector outcomes, recoloured by patches/@skyhook-io+k8s-ui: verified is green,
// reached yellow, unreachable red, blocked blue, and not-tested a faint dotted line.
const CONNECTOR: Record<Status, TopologyEdge["reachOutcome"]> = {
  pass: "verified",
  warn: "reached",
  fail: "unreachable",
  discontinued: "blocked",
  pending: "not-tested",
  "not-run": "not-tested",
};
// When one connector stands for several results, the most serious one decides its colour.
const SEVERITY: Status[] = ["fail", "discontinued", "warn", "pass", "pending", "not-run"];
const worst = (list: Status[]) => SEVERITY.find((s) => list.includes(s)) ?? "not-run";

const LEGEND = [
  { label: "OK", swatch: "bg-flow-ok" },
  { label: "Needs a look", swatch: "bg-flow-warn" },
  { label: "Failed", swatch: "bg-flow-fail" },
  { label: "Discontinued", swatch: "bg-flow-stopped" },
];

// Radar's graph speaks Kubernetes, so each part of our flow takes the kind closest to its job:
// a partner runs events (Deployment > Pod), which reach a Hub endpoint (Service), served by the
// Hub (Ingress). Filters and node badges therefore show these kind names for now.
const PARTNER_KIND: NodeKind = "Deployment";
const EVENT_KIND: NodeKind = "Pod";
const ENDPOINT_KIND: NodeKind = "Service";
const HUB_KIND: NodeKind = "Ingress";
const ALL_KINDS = [PARTNER_KIND, EVENT_KIND, ENDPOINT_KIND, HUB_KIND];

// The order goods move in, inside one partner.
const CHAINS: Record<string, string[]> = {
  manufacturer: ["Commission", "Pack", "Pack SSCC into SSCC", "Ship"],
  distributor: ["Receive", "Unpack", "Pack", "Ship"],
  facility: ["Receive", "Unpack", "Dispense"],
};
// Where goods cross from one partner to the next.
const HANDOFFS: [string, string, string, string][] = [
  ["manufacturer", "Ship", "distributor", "Receive"],
  ["distributor", "Ship", "facility", "Receive"],
  ["facility", "Return Shipping", "distributor", "Return Receiving"],
  ["distributor", "Return Shipping", "manufacturer", "Return Receiving"],
];

function subtitleOf(e: MapEvent) {
  if (e.status === "not-run" || e.status === "pending") return STATUS_LABEL[e.status];
  const parts = [e.http != null ? `HTTP ${e.http}` : null, e.durationMs != null ? `${e.durationMs.toLocaleString()} ms` : null];
  return parts.filter(Boolean).join(" · ") || STATUS_LABEL[e.status];
}

function toTopology(data: MapData): Topology {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const link = (source: string, target: string, type: TopologyEdge["type"], status: Status) =>
    edges.push({ id: `${source}->${target}`, source, target, type, reachOutcome: CONNECTOR[status] });
  const find = (role: string, eventType: string) =>
    data.roles.find((r) => r.role === role)?.events.find((e) => e.eventType === eventType);

  const hubId = "hub";
  const all = data.roles.flatMap((r) => r.events);
  nodes.push({
    id: hubId,
    kind: HUB_KIND,
    name: data.baseUrl?.replace(/^https?:\/\//, "") ?? "TnT Hub",
    status: data.hub.reachable === false ? "unhealthy" : data.hub.reachable ? "healthy" : "unknown",
    data: { namespace: "TnT Hub", labels: { app: "TnT Hub" }, subtitleOverride: "TnT Hub" },
  });

  for (const r of data.roles) {
    const groupData = { namespace: r.label, labels: { app: r.label } };
    const partnerId = `partner:${r.role}`;
    const failed = r.events.filter((e) => e.status === "fail").length;
    nodes.push({
      id: partnerId,
      kind: PARTNER_KIND,
      name: r.label,
      status: HEALTH[worst(r.events.map((e) => e.status))],
      data: { ...groupData, subtitleOverride: `${r.events.length - failed}/${r.events.length} events OK` },
    });

    const chain = CHAINS[r.role] ?? [];
    const byEndpoint = new Map<string, MapEvent[]>();
    for (const e of r.events) {
      byEndpoint.set(e.endpoint, [...(byEndpoint.get(e.endpoint) ?? []), e]);
      nodes.push({
        id: e.id,
        kind: EVENT_KIND,
        name: e.eventType,
        status: HEALTH[e.status],
        data: { ...groupData, phase: STATUS_LABEL[e.status], subtitleOverride: subtitleOf(e), event: e },
      });
      // Steps later in the chain are reached through the step before them, not from the partner.
      const position = chain.indexOf(e.eventType);
      if (position <= 0) link(partnerId, e.id, "manages", e.status);
      else {
        const previous = find(r.role, chain[position - 1]);
        if (previous) link(previous.id, e.id, "routes-to", worst([previous.status, e.status]));
      }
    }

    for (const [endpoint, events] of byEndpoint) {
      const endpointId = `endpoint:${r.role}:${endpoint}`;
      const status = worst(events.map((e) => e.status));
      nodes.push({
        id: endpointId,
        kind: ENDPOINT_KIND,
        name: endpoint.replace("/api/integration", ""),
        status: HEALTH[status],
        data: { ...groupData, subtitleOverride: "POST" },
      });
      // One line in from the end of the goods flow and one out to the Hub, instead of a line
      // per event. The Hub line takes the worst result of every event using this endpoint.
      const onPath = chain.map((name) => events.find((e) => e.eventType === name)).filter((e) => e !== undefined);
      const last = onPath[onPath.length - 1];
      if (last) link(last.id, endpointId, "routes-to", worst(onPath.map((e) => e.status)));
      else link(partnerId, endpointId, "routes-to", status);
      link(endpointId, hubId, "routes-to", status);
    }
  }

  for (const [fromRole, fromEvent, toRole, toEvent] of HANDOFFS) {
    const from = find(fromRole, fromEvent);
    const to = find(toRole, toEvent);
    if (from && to) link(from.id, to.id, "routes-to", worst([from.status, to.status]));
  }

  // Later edges draw on top, so problems are never hidden under a healthy line.
  const quiet = (e: TopologyEdge) => (e.reachOutcome === "verified" || e.reachOutcome === "not-tested" ? 0 : 1);
  edges.sort((a, b) => quiet(a) - quiet(b));

  return { nodes, edges, warnings: all.length === 0 ? ["No mapped events"] : undefined };
}

function Detail({ event, onClose }: { event: MapEvent; onClose: () => void }) {
  const rows: [string, string][] = [
    ["Status", STATUS_LABEL[event.status]],
    ["Test ID", event.testId],
    ["Endpoint", event.endpoint],
    ["HTTP", event.http != null ? String(event.http) : "—"],
    ["Duration", event.durationMs != null ? `${event.durationMs.toLocaleString()} ms` : "—"],
    ["Last run", event.at ? new Date(event.at).toLocaleString() : "Never"],
  ];
  return (
    <aside
      aria-label={`${event.eventType} details`}
      className="absolute inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col overflow-y-auto border-l bg-card shadow-lg"
    >
      <div className="flex items-center justify-between gap-3 border-b p-4">
        <h2 className="truncate text-base font-semibold">{event.eventType}</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close details">
          <X />
        </Button>
      </div>
      <dl className="space-y-3 p-4 text-sm">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 font-mono text-xs break-words">{v}</dd>
          </div>
        ))}
        {event.warnings.length > 0 && (
          <div>
            <dt className="text-xs text-muted-foreground">Platform warnings</dt>
            <dd className="mt-0.5 font-mono text-xs break-words">{event.warnings.join(", ")}</dd>
          </div>
        )}
        {event.error && (
          <div>
            <dt className="text-xs text-muted-foreground">Error</dt>
            <dd className="mt-0.5 text-sm break-words text-destructive">{event.error}</dd>
          </div>
        )}
      </dl>
      <div className="mt-auto border-t p-4">
        <Button asChild variant="outline" size="sm" className="w-full">
          <Link href="/logs">
            Open Logs
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </aside>
  );
}

export function SystemMap() {
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [env, setEnv] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [visibleKinds, setVisibleKinds] = useState<Set<NodeKind>>(() => new Set(ALL_KINDS));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selected, setSelected] = useState<MapEvent | null>(null);
  const [viewMode, setViewMode] = useState<TopologyMode>("resources");
  const [groupingMode, setGroupingMode] = useState<GroupingMode>("none");
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [pane, setPane] = useState<HTMLDivElement | null>(null);

  const reload = () => {
    setLoading(true);
    setError(null);
    setReloadKey((k) => k + 1);
  };

  useEffect(() => {
    let cancelled = false;
    const q = env ? `?baseUrl=${encodeURIComponent(env)}` : "";
    fetch(`/api/system-map${q}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: MapData) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Request failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [env, reloadKey]);

  // Quick while a run is going so connectors change as steps finish; slow otherwise, just to
  // notice a run started from another tab. Radar recolours edges without redoing the layout.
  const running = data?.running ?? false;
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setReloadKey((k) => k + 1);
    }, running ? 2000 : 15000);
    return () => clearInterval(timer);
  }, [running]);

  const topology = useMemo(() => (data ? toTopology(data) : null), [data]);
  const shown = useMemo<Topology | null>(() => {
    if (!topology) return null;
    const nodes = topology.nodes.filter((n) => visibleKinds.has(n.kind));
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: topology.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
  }, [topology, visibleKinds]);

  const onNodeClick = useCallback((node: TopologyNode) => {
    const event = node.data.event as MapEvent | undefined;
    if (event) setSelected(event);
  }, []);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Fixed width in the package, so it would push a phone screen sideways. */}
      <div className="hidden h-full shrink-0 md:flex">
      <TopologyFilterSidebar
        nodes={topology?.nodes ?? []}
        visibleKinds={visibleKinds}
        onToggleKind={(kind) =>
          setVisibleKinds((prev) => {
            const next = new Set(prev);
            if (next.has(kind)) next.delete(kind);
            else next.add(kind);
            return next;
          })
        }
        onShowAll={() => setVisibleKinds(new Set(ALL_KINDS))}
        onHideAll={() => setVisibleKinds(new Set())}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
      />
      </div>

      <div ref={setPane} className="relative min-w-0 flex-1">
        {error ? (
          <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm font-medium">The system map could not load</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : (
          <TopologyGraph
            topology={shown}
            viewMode={viewMode}
            groupingMode={groupingMode}
            onNodeClick={onNodeClick}
            selectedNodeId={selected?.id}
            showExportButton={false}
            focusNodeId={focus?.id}
            focusNonce={focus?.nonce}
          >
            {/* The overlay ignores the pointer so the canvas pans through its gaps. Controls
                have to opt back in, or clicks fall through to the map. */}
            <div className="flex w-full flex-wrap items-start justify-between gap-2">
              <div className="pointer-events-auto">
                <TopologySearch
                  nodes={shown?.nodes ?? []}
                  allNodes={topology?.nodes}
                  onNodeSelect={onNodeClick}
                  onZoomToNode={(id) => setFocus((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }))}
                  overlayContainer={pane}
                />
              </div>
              <div className="pointer-events-auto flex flex-wrap items-center gap-2">
                {data && data.environments.length > 0 && (
                  <Select
                    value={data.baseUrl ?? undefined}
                    onValueChange={(v) => {
                      if (!v) return;
                      setLoading(true);
                      setError(null);
                      setSelected(null);
                      setEnv(v);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Environment" className="max-w-64 cursor-pointer bg-card font-mono text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {data.environments.map((e) => (
                        <SelectItem key={e} value={e} className="font-mono text-xs">
                          {e.replace(/^https?:\/\//, "")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button variant="outline" size="sm" className="cursor-pointer bg-card" onClick={reload} disabled={loading}>
                  <RefreshCw className={loading ? "animate-spin" : ""} aria-hidden="true" />
                  Refresh
                </Button>
                <TopologyControls
                  viewMode={viewMode}
                  onViewModeChange={setViewMode}
                  groupingMode={groupingMode}
                  onGroupingModeChange={setGroupingMode}
                />
              </div>
            </div>
          </TopologyGraph>
        )}

        <ul
          aria-label="Connector colours"
          className="pointer-events-none absolute right-3 bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-1.5 text-xs"
        >
          {running && (
            <li className="flex items-center gap-1.5 font-medium text-primary" role="status">
              <RefreshCw className="size-3 animate-spin" aria-hidden="true" />
              Run in progress
            </li>
          )}
          {LEGEND.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <span className={`h-0.5 w-4 rounded-full ${l.swatch}`} aria-hidden="true" />
              {l.label}
            </li>
          ))}
        </ul>

        {selected && <Detail event={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
