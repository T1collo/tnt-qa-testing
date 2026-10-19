"use client";

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Boxes,
  CircleCheck,
  CircleX,
  Factory,
  Loader2,
  Minus,
  Package,
  PackageCheck,
  PackageOpen,
  Pill,
  Trash2,
  Truck,
  Undo2,
  type LucideIcon,
} from "lucide-react";

export type StepState = "idle" | "running" | "success" | "error" | "skipped";

export type WorkflowNodeData = {
  label: string;
  role: string;
  testId: string;
  state: StepState;
  iconKey: string;
};

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

const ROLE_COLOR: Record<string, string> = {
  manufacturer: "#ea4b71",
  distributor: "#ff6d5a",
  facility: "#1f77b4",
};

function StatusBadge({ state }: { state: StepState }) {
  if (state === "idle") return null;
  if (state === "running") {
    return (
      <span className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-[#ff6d5a] text-white shadow">
        <Loader2 className="size-3 animate-spin" />
      </span>
    );
  }
  if (state === "success") {
    return (
      <span className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-[#10b981] text-white shadow">
        <CircleCheck className="size-3" />
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-[#ef4444] text-white shadow">
        <CircleX className="size-3" />
      </span>
    );
  }
  return (
    <span className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-[#9ca3af] text-white shadow">
      <Minus className="size-3" />
    </span>
  );
}

function WorkflowNodeComponent({ data, selected }: NodeProps<Node<WorkflowNodeData>>) {
  const Icon = STEP_ICONS[data.iconKey] || Package;
  const accent = ROLE_COLOR[data.role] || "#7e8186";
  const ring =
    data.state === "running"
      ? "ring-2 ring-[#ff6d5a]/70 shadow-[0_0_0_4px_rgba(255,109,90,0.15)]"
      : data.state === "error"
        ? "ring-1 ring-[#ef4444]/50"
        : data.state === "success"
          ? "ring-1 ring-[#10b981]/40"
          : selected
            ? "ring-2 ring-[#ff6d5a]/50"
            : "";

  return (
    <div
      className={`relative flex w-[220px] items-stretch overflow-visible rounded-[6px] border border-[#d1d5db] bg-white shadow-[0_2px_6px_rgba(68,28,23,0.08)] transition-shadow hover:shadow-[0_4px_12px_rgba(68,28,23,0.12)] ${ring}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2.5 !border-2 !border-white !bg-[#7e8186]"
      />
      <div
        className="flex w-10 shrink-0 items-center justify-center rounded-l-[5px] text-white"
        style={{ background: accent }}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1 px-2.5 py-2">
        <div className="truncate text-[13px] font-medium leading-tight text-[#333]">
          {data.label}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-[#7e8186]">
          {data.role} · {data.testId}
        </div>
      </div>
      <StatusBadge state={data.state} />
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2.5 !border-2 !border-white !bg-[#7e8186]"
      />
    </div>
  );
}

export const WorkflowNode = memo(WorkflowNodeComponent);
