"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  Activity,
  LayoutDashboard,
  Map as MapIcon,
  MoreHorizontal,
  Network,
  PanelLeft,
  PlayCircle,
  ScanBarcode,
  ScrollText,
  ShieldCheck,
} from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

gsap.registerPlugin(useGSAP);

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/", label: "Run", icon: PlayCircle },
  { href: "/map", label: "System Map", icon: Network },
  { href: "/health", label: "Health", icon: Activity },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/audit", label: "Audit", icon: ShieldCheck },
  { href: "/test-map", label: "Test Map", icon: MapIcon },
];

// Pages that manage their own full-height canvas instead of a padded, scrolling column.
const FULL_BLEED = new Set(["/map"]);

const ROW =
  "flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none";

type Host = { baseUrl?: string; reachable?: boolean };

function EnvironmentChip() {
  const [host, setHost] = useState<Host | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((h: Host) => {
        if (!cancelled) setHost(h);
      })
      .catch(() => {
        if (!cancelled) setHost({ reachable: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const state = host === null ? "Checking…" : host.reachable ? "Connected" : "Unreachable";
  return (
    <div className="ml-2 hidden min-w-0 items-center gap-3 text-sm md:flex" aria-live="polite">
      {host?.baseUrl && (
        <span className="max-w-48 truncate rounded-md bg-primary/10 px-2 py-1 font-mono text-xs text-primary" title={host.baseUrl}>
          {host.baseUrl.replace(/^https?:\/\//, "")}
        </span>
      )}
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 rounded-full",
            host === null ? "bg-muted-foreground" : host.reachable ? "bg-success" : "bg-destructive"
          )}
        />
        {state}
      </span>
    </div>
  );
}

/** The whole app frame: the side navigation, the top bar, and the page beside them. */
export function SideNav({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const current = NAV.find((item) => item.href === pathname);

  // One quiet rise per page change. The Dashboard runs its own reveal once its data lands.
  useGSAP(
    () => {
      if (pathname === "/dashboard") return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from("[data-panel]", { opacity: 0, y: 8, duration: 0.3, ease: "power2.out", stagger: 0.03 });
      });
      return () => mm.revert();
    },
    { scope: contentRef, dependencies: [pathname] }
  );

  return (
    <TooltipProvider>
      <div className="flex h-dvh">
        <aside className={cn("flex h-dvh shrink-0 flex-col border-r bg-sidebar p-2 text-sidebar-foreground", open ? "w-52" : "w-15")}>
          <Link href="/dashboard" title="TnT QA" className={cn(ROW, "mb-1 px-1.5")}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <ScanBarcode className="size-4" aria-hidden="true" />
            </span>
            {open ? <span className="truncate font-semibold">TnT QA</span> : <span className="sr-only">TnT QA</span>}
          </Link>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Collapse navigation" : "Expand navigation"}
            title={open ? "Collapse navigation" : "Expand navigation"}
            className={cn(ROW, "mb-1 cursor-pointer hover:bg-sidebar-accent hover:text-sidebar-accent-foreground")}
          >
            <PanelLeft className="size-4 shrink-0" aria-hidden="true" />
            {open && <span className="truncate">Collapse</span>}
          </button>

          <nav aria-label="Main" className="flex flex-1 flex-col gap-1 overflow-y-auto">
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={open ? undefined : item.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    ROW,
                    active ? "bg-primary text-primary-foreground" : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )}
                >
                  <item.icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className={open ? "truncate" : "sr-only"}>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
            <h1 className="truncate text-sm font-semibold">{current?.label ?? "TnT QA"}</h1>
            <EnvironmentChip />
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <ThemeToggle />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label="QA suite menu"
                    className="flex cursor-pointer items-center gap-2 rounded-md p-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <Avatar className="size-7">
                      <AvatarFallback className="text-xs">QA</AvatarFallback>
                    </Avatar>
                    <MoreHorizontal className="size-4 text-muted-foreground" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>QA suite</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href="/test-map">View test ID map</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/logs">Failure logs</Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          {FULL_BLEED.has(pathname) ? (
            <div className="relative min-h-0 flex-1">{children}</div>
          ) : (
            <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
              <div className="mx-auto max-w-7xl">{children}</div>
            </div>
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}
