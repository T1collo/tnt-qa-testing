import Link from "next/link";
import { ArrowRight, Network } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type RingRun = {
  baseUrl?: string | null;
  health?: { reachable?: boolean } | null;
  total: number;
  passed: number;
  failed: number;
  skipped?: number;
};

const RADIUS = 34;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function Ring({ value, centre, label, note }: { value: number | null; centre: string; label: string; note: string }) {
  const tone = value === null ? "text-muted" : value >= 95 ? "text-success" : value >= 80 ? "text-warning" : "text-destructive";
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <svg viewBox="0 0 84 84" className="size-21" role="img" aria-label={`${label}: ${centre}. ${note}`}>
        <circle cx="42" cy="42" r={RADIUS} fill="none" strokeWidth="7" className="stroke-muted" />
        {value !== null && (
          <circle
            cx="42"
            cy="42"
            r={RADIUS}
            fill="none"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${(Math.max(0, Math.min(100, value)) / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            transform="rotate(-90 42 42)"
            className={cn("stroke-current", tone)}
          />
        )}
        <text x="42" y="47" textAnchor="middle" className="fill-foreground text-base font-semibold">
          {centre}
        </text>
      </svg>
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

/** Headline health for the window: the numbers to read first, before any panel below. */
export function HealthRings({ runs }: { runs: RingRun[] | null }) {
  if (!runs) {
    return (
      <div className="rounded-lg border bg-card p-5" aria-busy="true" aria-label="Loading health summary">
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const tried = runs.reduce((n, r) => n + Math.max(0, r.total - (r.skipped ?? 0)), 0);
  const passed = runs.reduce((n, r) => n + r.passed, 0);
  const failed = runs.reduce((n, r) => n + r.failed, 0);
  const clean = runs.filter((r) => r.failed === 0 && r.total > 0).length;
  const probed = runs.filter((r) => r.health);
  const up = probed.filter((r) => r.health?.reachable).length;
  const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);

  const passRate = pct(passed, tried);
  const cleanRate = pct(clean, runs.length);
  const upRate = pct(up, probed.length);
  const hosts = [...new Set(runs.map((r) => r.baseUrl).filter(Boolean))].length;
  const show = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

  return (
    <section aria-label="Health summary" className="grid gap-6 rounded-lg border bg-card p-5 lg:grid-cols-[1fr_2fr_1fr] lg:items-center">
      <div>
        <h2 className="text-base font-semibold">Last 30 days</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {runs.length.toLocaleString()} runs across {hosts} environment{hosts === 1 ? "" : "s"}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Ring value={passRate} centre={show(passRate)} label="Tests passed" note={`${failed.toLocaleString()} failed`} />
        <Ring value={cleanRate} centre={show(cleanRate)} label="Clean runs" note={`${clean} of ${runs.length}`} />
        <Ring value={upRate} centre={show(upRate)} label="Host reachable" note={`${up} of ${probed.length} probes`} />
      </div>
      <Link
        href="/map"
        className="flex items-center gap-3 rounded-md border p-3 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Network className="size-5 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">System map</span>
          <span className="block text-xs text-muted-foreground">See which partner events are failing</span>
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </section>
  );
}
