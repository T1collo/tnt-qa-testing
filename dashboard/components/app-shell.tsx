"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  PlayCircle,
  ScrollText,
  ShieldCheck,
  Map as MapIcon,
  KeyRound,
  MoreHorizontal,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const NAV = [
  { href: "/", label: "Run", icon: PlayCircle },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/audit", label: "Audit", icon: ShieldCheck },
  { href: "/test-map", label: "Test Map", icon: MapIcon },
];

function pageTitle(pathname: string) {
  const match = NAV.find((item) => item.href === pathname);
  return match?.label ?? "TnT QA";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <div className="flex items-center gap-2 px-2 py-1.5">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground text-sm font-semibold">
                TT
              </div>
              <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate text-sm font-semibold">TnT QA</span>
                <span className="truncate text-xs text-sidebar-foreground/60">
                  Partner API suite
                </span>
              </div>
            </div>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Suite</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV.map((item) => {
                    const active = pathname === item.href;
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={active}
                          tooltip={item.label}
                          // The base variant paints the selected row with the same token as
                          // hover, so "current page" and "pointer is here" looked identical.
                          // An inset shadow draws the edge marker without a border reflowing
                          // the label by 2px.
                          className="transition-[background-color,color,box-shadow] duration-(--duration-enter) ease-(--ease-emphasis) data-active:bg-selected/10 data-active:text-selected data-active:shadow-[inset_2px_0_0_0_var(--selected)]"
                        >
                          <Link href={item.href}>
                            <item.icon />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter>
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
              <KeyRound className="size-3.5 shrink-0" />
              <span>Tokens are never saved — kept in this tab until it is reloaded or closed.</span>
            </div>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset className="min-w-0">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <h1 className="text-sm font-medium">{pageTitle(pathname)}</h1>

            <div className="ml-auto flex items-center gap-1">
              <ThemeToggle />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-2 rounded-md p-1 hover:bg-accent">
                    <Avatar className="size-7">
                      <AvatarFallback className="text-xs">QA</AvatarFallback>
                    </Avatar>
                    <MoreHorizontal className="size-4 text-muted-foreground" />
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

          {/* SidebarInset already renders the <main> landmark; a second one nested inside it
              leaves screen readers with two "main" regions. */}
          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            <div className="mx-auto max-w-6xl">{children}</div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

export default AppShell;
