"use client";

import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";

export type WorkflowEdgeData = {
  state: "idle" | "running" | "success" | "error" | "skipped";
};

const STROKE: Record<string, string> = {
  idle: "#b0b2b8",
  running: "#ff6d5a",
  success: "#10b981",
  error: "#ef4444",
  skipped: "#9ca3af",
};

export function WorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps<Edge<WorkflowEdgeData>>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const state = data?.state || "idle";
  const stroke = STROKE[state] || STROKE.idle;
  const animated = state === "running";

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth: animated ? 2.5 : 2,
          strokeDasharray: animated ? "6 4" : undefined,
          animation: animated ? "flow-dash 0.9s linear infinite" : undefined,
          opacity: state === "idle" ? 0.75 : 1,
        }}
      />
    </>
  );
}
