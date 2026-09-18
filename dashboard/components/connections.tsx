"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  CircleCheck,
  CircleX,
  Factory,
  Package,
  PackageCheck,
  PackageOpen,
  Pill,
  RefreshCw,
  RotateCcw,
  Trash2,
  Truck,
  Undo2,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type E2eStep = { key: string; index: number; role: string; label: string; testId: string; phase: string; sync: boolean };
type RunSummary = { id: string; role: string; status: string; finishedAt: string | null; passed: number; total: number };
type RunResult = {
  testId: string;
  stepKey?: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  variants: { status: number | null; responseBody?: string; url?: string }[];
};
type StepState = "pass" | "fail" | "pending" | "skipped";
type Point = { x: number; y: number };

const ROLE_ORDER = ["manufacturer", "distributor", "facility"] as const;

const NODE_W = 268;
const NODE_H = 76;
const COL_GAP = 88;
const ROW_GAP = 30;
const PAD = 28;
const HEADER_H = 30;
const BOW = 58;
const NUDGE = 12; // keyboard step, in board units

const STEP_ICONS: Record<string, LucideIcon> = {
  "mfg-commission": Factory,
  "mfg-pack": Package,
  "mfg-pack-sscc": Boxes,
  "mfg-ship": Truck,
  "dist-receive": PackageCheck,
  "dist-unpack": PackageOpen,
  "dist-pack": Package,
  "dist-ship": Truck,
  "fac-receive": PackageCheck,
  "fac-unpack": PackageOpen,
  "fac-dispense": Pill,
  "fac-return-ship": Undo2,
  "dist-return-recv": PackageCheck,
  "dist-return-ship": Undo2,
  "mfg-return-recv": PackageCheck,
  "mfg-destroy": Trash2,
};

const STATE_STROKE: Record<StepState, string> = {
  pass: "var(--success)",
  fail: "var(--destructive)",
  pending: "var(--border)",
  skipped: "var(--border)",
};

function defaultPosition(step: E2eStep, steps: E2eStep[]): Point {
  const col = Math.max(0, ROLE_ORDER.indexOf(step.role as (typeof ROLE_ORDER)[number]));
  const row = steps.filter((s) => s.role === step.role).findIndex((s) => s.key === step.key);
  return { x: PAD + col * (NODE_W + COL_GAP), y: PAD + HEADER_H + row * (NODE_H + ROW_GAP) };
}

// Ports sit on whichever vertical edge the flow actually uses, so every connector is a
// horizontal-tangent bezier - that is what keeps the curves smooth rather than kinked. Once
// nodes are draggable the direction has to come from live positions, not column indexes.
function ports(from: Point, to: Point) {
  const sameLane = Math.abs(to.x - from.x) < NODE_W * 0.6;
  const right = (p: Point) => ({ x: p.x + NODE_W, y: p.y + NODE_H / 2 });
  const left = (p: Point) => ({ x: p.x, y: p.y + NODE_H / 2 });
  if (sameLane) return { out: right(from), into: right(to), kind: "bow" as const };
  if (to.x > from.x) return { out: right(from), into: left(to), kind: "forward" as const };
  return { out: left(from), into: right(to), kind: "back" as const };
}

function connectorPath(from: Point, to: Point) {
  const { out, into, kind } = ports(from, to);
  if (kind === "bow") {
    return `M${out.x},${out.y} C${out.x + BOW},${out.y} ${into.x + BOW},${into.y} ${into.x},${into.y}`;
  }
  const dir = kind === "forward" ? 1 : -1;
  const reach = Math.max(90, Math.abs(into.x - out.x) * 0.55);
  return `M${out.x},${out.y} C${out.x + dir * reach},${out.y} ${into.x - dir * reach},${into.y} ${into.x},${into.y}`;
}

// What actually went wrong, pulled out of the stored response for the hover/focus card.
function failureDetail(result: RunResult | undefined) {
  if (!result) return null;
  const variant = result.variants?.[0];
  const status = variant?.status ?? null;
  let code = "";
  let message = result.error || "";
  let warnings: string[] = [];
  try {
    const body = JSON.parse(variant?.responseBody || "");
    code = body.code || body.category || "";
    message = body.message || body.resolution || message;
    warnings = (body.warnings || []).map((w: { code: string }) => w.code);
  } catch {
    // Non-JSON body (a gateway error page, say) - the raw text is the best detail we have.
    if (!message && variant?.responseBody) message = variant.responseBody.slice(0, 160);
  }
  return { status, code, message, warnings, url: variant?.url };
}

export function Connections() {
  const [steps, setSteps] = useState<E2eStep[]>([]);
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [run, setRun] = useState<RunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [moved, setMoved] = useState<Record<string, Point>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  const streamRef = useRef<EventSource | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ key: string; from: Point; pointer: Point } | null>(null);

  const load = useCallback(async () => {
    try {
      const stepsRes = await fetch("/api/e2e").then((r) => r.json());
      setSteps(stepsRes.steps || []);

      const runsRes = await fetch("/api/runs").then((r) => r.json());
      const latest = (runsRes.runs || []).find((r: RunSummary) => r.role === "end-to-end") || null;
      setRun(latest);

      if (latest) {
        const detail = await fetch(`/api/runs?id=${encodeURIComponent(latest.id)}`).then((r) => r.json());
        const byKey: Record<string, RunResult> = {};
        for (const result of detail.results || []) byKey[result.stepKey || result.testId] = result;
        setResults(byKey);
      } else {
        setResults({});
      }
    } catch {
      setError("Could not load the journey. Is the dashboard server still running?");
    } finally {
      setLoading(false);
    }
  }, []);

  const followRun = useCallback(
    (runId: string) => {
      streamRef.current?.close();
      const es = new EventSource(`/api/run/stream/${runId}`);
      streamRef.current = es;
      setLive(true);
      es.onmessage = (msg) => {
        const event = JSON.parse(msg.data);
        if (event.type === "result") {
          setResults((prev) => ({ ...prev, [event.result.stepKey || event.result.testId]: event.result }));
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
    [load]
  );

  useEffect(() => {
    let cancelled = false;
    let first = true;
    const tick = async () => {
      if (cancelled) return;
      if (first) {
        first = false;
        await load();
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
        // A failed poll is not worth surfacing - the next tick retries.
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
  }, [followRun, load]);

  const board = useMemo(() => {
    const perColumn = ROLE_ORDER.map((role) => steps.filter((s) => s.role === role).length);
    const rows = Math.max(1, ...perColumn);
    return {
      width: PAD * 2 + ROLE_ORDER.length * (NODE_W + COL_GAP) - COL_GAP + BOW,
      height: PAD * 2 + HEADER_H + rows * (NODE_H + ROW_GAP) - ROW_GAP,
    };
  }, [steps]);

  // Scale the whole board to the available width instead of letting it scroll. One transform
  // on the wrapper keeps the SVG and the node layer in exact agreement - scaling them
  // separately would drift - and costs nothing at paint time.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const fit = () => {
      const available = shell.clientWidth;
      if (available > 0) setScale(Math.min(1, available / board.width));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [board.width]);

  const positionOf = useCallback(
    (step: E2eStep) => moved[step.key] ?? defaultPosition(step, steps),
    [moved, steps]
  );

  const stateFor = useCallback(
    (step: E2eStep): StepState => {
      const result = results[step.key];
      if (!result) return "pending";
      if (!result.ok && result.skipped) return "skipped";
      return result.ok ? "pass" : "fail";
    },
    [results]
  );

  // --- dragging -----------------------------------------------------------------------
  function onPointerDown(event: React.PointerEvent, step: E2eStep) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      key: step.key,
      from: positionOf(step),
      pointer: { x: event.clientX, y: event.clientY },
    };
    setDragging(step.key);
  }

  function onPointerMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    // Pointer travel is in screen pixels; the board is scaled, so convert before applying.
    const dx = (event.clientX - drag.pointer.x) / scale;
    const dy = (event.clientY - drag.pointer.y) / scale;
    setMoved((prev) => ({
      ...prev,
      [drag.key]: {
        x: Math.max(0, Math.min(board.width - NODE_W, drag.from.x + dx)),
        y: Math.max(0, Math.min(board.height - NODE_H, drag.from.y + dy)),
      },
    }));
  }

  function endDrag(event: React.PointerEvent) {
    if (!dragRef.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(null);
  }

  // WCAG 2.2 "Dragging Movements": every drag needs a keyboard path. Arrow keys nudge a
  // focused node, and Reset layout puts everything back without a pointer.
  function onKeyDown(event: React.KeyboardEvent, step: E2eStep) {
    const delta: Record<string, Point> = {
      ArrowLeft: { x: -NUDGE, y: 0 },
      ArrowRight: { x: NUDGE, y: 0 },
      ArrowUp: { x: 0, y: -NUDGE },
      ArrowDown: { x: 0, y: NUDGE },
    };
    const move = delta[event.key];
    if (!move) return;
    event.preventDefault();
    const current = positionOf(step);
    setMoved((prev) => ({
      ...prev,
      [step.key]: {
        x: Math.max(0, Math.min(board.width - NODE_W, current.x + move.x)),
        y: Math.max(0, Math.min(board.height - NODE_H, current.y + move.y)),
      },
    }));
  }

  const passed = steps.filter((s) => stateFor(s) === "pass").length;
  const failed = steps.filter((s) => stateFor(s) === "fail").length;
  const skipped = steps.filter((s) => stateFor(s) === "skipped").length;
  const skippedNote = skipped ? `, ${skipped} skipped (no token for that role)` : "";

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Event flow</CardTitle>
          <CardDescription>
            {run
              ? `End-to-end run ${run.id} — one consignment, commissioned through to destroyed. Hover a step for its response.`
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
          {Object.keys(moved).length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setMoved({})}>
              <RotateCcw aria-hidden="true" />
              Reset layout
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              setError(null);
              load();
            }}
            disabled={loading || live}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
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
          <div
            ref={shellRef}
            className="w-full overflow-hidden rounded-xl border bg-muted/20"
            style={{ height: board.height * scale }}
          >
            <div
              className="relative origin-top-left"
              style={{
                width: board.width,
                height: board.height,
                transform: `scale(${scale})`,
                backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
                backgroundSize: "22px 22px",
              }}
              role="group"
              aria-label={
                run
                  ? `Pipeline of ${steps.length} steps. ${passed} accepted, ${failed} failed. Nodes can be moved with the arrow keys.`
                  : `Pipeline of ${steps.length} steps, not yet run.`
              }
            >
              {ROLE_ORDER.map((role, col) => (
                <div
                  key={role}
                  className="pointer-events-none absolute text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  style={{ left: PAD + col * (NODE_W + COL_GAP), top: PAD, width: NODE_W }}
                >
                  {role}
                </div>
              ))}

              <svg
                className="pointer-events-none absolute inset-0 overflow-visible"
                width={board.width}
                height={board.height}
                aria-hidden="true"
              >
                <defs>
                  {(["pass", "fail", "pending", "skipped"] as StepState[]).map((state) => (
                    <marker
                      key={state}
                      id={`arrow-${state}`}
                      viewBox="0 0 8 8"
                      refX="6"
                      refY="4"
                      markerWidth="5"
                      markerHeight="5"
                      orient="auto-start-reverse"
                    >
                      <path d="M0,1 L7,4 L0,7 Z" fill={STATE_STROKE[state]} />
                    </marker>
                  ))}
                </defs>

                {steps.slice(0, -1).map((step, i) => {
                  const state = stateFor(step);
                  const d = connectorPath(positionOf(step), positionOf(steps[i + 1]));
                  return (
                    <g key={`${step.key}-edge`}>
                      <path d={d} fill="none" stroke={STATE_STROKE[state]} strokeWidth={2} opacity={0.18} />
                      <path
                        d={d}
                        fill="none"
                        stroke={STATE_STROKE[state]}
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeDasharray="8 6"
                        markerEnd={`url(#arrow-${state})`}
                        className={state === "pending" || state === "skipped" ? undefined : "animate-flow"}
                      />
                    </g>
                  );
                })}
              </svg>

              {steps.map((step) => {
                const pos = positionOf(step);
                const state = stateFor(step);
                const detail = failureDetail(results[step.key]);
                const Icon = STEP_ICONS[step.key] ?? Package;
                const isDragging = dragging === step.key;
                return (
                  <Tooltip key={step.key}>
                    <TooltipTrigger asChild>
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`Step ${step.index}, ${step.label}, ${step.role}. ${
                          state === "pending"
                            ? "Not run"
                            : state === "skipped"
                              ? "Skipped"
                              : state === "pass"
                                ? "Accepted"
                                : "Failed"
                        }. Arrow keys move this step.`}
                        onPointerDown={(e) => onPointerDown(e, step)}
                        onPointerMove={onPointerMove}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        onKeyDown={(e) => onKeyDown(e, step)}
                        className={[
                          "absolute flex touch-none flex-col justify-center rounded-xl border bg-card px-3 py-2 text-left shadow-sm",
                          "transition-[box-shadow,border-color] duration-(--duration-quick) ease-(--ease-emphasis)",
                          "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                          isDragging ? "cursor-grabbing shadow-lg" : "cursor-grab hover:shadow-md",
                          state === "pass" ? "border-success/70" : "",
                          state === "fail" ? "border-destructive/70" : "",
                        ].join(" ")}
                        style={{
                          // Positioned by transform so a drag never triggers layout.
                          transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
                          width: NODE_W,
                          height: NODE_H,
                          zIndex: isDragging ? 20 : 10,
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={[
                              "flex size-7 shrink-0 items-center justify-center rounded-lg border",
                              state === "pass" ? "border-success/40 bg-success/10 text-success" : "",
                              state === "fail" ? "border-destructive/40 bg-destructive/10 text-destructive" : "",
                              state === "pending" || state === "skipped" ? "bg-muted text-muted-foreground" : "",
                            ].join(" ")}
                            aria-hidden="true"
                          >
                            <Icon className="size-4" />
                          </span>
                          <span className="font-mono text-xs text-muted-foreground tabular-nums">
                            {step.index}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={step.label}>
                            {step.label}
                          </span>
                          {step.phase !== "forward" && (
                            <span className="shrink-0 text-muted-foreground">
                              {step.phase === "terminal" ? (
                                <Trash2 className="size-3.5" aria-hidden="true" />
                              ) : (
                                <Undo2 className="size-3.5" aria-hidden="true" />
                              )}
                              <span className="sr-only">
                                {step.phase === "terminal" ? "terminal step" : "return leg"}
                              </span>
                            </span>
                          )}
                          {step.sync && (
                            <Badge variant="outline" className="h-4 shrink-0 px-1 text-[0.7rem]">
                              sync
                            </Badge>
                          )}
                          {state === "skipped" && (
                            <Badge variant="outline" className="h-4 shrink-0 px-1 text-[0.7rem] text-muted-foreground">
                              skipped
                            </Badge>
                          )}
                          {(state === "pass" || state === "fail") && (
                            <span
                              className={[
                                "flex shrink-0 items-center gap-1 text-xs tabular-nums",
                                state === "pass" ? "text-success" : "text-destructive",
                              ].join(" ")}
                            >
                              {state === "pass" ? (
                                <CircleCheck className="size-3" aria-hidden="true" />
                              ) : (
                                <CircleX className="size-3" aria-hidden="true" />
                              )}
                              {detail?.status ?? "err"}
                            </span>
                          )}
                        </div>

                        {/* Output port, on the edge the connector actually leaves by. */}
                        <span
                          className="absolute top-1/2 -right-1 size-2 -translate-y-1/2 rounded-full border bg-background"
                          style={{ borderColor: STATE_STROKE[state] }}
                          aria-hidden="true"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-80">
                      <p className="font-medium">
                        {step.index}. {step.label}
                      </p>
                      <p className="text-muted-foreground capitalize">
                        {step.role} · {step.testId}
                      </p>
                      {state === "skipped" ? (
                        <p className="mt-1">Not sent — {results[step.key]?.error}.</p>
                      ) : state === "pending" ? (
                        <p className="mt-1">Not run yet.</p>
                      ) : (
                        <>
                          <p className="mt-1">
                            HTTP {detail?.status ?? "—"}
                            {detail?.code ? ` · ${detail.code}` : ""}
                          </p>
                          {detail?.message && (
                            <p className="mt-1 text-muted-foreground">{detail.message}</p>
                          )}
                          {!!detail?.warnings.length && (
                            <p className="mt-1 text-muted-foreground">
                              Warnings: {detail.warnings.join(", ")}
                            </p>
                          )}
                        </>
                      )}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          {(
            [
              { state: "pass" as const, label: "Accepted — data moved on" },
              { state: "fail" as const, label: "Broken handoff" },
              { state: "pending" as const, label: "Not run" },
            ]
          ).map((item) => (
            <span key={item.state} className="flex items-center gap-1.5">
              <svg width="28" height="8" aria-hidden="true">
                <line
                  x1="0"
                  y1="4"
                  x2="28"
                  y2="4"
                  stroke={STATE_STROKE[item.state]}
                  strokeWidth="2"
                  strokeDasharray="8 6"
                  strokeLinecap="round"
                />
              </svg>
              {item.label}
            </span>
          ))}
          <span className="ml-auto">Drag a step to rearrange, or focus one and use the arrow keys.</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default Connections;
