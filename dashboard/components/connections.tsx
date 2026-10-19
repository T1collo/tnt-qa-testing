"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  MarkerType,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Activity,
  ArrowRight,
  CircleCheck,
  CircleX,
  Clock,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  WorkflowNode,
  type StepState,
  type WorkflowNodeData,
} from "@/components/flow/workflow-node";
import { WorkflowEdge, type WorkflowEdgeData } from "@/components/flow/workflow-edge";
import { StepInspector } from "@/components/flow/step-inspector";

type E2eStep = {
  key: string;
  index: number;
  role: string;
  label: string;
  testId: string;
  phase: string;
  sync: boolean;
};
type RunSummary = {
  id: string;
  role: string;
  status: string;
  finishedAt: string | null;
  passed: number;
  total: number;
  health?: {
    reachable: boolean;
    status?: number | null;
    latencyMs?: number | null;
    checkedAt?: string;
    baseUrl?: string;
  } | null;
  baseUrl?: string | null;
};
type RunResult = {
  testId: string;
  stepKey?: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  variants: { status: number | null; responseBody?: string; url?: string }[];
};
type LiveHealth = {
  baseUrl: string;
  reachable: boolean;
  status?: number;
  latencyMs: number;
};

const ROLE_ORDER = ["manufacturer", "distributor", "facility"] as const;
const NODE_TYPES = { workflow: WorkflowNode };
const EDGE_TYPES = { workflow: WorkflowEdge };

function defaultLayout(steps: E2eStep[]): Node<WorkflowNodeData>[] {
  const colGap = 280;
  const rowGap = 110;
  const padX = 40;
  const padY = 60;
  const rowOf: Record<string, number> = {};
  return steps.map((step, i) => {
    const col = Math.max(0, ROLE_ORDER.indexOf(step.role as (typeof ROLE_ORDER)[number]));
    const row = rowOf[step.role] ?? 0;
    rowOf[step.role] = row + 1;
    // Prefer sequential x for a spine feel; nudge by role column as secondary.
    const x = padX + i * 90 + col * (colGap - 40);
    const y = padY + row * rowGap + col * 12;
    return {
      id: step.key,
      type: "workflow",
      position: { x, y },
      data: {
        label: step.label,
        role: step.role,
        testId: step.testId,
        state: "idle" as StepState,
        iconKey: step.key,
      },
    };
  });
}

function stateFor(result: RunResult | undefined, running: boolean, isNext: boolean): StepState {
  if (result) {
    if (!result.ok && result.skipped) return "skipped";
    return result.ok ? "success" : "error";
  }
  if (running && isNext) return "running";
  return "idle";
}

function ConnectionsCanvas() {
  const [steps, setSteps] = useState<E2eStep[]>([]);
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [run, setRun] = useState<RunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [liveHealth, setLiveHealth] = useState<LiveHealth | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<WorkflowNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<WorkflowEdgeData>>([]);
  const defaultsRef = useRef<Node<WorkflowNodeData>[]>([]);
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const streamRef = useRef<EventSource | null>(null);
  const { fitView } = useReactFlow();

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health").then((r) => r.json());
      if (!res.error) setLiveHealth(res);
    } catch {
      // strip stays empty on failure
    }
  }, []);

  const applyGraph = useCallback(
    (nextSteps: E2eStep[], nextResults: Record<string, RunResult>, isLive: boolean) => {
      if (!defaultsRef.current.length) {
        defaultsRef.current = defaultLayout(nextSteps);
        for (const n of defaultsRef.current) positionsRef.current[n.id] = n.position;
      }

      let firstPending = -1;
      if (isLive) {
        firstPending = nextSteps.findIndex((s) => !nextResults[s.key]);
      }

      const nextNodes = defaultsRef.current.map((node, i) => {
        const step = nextSteps.find((s) => s.key === node.id) || nextSteps[i];
        if (!step) return node;
        const result = nextResults[step.key];
        const state = stateFor(result, isLive, i === firstPending);
        const position = positionsRef.current[step.key] || node.position;
        return {
          ...node,
          id: step.key,
          position,
          data: {
            label: step.label,
            role: step.role,
            testId: step.testId,
            state,
            iconKey: step.key,
          },
        };
      });

      const nextEdges: Edge<WorkflowEdgeData>[] = nextSteps.slice(0, -1).map((step, i) => {
        const result = nextResults[step.key];
        const state = stateFor(result, isLive, i === firstPending);
        return {
          id: `${step.key}->${nextSteps[i + 1].key}`,
          source: step.key,
          target: nextSteps[i + 1].key,
          type: "workflow",
          data: { state },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 16,
            height: 16,
            color:
              state === "success"
                ? "#10b981"
                : state === "error"
                  ? "#ef4444"
                  : state === "running"
                    ? "#ff6d5a"
                    : "#b0b2b8",
          },
        };
      });

      setNodes(nextNodes);
      setEdges(nextEdges);
    },
    [setEdges, setNodes]
  );

  const load = useCallback(async () => {
    try {
      const stepsRes = await fetch("/api/e2e").then((r) => r.json());
      const nextSteps: E2eStep[] = stepsRes.steps || [];
      setSteps(nextSteps);
      defaultsRef.current = defaultLayout(nextSteps);

      const runsRes = await fetch("/api/runs").then((r) => r.json());
      const latest =
        (runsRes.runs || []).find((r: RunSummary) => r.role === "end-to-end") || null;
      setRun(latest);

      let byKey: Record<string, RunResult> = {};
      if (latest) {
        const detail = await fetch(`/api/runs?id=${encodeURIComponent(latest.id)}`).then((r) =>
          r.json()
        );
        for (const result of detail.results || []) {
          byKey[result.stepKey || result.testId] = result;
        }
        if (detail.health) {
          setRun((prev) => (prev ? { ...prev, health: detail.health, baseUrl: detail.baseUrl } : prev));
        }
      }
      setResults(byKey);
      applyGraph(nextSteps, byKey, false);
      requestAnimationFrame(() => fitView({ padding: 0.2, duration: 200 }));
    } catch {
      setError("Could not load the journey. Is the dashboard server still running?");
    } finally {
      setLoading(false);
    }
  }, [applyGraph, fitView]);

  const followRun = useCallback(
    (runId: string) => {
      streamRef.current?.close();
      const es = new EventSource(`/api/run/stream/${runId}`);
      streamRef.current = es;
      setLive(true);
      es.onmessage = (msg) => {
        const event = JSON.parse(msg.data);
        if (event.type === "result") {
          setResults((prev) => ({
            ...prev,
            [event.result.stepKey || event.result.testId]: event.result,
          }));
        } else if (event.type === "done") {
          setLive(false);
          es.close();
          streamRef.current = null;
          load();
        }
      };
      es.onerror = () => {
        setLive(false);
        es.close();
        streamRef.current = null;
      };
    },
    [applyGraph, load]
  );

  useEffect(() => {
    let cancelled = false;
    let first = true;
    const tick = async () => {
      if (cancelled) return;
      if (first) {
        first = false;
        await Promise.all([load(), loadHealth()]);
        if (cancelled) return;
      }
      if (streamRef.current) return;
      try {
        const data = await fetch("/api/runs").then((r) => r.json());
        const active = (data.runs || []).find(
          (r: RunSummary) => r.role === "end-to-end" && r.status === "running"
        );
        if (active && !cancelled && !streamRef.current) {
          setRun(active);
          setResults({});
          followRun(active.id);
        }
      } catch {
        // retry next tick
      }
    };
    tick();
    const timer = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [followRun, load, loadHealth]);

  useEffect(() => {
    applyGraph(steps, results, live);
    // intentionally only when results/live/steps change — not applyGraph identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, results, live]);

  const onNodeClick: NodeMouseHandler = useCallback((_e, node) => {
    setSelectedKey(node.id);
  }, []);

  const onNodesChangeTracked = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
      for (const change of changes) {
        if (change.type === "position" && change.position && change.id) {
          positionsRef.current[change.id] = change.position;
        }
      }
    },
    [onNodesChange]
  );

  const resetLayout = useCallback(() => {
    defaultsRef.current = defaultLayout(steps);
    positionsRef.current = Object.fromEntries(
      defaultsRef.current.map((n) => [n.id, n.position])
    );
    applyGraph(steps, results, live);
    requestAnimationFrame(() => fitView({ padding: 0.2, duration: 200 }));
  }, [applyGraph, fitView, live, results, steps]);

  const selectedStep = steps.find((s) => s.key === selectedKey);
  const passed = steps.filter((s) => stateFor(results[s.key], false, false) === "success").length;
  const failed = steps.filter((s) => stateFor(results[s.key], false, false) === "error").length;
  const skipped = steps.filter((s) => stateFor(results[s.key], false, false) === "skipped").length;
  const skippedNote = skipped ? `, ${skipped} skipped (no token for that role)` : "";

  const runHealth = run?.health;
  const healthSource = liveHealth;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Event flow</CardTitle>
          <CardDescription>
            {run
              ? `End-to-end run ${run.id} — click a node to inspect I/O.`
              : "No end-to-end run recorded yet. Run one from the Run page to light up the pipeline."}
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {live && (
            <Badge variant="outline" className="gap-1.5 border-success/50 text-success">
              <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
              Live
            </Badge>
          )}
          <Button variant="ghost" size="sm" onClick={resetLayout}>
            <RotateCcw aria-hidden="true" />
            Reset layout
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              setError(null);
              load();
              loadHealth();
            }}
            disabled={loading || live}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <Activity className="size-3.5 text-muted-foreground" />
          <span className="font-medium">Host health</span>
          {healthSource ? (
            <span
              className={`inline-flex items-center gap-1 ${
                healthSource.reachable ? "text-success" : "text-destructive"
              }`}
            >
              {healthSource.reachable ? (
                <CircleCheck className="size-3.5" />
              ) : (
                <CircleX className="size-3.5" />
              )}
              {healthSource.reachable ? "Reachable" : "Down"}
              {` · ${healthSource.latencyMs}ms`}
              {healthSource.status != null ? ` · HTTP ${healthSource.status}` : ""}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Clock className="size-3.5 animate-pulse" /> Checking…
            </span>
          )}
          {runHealth && (
            <span className="text-muted-foreground">
              · Checked at run start: {runHealth.reachable ? "up" : "down"}
              {runHealth.latencyMs != null ? ` · ${runHealth.latencyMs}ms` : ""}
            </span>
          )}
          <Link href="/health" className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">
            History
            <ArrowRight className="size-3" />
          </Link>
        </div>

        <p role="status" aria-atomic="true" className="min-h-4 text-xs text-muted-foreground">
          {loading
            ? "Loading the pipeline…"
            : error
              ? ""
              : live
                ? `Run in progress — ${passed + failed} of ${steps.length} steps reported, ${passed} accepted, ${failed} failed${skippedNote}.`
                : run
                  ? `${passed} of ${steps.length} steps accepted, ${failed} failed${skippedNote}.`
                  : `${steps.length} steps defined, none run yet.`}
        </p>

        {error ? (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-6 text-sm text-destructive">
            <CircleX className="size-4 shrink-0" aria-hidden="true" />
            {error}
          </div>
        ) : (
          <div className="flex h-[560px] overflow-hidden rounded-xl border border-[#1e1e24]">
            <div className="n8n-canvas relative min-w-0 flex-1">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChangeTracked}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                fitView
                minZoom={0.25}
                maxZoom={1.5}
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{ type: "workflow" }}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={18}
                  size={1.2}
                  color="#3a3a44"
                  bgColor="#1e1e24"
                />
                <Controls
                  showInteractive={false}
                  className="!overflow-hidden !rounded-md !border !border-[#3d3d45] !bg-[#2d2d35] !shadow-lg [&>button]:!border-[#3d3d45] [&>button]:!bg-[#2d2d35] [&>button]:!text-[#f5f5f7] [&>button:hover]:!bg-[#3a3a44]"
                />
                <MiniMap
                  className="!overflow-hidden !rounded-md !border !border-[#3d3d45] !bg-[#2d2d35]"
                  maskColor="rgba(30,30,36,0.7)"
                  nodeColor={() => "#ff6d5a"}
                />
              </ReactFlow>
              {!run && !loading && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="pointer-events-auto rounded-lg border border-[#3d3d45] bg-[#2d2d35]/95 px-5 py-4 text-center text-sm text-[#f5f5f7] shadow-xl">
                    <p className="mb-2 text-[#a0a0ab]">Canvas is ready — no execution yet.</p>
                    <Link href="/" className="inline-flex items-center gap-1 text-[#ff6d5a] hover:underline">
                      Start an end-to-end run
                      <ArrowRight className="size-3.5" />
                    </Link>
                  </div>
                </div>
              )}
            </div>
            {selectedStep && (
              <StepInspector
                label={selectedStep.label}
                testId={selectedStep.testId}
                role={selectedStep.role}
                result={results[selectedStep.key]}
                onClose={() => setSelectedKey(null)}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Connections() {
  return (
    <ReactFlowProvider>
      <ConnectionsCanvas />
    </ReactFlowProvider>
  );
}

export default Connections;
