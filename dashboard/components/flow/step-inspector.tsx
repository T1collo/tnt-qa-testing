"use client";

import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type RunResult = {
  testId: string;
  stepKey?: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  variants: { status: number | null; responseBody?: string; url?: string }[];
};

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
    if (!message && variant?.responseBody) message = variant.responseBody.slice(0, 160);
  }
  return { status, code, message, warnings, url: variant?.url };
}

export function StepInspector({
  label,
  testId,
  role,
  result,
  onClose,
}: {
  label: string;
  testId: string;
  role: string;
  result?: RunResult;
  onClose: () => void;
}) {
  const detail = failureDetail(result);
  const outcome = result
    ? result.skipped
      ? "skipped"
      : result.ok
        ? "success"
        : "error"
    : "pending";

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-l border-[#3d3d45] bg-[#2d2d35] text-[#f5f5f7]">
      <div className="flex items-start justify-between gap-2 border-b border-[#3d3d45] px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{label}</div>
          <div className="truncate text-[11px] text-[#a0a0ab]">
            {role} · {testId}
          </div>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-[#a0a0ab] hover:bg-white/10 hover:text-white"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="space-y-3 overflow-auto p-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-[#a0a0ab]">Status</span>
          <Badge
            variant={
              outcome === "success" ? "default" : outcome === "error" ? "destructive" : "secondary"
            }
          >
            {outcome}
          </Badge>
        </div>
        {detail?.status != null && (
          <div>
            <div className="text-[#a0a0ab]">HTTP</div>
            <div className="font-mono">{detail.status}</div>
          </div>
        )}
        {detail?.code && (
          <div>
            <div className="text-[#a0a0ab]">Code</div>
            <div className="font-mono">{detail.code}</div>
          </div>
        )}
        {detail?.message && (
          <div>
            <div className="text-[#a0a0ab]">Message</div>
            <div className="whitespace-pre-wrap break-words">{detail.message}</div>
          </div>
        )}
        {detail?.url && (
          <div>
            <div className="text-[#a0a0ab]">URL</div>
            <div className="break-all font-mono text-[10px] text-[#c8c8d0]">{detail.url}</div>
          </div>
        )}
        {detail?.warnings?.length ? (
          <div>
            <div className="text-[#a0a0ab]">Warnings</div>
            <ul className="list-inside list-disc font-mono">
              {detail.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {!result && (
          <p className="text-[#a0a0ab]">
            No result for this step yet. Run the end-to-end journey to populate I/O.
          </p>
        )}
      </div>
    </aside>
  );
}
