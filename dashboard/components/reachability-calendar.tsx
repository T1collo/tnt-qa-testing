import { cn } from "@/lib/utils";

const WEEKS = 16;
const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

type ProbedRun = { startedAt: string; health?: { reachable?: boolean } | null };

type Day = { key: string; date: Date; up: number; down: number; future: boolean };

// Like GitHub's activity graph, a deeper shade means more activity that day. Here the hue says
// what that activity found: green reachable, yellow mixed, red unreachable.
function toneOf({ up, down }: Day) {
  const total = up + down;
  if (total === 0) return "bg-muted";
  if (up === 0) return "bg-flow-fail";
  if (down > 0) return "bg-flow-warn";
  if (total >= 10) return "bg-flow-ok";
  if (total >= 4) return "bg-flow-ok/75";
  if (total >= 2) return "bg-flow-ok/50";
  return "bg-flow-ok/30";
}

function titleOf(day: Day) {
  const date = day.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const total = day.up + day.down;
  if (total === 0) return `${date}: no probes`;
  return `${date}: ${day.up} of ${total} probe${total === 1 ? "" : "s"} reachable`;
}

function buildDays(runs: ProbedRun[], now: number) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  // Start on the Sunday that makes today fall in the last column.
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - (WEEKS - 1) * 7);

  const days: Day[] = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    days.push({ key: date.toDateString(), date, up: 0, down: 0, future: date > today });
  }
  const byKey = new Map(days.map((d) => [d.key, d]));
  for (const run of runs) {
    if (typeof run.health?.reachable !== "boolean") continue;
    const day = byKey.get(new Date(run.startedAt).toDateString());
    if (!day) continue;
    if (run.health.reachable) day.up += 1;
    else day.down += 1;
  }
  return days;
}

/** A GitHub-style activity calendar of environment reachability: one square per day. */
export function ReachabilityCalendar({ runs, now }: { runs: ProbedRun[]; now: number }) {
  const days = buildDays(runs, now);
  const months = Array.from({ length: WEEKS }, (_, week) => {
    const first = days[week * 7].date;
    const previous = week > 0 ? days[(week - 1) * 7].date : null;
    return !previous || previous.getMonth() !== first.getMonth()
      ? first.toLocaleDateString(undefined, { month: "short" })
      : "";
  });
  const probed = days.filter((d) => d.up + d.down > 0);
  const outages = probed.filter((d) => d.down > 0).length;

  return (
    <figure className="min-w-0">
      <div aria-hidden="true" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
        <span />
        <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}>
          {months.map((month, i) => (
            <span key={i} className="h-4 overflow-visible text-xs whitespace-nowrap text-muted-foreground">
              {month}
            </span>
          ))}
        </div>
        <div className="grid grid-rows-7 gap-[3px]">
          {DAY_LABELS.map((label, i) => (
            <span key={i} className="flex items-center text-xs leading-none text-muted-foreground">
              {label}
            </span>
          ))}
        </div>
        <div
          className="grid grid-flow-col grid-rows-7 gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}
        >
          {days.map((day) =>
            day.future ? (
              <span key={day.key} className="aspect-square" />
            ) : (
              <span key={day.key} title={titleOf(day)} className={cn("aspect-square rounded-[3px]", toneOf(day))} />
            )
          )}
        </div>
      </div>
      <figcaption className="sr-only">
        Reachability over the last {WEEKS} weeks: the environment was probed on {probed.length} days, with
        unreachable probes on {outages} of them.
      </figcaption>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Last {WEEKS} weeks</span>
        <span className="flex items-center gap-1" aria-hidden="true">
          Fewer probes
          {["bg-muted", "bg-flow-ok/30", "bg-flow-ok/50", "bg-flow-ok/75", "bg-flow-ok"].map((tone) => (
            <span key={tone} className={cn("size-2.5 rounded-[2px]", tone)} />
          ))}
          More
        </span>
        <span className="flex items-center gap-3" aria-hidden="true">
          <span className="flex items-center gap-1">
            <span className="size-2.5 rounded-[2px] bg-flow-warn" /> Some down
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2.5 rounded-[2px] bg-flow-fail" /> All down
          </span>
        </span>
      </div>
    </figure>
  );
}
