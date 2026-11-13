import { cn } from "@/lib/utils";

export type DotColumn = {
  key: string;
  /** Shown on hover; the figure's caption carries the same facts for screen readers. */
  title: string;
  /** Cells lit from the bottom, in the primary tone. */
  filled: number;
  /** Of the lit cells, how many (from the bottom) use the alert tone. */
  alert?: number;
  /** "stack": every lit cell solid. "peak": the top cell solid with a fading tail below it. */
  mode?: "stack" | "peak";
};

/**
 * A grid of dots, one column per period (day, run). Columns light up from the bottom, so the
 * height carries the value; colour only separates "fine" from "needs a look", and the caption
 * states the result in words so nothing depends on colour alone.
 */
export function DotMatrix({
  columns,
  rows,
  caption,
  className,
}: {
  columns: DotColumn[];
  rows: number;
  caption: string;
  className?: string;
}) {
  return (
    <figure className={cn("min-w-0", className)}>
      <div
        aria-hidden="true"
        className="grid h-36 gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
      >
        {columns.map((col) => (
          <div key={col.key} title={col.title} className="flex flex-col-reverse gap-[3px]" data-dot-column>
            {Array.from({ length: rows }, (_, i) => {
              const lit = i < col.filled;
              const alert = lit && i < (col.alert ?? 0);
              const tail = col.mode === "peak" && lit && i < col.filled - 1;
              return (
                <span
                  key={i}
                  className={cn(
                    "min-h-0 flex-1 rounded-[3px]",
                    !lit && "bg-border/60",
                    lit && (alert ? "bg-highlight" : "bg-chart-1"),
                    tail && "opacity-35"
                  )}
                />
              );
            })}
          </div>
        ))}
      </div>
      <figcaption className="sr-only">{caption}</figcaption>
    </figure>
  );
}
