import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A dashboard panel: a flat card whose title bar names the measure, with the content below.
 */
export function Panel({
  title,
  icon: Icon,
  action,
  className,
  bodyClassName,
  children,
}: {
  title: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** Optional control at the right of the caption (a link or menu). */
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-panel
      aria-label={title}
      className={cn("flex min-w-0 flex-col rounded-lg border bg-card shadow-xs", className)}
    >
      <header className="flex min-h-11 items-center gap-2 border-b px-4">
        <Icon className="size-4 shrink-0 text-primary" aria-hidden />
        <h2 className="truncate text-sm font-semibold text-primary">
          {title}
        </h2>
        {action && <div className="ml-auto flex shrink-0 items-center">{action}</div>}
      </header>
      <div className={cn("flex min-w-0 flex-1 flex-col rounded-b-lg p-4", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

/** The headline of a panel: a caption, a large figure, and an optional note at the right. */
export function PanelFigure({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="border-b pb-3">
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        {/* A div, not a p: the value can be a loading skeleton, which is itself a div. */}
        <div className="font-mono text-3xl font-medium tracking-tight tabular-nums">{value}</div>
        {note && <div className="pb-1 font-mono text-xs text-muted-foreground">{note}</div>}
      </div>
    </div>
  );
}

/** Small "vs" delta: an arrow and a value in the accent colour, followed by its context. */
export function Delta({ value, context }: { value: number | null; context: string }) {
  if (value === null || !Number.isFinite(value)) return <span>{context}</span>;
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return (
    <span>
      <span className={value < 0 ? "text-highlight" : "text-selected"}>
        {sign}
        {Math.abs(value).toFixed(1)} pts
      </span>{" "}
      {context}
    </span>
  );
}
