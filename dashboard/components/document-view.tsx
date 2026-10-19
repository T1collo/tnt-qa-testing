"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type DocEvent = {
  eventID: string | null;
  type: string | null;
  bizStep: string | null;
  parentID: string | null;
  epcList: string[];
  childEPCs: string[];
};

/** Hides a scroll container's bar while keeping it scrollable (wheel, touch, keyboard). */
export const NO_SCROLLBAR = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export function pretty(text: string | null | undefined) {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * An HTTP status as a pill: green when the platform accepted it (2xx), red when it refused
 * or failed (4xx/5xx), plain otherwise. Colour is paired with the number itself, never alone.
 */
export function StatusPill({ status, className }: { status: number | null | undefined; className?: string }) {
  if (status === null || status === undefined) return null;
  const ok = status >= 200 && status < 300;
  const bad = status >= 400;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-xs tabular-nums",
        ok && "bg-success/15 text-success",
        bad && "bg-destructive/15 text-destructive",
        !ok && !bad && "bg-muted text-muted-foreground",
        className
      )}
    >
      HTTP {status}
    </span>
  );
}

/**
 * Documented p95 targets per step (docs/TnT-Performance-QA-Checklist.md, TNT-PERF-006..011).
 * A step with no target of its own falls back to the 1 s used for ship/receive/dispense.
 */
const DEFAULT_BUDGET_MS = 1000;
const BUDGETS: { match: RegExp; ms: number; ref: string }[] = [
  { match: /commission/i, ms: 800, ref: "TNT-PERF-006" },
  { match: /pack-sscc|PACK-002/i, ms: 1500, ref: "TNT-PERF-008" },
  { match: /pack|PACK-001/i, ms: 1000, ref: "TNT-PERF-007" },
  { match: /ship/i, ms: 1000, ref: "TNT-PERF-009" },
  { match: /receive|recv/i, ms: 1000, ref: "TNT-PERF-010" },
  { match: /dispense|disp/i, ms: 1000, ref: "TNT-PERF-011" },
];

export function budgetFor(step: string | null | undefined) {
  const found = BUDGETS.find((b) => step && b.match.test(step));
  return found ?? { ms: DEFAULT_BUDGET_MS, ref: "TNT-PERF-010" };
}

/**
 * How long the request took, against that step's documented target: green within it, amber up
 * to twice it, red beyond. Browser and portal steps are not API calls, so they stay plain.
 */
export function DurationPill({
  ms,
  step,
  budgetMs,
  untimed = false,
}: {
  ms: number | null | undefined;
  step?: string | null;
  /** Overrides the per-step target, e.g. one request that carried several steps. */
  budgetMs?: number;
  /** True for steps with no latency target (portal UI, browser tests). */
  untimed?: boolean;
}) {
  if (ms === null || ms === undefined) return null;
  const fallback = budgetFor(step);
  const budget = budgetMs ?? fallback.ms;
  const ref = budgetMs ? "combined target" : fallback.ref;
  const state = untimed ? "plain" : ms <= budget ? "good" : ms <= budget * 2 ? "slow" : "bad";
  return (
    <span
      title={untimed ? "Not an API request" : `Target p95 < ${budget.toLocaleString()} ms (${ref})`}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-xs tabular-nums",
        state === "good" && "bg-success/15 text-success",
        state === "slow" && "bg-warning/15 text-warning",
        state === "bad" && "bg-destructive/15 text-destructive",
        state === "plain" && "bg-muted text-muted-foreground"
      )}
    >
      {ms.toLocaleString()} ms
    </span>
  );
}

const ROLE_TONE: Record<string, string> = {
  manufacturer: "bg-chart-1/12 text-chart-1",
  distributor: "bg-chart-2/15 text-chart-2",
  facility: "bg-chart-3/15 text-chart-3",
  browser: "bg-muted text-muted-foreground",
};

/** The partner role a step belongs to. One hue per role, always with the name beside it. */
export function RoleChip({ role, className }: { role: string | null | undefined; className?: string }) {
  if (!role) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs capitalize",
        ROLE_TONE[role] ?? "bg-muted text-muted-foreground",
        className
      )}
    >
      {role}
    </span>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1500);
  }
  return (
    <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
      {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
    </Button>
  );
}

/** Full height, wrapped, no inner scrollbar: the dialog scrolls as one. */
export function CodeBlock({ label, text, copyable = false }: { label: string; text: string; copyable?: boolean }) {
  if (!text) return null;
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
        {copyable && <CopyButton text={text} label={label} />}
      </div>
      <pre className="rounded-2xl bg-muted p-4 font-mono text-xs whitespace-pre-wrap break-all">{text}</pre>
    </div>
  );
}

const EPC_PREVIEW = 12;
const shortStep = (bizStep: string | null) => bizStep?.split(":").pop() ?? null;

/**
 * A labelled list of identifiers: the first few shown, the rest behind "Show all", and a Copy
 * button that always copies the complete list, one per line.
 */
export function IdList({ label, ids }: { label: string; ids: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? ids : ids.slice(0, EPC_PREVIEW);
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">
          {label} <span className="tabular-nums">({ids.length.toLocaleString()})</span>
        </h4>
        <CopyButton text={ids.join("\n")} label={label} />
      </div>
      <ul className="rounded-2xl border px-4 py-2 font-mono text-xs break-all">
        {shown.map((id, i) => (
          <li key={`${id}-${i}`} className="py-0.5">
            {id}
          </li>
        ))}
      </ul>
      {ids.length > EPC_PREVIEW && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show fewer" : `Show all ${ids.length.toLocaleString()}`}
        </Button>
      )}
    </div>
  );
}

/**
 * Event IDs and EPCs the request carried, event by event, plus the IDs the platform returned
 * when they are not simply the ones that were sent.
 */
export function EventSummary({
  events,
  returnedIds = [],
  fallbackEventId = null,
  missingNote = "The request document was not recorded for this result, so its EPC list is unavailable.",
}: {
  events: DocEvent[];
  returnedIds?: string[];
  fallbackEventId?: string | null;
  missingNote?: string;
}) {
  const sentIds = events.map((e) => e.eventID).filter((id): id is string => Boolean(id));
  const sameAsSent = returnedIds.length === sentIds.length && returnedIds.every((id, i) => id === sentIds[i]);
  const eventIds = sentIds.length ? sentIds : returnedIds.length ? returnedIds : fallbackEventId ? [fallbackEventId] : [];
  const epcEvents = events.filter((e) => e.epcList.length || e.childEPCs.length || e.parentID);

  return (
    <div className="space-y-3">
      {eventIds.length > 0 ? (
        <IdList label={sentIds.length ? "Event IDs" : "Event IDs (returned)"} ids={eventIds} />
      ) : (
        <p className="text-xs text-muted-foreground">No event ID recorded for this result.</p>
      )}
      {sentIds.length > 0 && returnedIds.length > 0 && !sameAsSent && (
        <IdList label="Event IDs returned by the platform" ids={returnedIds} />
      )}

      {epcEvents.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {events.length ? "The request carried no EPCs." : missingNote}
        </p>
      ) : (
        epcEvents.map((e, i) => {
          const heading = epcEvents.length > 1 ? `Event ${i + 1}: ${e.type ?? ""} ${shortStep(e.bizStep) ?? ""} — ` : "";
          return (
            <div key={`${e.eventID}-${i}`} className="space-y-2">
              {e.parentID && (
                <p className="font-mono text-xs break-all">
                  <span className="font-sans text-muted-foreground">{heading}Parent: </span>
                  {e.parentID}
                </p>
              )}
              {e.epcList.length > 0 && <IdList label={`${heading}EPC list`} ids={e.epcList} />}
              {e.childEPCs.length > 0 && <IdList label={`${heading}Child EPCs`} ids={e.childEPCs} />}
            </div>
          );
        })
      )}
    </div>
  );
}
