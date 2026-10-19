"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleCheck,
  FileJson,
  CircleX,
  FileSpreadsheet,
  Loader2,
  MonitorPlay,
  RefreshCw,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { RunStepDialog } from "@/components/run-step-dialog";
import {
  RunModeDialog,
  SCOPES,
  type DocumentMode,
  type Product,
} from "@/components/run-mode-dialog";
import { KNOWN_ENVIRONMENTS, normalizeBaseUrl } from "@/lib/baseUrl";
import { cn } from "@/lib/utils";
import {
  beginRun,
  clearRun,
  hasFormField,
  reconnect,
  runFailedToStart,
  runStarted,
  stopRun,
  useFormField,
  useRunState,
} from "@/lib/run-session";

type TestMapEntry = { testId: string; role: string; eventType: string; path: string[] };
type HostCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; message: string }
  | { state: "fail"; message: string };

type E2eStep = { key: string; index: number; role: string; label: string; testId: string; phase: string; sync: boolean };
type Spec = { file: string; tests: number };
type Mode = "role" | "e2e" | "ui";
const E2E_ROLES = ["manufacturer", "distributor", "facility"] as const;
type E2eRole = (typeof E2E_ROLES)[number];

const ROLES = [
  { value: "manufacturer", label: "Manufacturer" },
  { value: "distributor", label: "Distributor" },
  { value: "facility", label: "Facility" },
];

const MODES: { value: Mode; label: string; detail: string }[] = [
  ...SCOPES,
  {
    value: "ui",
    label: "Browser UI suite",
    detail: "Playwright drives the portal in Chromium. Logins come from .env on this machine.",
  },
];

const ROLE_SHORT: Record<string, string> = { manufacturer: "Mfg", distributor: "Dist", facility: "Fac" };
// One hue per role, matching the chips used in the Audit table and step dialogs.
const ROLE_TONE: Record<string, string> = {
  manufacturer: "text-chart-1",
  distributor: "text-chart-2",
  facility: "text-chart-3",
};

const specLabel = (file: string) => file.replace(/\.spec\.[jt]s$/, "");

export function Run() {
  const [testMap, setTestMap] = useState<TestMapEntry[]>([]);
  const [e2eSteps, setE2eSteps] = useState<E2eStep[]>([]);
  const [specs, setSpecs] = useState<Spec[] | null>(null);
  const [specsError, setSpecsError] = useState<string | null>(null);
  // Read during render, before the form fields below store their first value: tells a
  // return visit (keep what was chosen) apart from a first visit (load the defaults).
  const [restored] = useState(() => ({
    baseUrl: hasFormField("baseUrl"),
    productIds: hasFormField("productIds"),
    specFiles: hasFormField("specFiles"),
  }));
  // Form fields survive page switches (in memory only - see lib/run-session).
  const [role, setRole] = useFormField("role", "manufacturer");
  const [apiToken, setApiToken] = useFormField("apiToken", "");
  const [mode, setMode] = useFormField<Mode>("mode", "role");
  const [documentMode, setDocumentMode] = useFormField<DocumentMode>("documentMode", "split");
  const [configOpen, setConfigOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [productIds, setProductIds] = useFormField<string[]>("productIds", []);
  const [serialCount, setSerialCount] = useFormField("serialCount", 2);
  const [maxSerialCount, setMaxSerialCount] = useState(50000);
  // On by default: fixed identifiers are a 409 duplicate on every run after the first.
  const [freshData, setFreshData] = useFormField("freshData", true);
  // Off by default: a run commissions with its own minted lot, as it did before the portal
  // batch step existed. Tick the box in the run dialog to create batches in the portal first.
  const [portalBatches, setPortalBatches] = useFormField("portalBatches", false);
  const [portalHeaded, setPortalHeaded] = useFormField("portalHeaded", false);
  const [e2eTokens, setE2eTokens] = useFormField<Record<E2eRole, string>>("e2eTokens", {
    manufacturer: "",
    distributor: "",
    facility: "",
  });
  const [specFiles, setSpecFiles] = useFormField<string[]>("specFiles", []);
  const [headed, setHeaded] = useFormField("headed", true);
  const [baseUrl, setBaseUrl] = useFormField("baseUrl", "");
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [hostCheck, setHostCheck] = useState<HostCheck>({ state: "idle" });
  const [selectedEventTypes, setSelectedEventTypes] = useFormField<string[]>("selectedEventTypes", []);
  // Set when the page was opened to re-run an earlier run (?rerun=<id>): the form is filled
  // from that run and starting sends rerunOf, so results replace that run's instead of
  // creating a new one.
  const [rerun, setRerun] = useState<{ id: string; attempt: number } | null>(null);
  // "Everything" in a past run is resolved once the event list / spec list has loaded.
  const pendingSelectAll = useRef<"events" | "specs" | null>(null);
  // Which step's document is open in the dialog.
  const [openStep, setOpenStep] = useState<string | null>(null);
  // The run lives outside this component so it keeps streaming while another page is open;
  // only a new run or the Clear button resets it.
  const { kind, running, runId, runBaseUrl, results, runStatus, runError, testSheet, total, logs } =
    useRunState();
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    fetch("/api/e2e")
      .then((r) => r.json())
      .then((d) => {
        setE2eSteps(d.steps || []);
        setProducts(d.products || []);
        if (d.maxSerialCount) setMaxSerialCount(d.maxSerialCount);
        // Default to the GTIN the collection already used, when it is in the catalogue.
        if (restored.productIds) return;
        const fallback = (d.products || []).find((p: Product) => p.gtin === "6161102974997");
        const first = fallback?.gtin || (d.products || [])[0]?.gtin;
        setProductIds(first ? [first] : []);
      })
      .catch(() => setE2eSteps([]));
  }, [restored, setProductIds]);

  useEffect(() => {
    fetch("/api/test-map")
      .then((r) => r.json())
      .then((d) => setTestMap(d.map || []))
      .catch(() => setTestMap([]));
  }, []);

  useEffect(() => {
    fetch("/api/playwright")
      .then((r) => r.json())
      .then((d) => {
        setSpecs(d.specs || []);
        if (d.error) setSpecsError(d.error);
        if (!restored.specFiles) setSpecFiles((d.specs || []).map((s: Spec) => s.file));
      })
      .catch(() => {
        setSpecs([]);
        setSpecsError("Could not load the Playwright suite.");
      });
  }, [restored, setSpecFiles]);

  // Prefill from the server's resolved default (.env) so the field shows the environment a
  // run would actually hit, instead of starting blank and leaving that choice invisible.
  // Coming back to the page keeps the URL that was typed and re-checks that one instead.
  useEffect(() => {
    const kept = restored.baseUrl ? normalizeBaseUrl(baseUrl) : null;
    const query = kept?.ok ? `?baseUrl=${encodeURIComponent(kept.value)}` : "";
    fetch(`/api/health${query}`)
      .then((r) => r.json())
      .then((d) => {
        if (!query && d.baseUrl) setBaseUrl(d.baseUrl);
        setHostCheck(
          d.reachable
            ? { state: "ok", message: `Reachable — HTTP ${d.status} in ${d.latencyMs}ms` }
            : { state: "fail", message: `Not reachable — ${d.error || "host did not respond"}` }
        );
      })
      .catch(() => {});
    // Mount-only: later URL edits are checked with the Check button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the newest runner output in view as it arrives.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const eventTypesForRole = useMemo(() => {
    return [...new Set(testMap.filter((m) => m.role === role).map((m) => m.eventType))];
  }, [testMap, role]);

  // Clear the checklist whenever the role changes - the event types differ per role, so
  // carrying a selection across would silently keep names that no longer apply. Adjusted
  // directly during render (React's documented pattern for resetting state on a prop
  // change) rather than in an effect, so it lands in the same render pass.
  const [roleForSelection, setRoleForSelection] = useState(role);
  if (role !== roleForSelection) {
    setRoleForSelection(role);
    setSelectedEventTypes([]);
  }

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("rerun");
    if (!id) return;
    window.history.replaceState(null, "", window.location.pathname);
    fetch(`/api/runs/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((run) => {
        if (!run) return;
        if (run.baseUrl) setBaseUrl(run.baseUrl);
        const productRefs = (run.consignment?.products || []).map((p: { productId?: string }) => p.productId).filter(Boolean);
        if (run.role === "end-to-end") {
          setMode("e2e");
          if (run.documentMode) setDocumentMode(run.documentMode);
          if (productRefs.length) setProductIds(productRefs);
          if (run.consignment?.serialsPerProduct) setSerialCount(run.consignment.serialsPerProduct);
          setPortalBatches(Boolean(run.consignment?.portalBatches));
        } else if (run.role === "ui") {
          setMode("ui");
          setHeaded(run.documentMode === "headed");
          const specList = run.consignment?.specs;
          if (Array.isArray(specList)) setSpecFiles(specList);
          else pendingSelectAll.current = "specs";
        } else {
          setMode("role");
          setRole(run.role);
          // Set together with the role so the role-change reset does not clear it.
          setRoleForSelection(run.role);
          setFreshData(run.documentMode === "fresh-data");
          if (productRefs.length) setProductIds(productRefs);
          if (Array.isArray(run.eventTypes)) setSelectedEventTypes(run.eventTypes);
          else pendingSelectAll.current = "events";
        }
        setRerun({ id: run.id, attempt: (run.attempt || 1) + 1 });
      })
      .catch(() => {});
    // Runs once on arrival; the setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pendingSelectAll.current === "events" && eventTypesForRole.length > 0) {
      pendingSelectAll.current = null;
      setSelectedEventTypes(eventTypesForRole);
    }
    if (pendingSelectAll.current === "specs" && specs?.length) {
      pendingSelectAll.current = null;
      setSpecFiles(specs.map((sp) => sp.file));
    }
  }, [eventTypesForRole, specs, setSelectedEventTypes, setSpecFiles]);

  const checkedSet = new Set(selectedEventTypes);
  const allSelected =
    eventTypesForRole.length > 0 && checkedSet.size === eventTypesForRole.length;

  function toggleEventType(type: string) {
    setSelectedEventTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  }

  function toggleSpec(file: string) {
    setSpecFiles((prev) => (prev.includes(file) ? prev.filter((f) => f !== file) : [...prev, file]));
  }

  const suppliedE2eTokens = E2E_ROLES.filter((r) => e2eTokens[r].length > 0);
  const usePortalBatches = portalBatches && documentMode !== "oversize";
  // The portal batch runs before the API journey, so it is shown as step 0 when enabled.
  const journeySteps: E2eStep[] = usePortalBatches && e2eSteps.length
    ? [
        { key: "portal-batch", index: 0, role: "manufacturer", label: "Create batch (portal UI)", testId: "MFG-BATCH-001", phase: "setup", sync: false },
        ...e2eSteps,
      ]
    : e2eSteps;
  const selectedTests = (specs || [])
    .filter((s) => specFiles.includes(s.file))
    .reduce((n, s) => n + s.tests, 0);
  const currentMode = MODES.find((m) => m.value === mode) ?? MODES[0];

  // Validated on blur rather than per keystroke, so a half-typed URL is never flagged wrong.
  function validateBaseUrl() {
    const result = normalizeBaseUrl(baseUrl);
    setBaseUrlError(result.ok ? null : result.error);
    return result;
  }

  async function checkHost() {
    const result = validateBaseUrl();
    if (!result.ok) {
      baseUrlRef.current?.focus();
      return;
    }
    setHostCheck({ state: "checking" });
    try {
      const res = await fetch(`/api/health?baseUrl=${encodeURIComponent(result.value)}`);
      const data = await res.json();
      setHostCheck(
        data.reachable
          ? { state: "ok", message: `Reachable — HTTP ${data.status} in ${data.latencyMs}ms` }
          : {
              state: "fail",
              // Node reports a DNS/connection failure as the bare string "fetch failed",
              // which tells an operator nothing - lead with the verdict, keep the cause.
              message: `Not reachable — ${data.error || "host did not respond"}`,
            }
      );
    } catch {
      setHostCheck({ state: "fail", message: "Not reachable — the check request failed" });
    }
  }

  // API runs open the confirmation dialog (events cannot be withdrawn); the browser suite
  // starts straight away.
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "ui") void startUiRun();
    else setConfigOpen(true);
  }

  async function post(url: string, body: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { runId?: string; error?: string; total?: number };
    return { res, data };
  }

  async function startUiRun() {
    const normalized = validateBaseUrl();
    if (!normalized.ok) {
      baseUrlRef.current?.focus();
      return;
    }
    setStarting(true);
    beginRun(normalized.value, "ui");
    try {
      const { res, data } = await post("/api/playwright", {
        files: specFiles,
        headed,
        baseUrl: normalized.value,
        rerunOf: rerun?.id,
      });
      if (!res.ok || !data.runId) runFailedToStart(data.error || "Failed to start the browser suite");
      else {
        setRerun(null);
        runStarted(data.runId, data.total ?? null);
      }
    } catch {
      runFailedToStart("Could not reach the dashboard server to start the run");
    } finally {
      setStarting(false);
    }
  }

  async function startRun() {
    const normalized = validateBaseUrl();
    if (!normalized.ok) {
      setStarting(false);
      setConfigOpen(false);
      baseUrlRef.current?.focus();
      return;
    }
    setStarting(true);
    beginRun(normalized.value);

    const eventTypes = checkedSet.size === eventTypesForRole.length ? null : [...checkedSet];

    let outcome;
    try {
      outcome =
        mode === "e2e"
          ? await post("/api/e2e", {
              tokens: e2eTokens,
              baseUrl: normalized.value,
              documentMode,
              serialCount,
              products: productIds,
              portalBatches,
              portalHeaded,
              rerunOf: rerun?.id,
            })
          : await post("/api/run", {
              role,
              apiToken,
              eventTypes,
              baseUrl: normalized.value,
              freshData,
              products: freshData ? productIds : undefined,
              rerunOf: rerun?.id,
            });
    } catch {
      setStarting(false);
      runFailedToStart("Could not reach the dashboard server to start the run");
      return;
    }
    setStarting(false);
    const { res, data } = outcome;
    if (!res.ok || !data.runId) {
      runFailedToStart(data.error || "Failed to start run");
      return;
    }
    setConfigOpen(false);
    setRerun(null);
    // Tokens stay in the form so the same run can be repeated; they are held in memory only.
    runStarted(data.runId, mode === "e2e" ? journeySteps.length : checkedSet.size);
  }

  const resultList = Object.values(results);
  const passed = resultList.filter((r) => r.ok).length;
  const skippedCount = resultList.filter((r) => !r.ok && r.skipped).length;
  const failedCount = resultList.length - passed - skippedCount;

  const submitDisabled =
    running ||
    starting ||
    !baseUrl ||
    (mode === "ui" && (specFiles.length === 0 || hostCheck.state !== "ok"));
  const formHint =
    hostCheck.state === "checking"
      ? "Checking the environment…"
      : hostCheck.state !== "ok"
        ? "Environment must be reachable before a run can start."
        : mode === "ui" && specFiles.length === 0
          ? "Pick at least one spec file."
          : null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Pick the environment and what to run, add the tokens it needs, and run it against the
        live platform.
      </p>

      <Card>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-5">
            {rerun && (
              <div
                role="status"
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-selected/40 bg-selected/5 px-3 py-2 text-sm"
              >
                <RotateCcw className="size-4 shrink-0 text-selected" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  Re-running <span className="font-mono text-xs">{rerun.id}</span> (attempt {rerun.attempt}) with
                  its original settings. Its results will be replaced; the previous attempt stays in the
                  run record. Re-enter the API token{mode === "e2e" ? "s" : ""} if needed — they are never saved.
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setRerun(null)}>
                  Run as new instead
                </Button>
              </div>
            )}
            <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="base-url">Environment base URL</Label>
                <div className="flex gap-2">
                  <Input
                    id="base-url"
                    ref={baseUrlRef}
                    type="url"
                    inputMode="url"
                    spellCheck={false}
                    autoComplete="off"
                    list="known-environments"
                    value={baseUrl}
                    aria-invalid={baseUrlError ? true : undefined}
                    aria-describedby="base-url-message"
                    onChange={(e) => {
                      setBaseUrl(e.target.value);
                      if (baseUrlError) setBaseUrlError(null);
                      if (hostCheck.state !== "idle") setHostCheck({ state: "idle" });
                    }}
                    onBlur={validateBaseUrl}
                    placeholder="https://tnt-demo.apeiro-digital.com"
                    className="font-mono"
                  />
                  <datalist id="known-environments">
                    {KNOWN_ENVIRONMENTS.map((env) => (
                      <option key={env.url} value={env.url}>
                        {env.label}
                      </option>
                    ))}
                  </datalist>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={checkHost}
                    disabled={hostCheck.state === "checking"}
                  >
                    {hostCheck.state === "checking" && <Loader2 className="animate-spin" />}
                    Check
                  </Button>
                </div>
                {/* Fixed-height slot: helper text, validation error and check result all share
                    it, so the form never reflows as the message changes. */}
                <p
                  id="base-url-message"
                  role={baseUrlError ? "alert" : "status"}
                  aria-atomic="true"
                  className="flex min-h-4 items-center gap-1 text-xs"
                >
                  {baseUrlError ? (
                    <span className="text-destructive">{baseUrlError}</span>
                  ) : hostCheck.state === "ok" ? (
                    <>
                      <CircleCheck className="size-3 shrink-0 text-success" aria-hidden="true" />
                      <span className="text-success">{hostCheck.message}</span>
                    </>
                  ) : hostCheck.state === "fail" ? (
                    <>
                      <CircleX className="size-3 shrink-0 text-destructive" aria-hidden="true" />
                      <span className="text-destructive">{hostCheck.message}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      API keys are scoped to one environment — a key issued elsewhere fails as an
                      invalid token.
                    </span>
                  )}
                </p>
              </div>

              {/* Scope sits on the form so choosing it reveals the right fields at once,
                  instead of opening the run dialog just to switch and then cancelling. */}
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="run-scope">What to run</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as Mode)} disabled={running}>
                  <SelectTrigger id="run-scope" className="w-full" aria-describedby="run-scope-help">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODES.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p id="run-scope-help" className="min-h-4 text-xs text-muted-foreground">
                  {currentMode.detail}
                </p>
              </div>
            </div>

            {mode === "e2e" && (
              <>
                <div className="space-y-1.5">
                  <Label id="e2e-tokens-label">Partner API tokens</Label>
                  <div
                    role="group"
                    aria-labelledby="e2e-tokens-label"
                    className="grid gap-4 sm:grid-cols-3"
                  >
                    {E2E_ROLES.map((r) => (
                      <div key={r} className="min-w-0 space-y-1">
                        <Label htmlFor={`token-${r}`} className="text-xs font-normal capitalize">
                          {r}
                        </Label>
                        <Input
                          id={`token-${r}`}
                          type="password"
                          autoComplete="off"
                          value={e2eTokens[r]}
                          onChange={(e) =>
                            setE2eTokens((prev) => ({ ...prev, [r]: e.target.value }))
                          }
                          placeholder="X-API-Key value"
                        />
                      </div>
                    ))}
                  </div>
                  <p className="min-h-4 text-xs text-muted-foreground">
                    {suppliedE2eTokens.length === 0
                      ? "Add at least one token. Steps for a role with no token are reported as skipped, so a partial journey still runs."
                      : `${suppliedE2eTokens.length} of 3 supplied — never saved, kept only until this tab is reloaded or closed.`}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label id="journey-label">Journey steps</Label>
                  {/* Compact grid rather than a tall list, so the form fits without scrolling. */}
                  <ol
                    aria-labelledby="journey-label"
                    className="grid gap-x-4 gap-y-1 rounded-lg border px-3 py-2 text-xs sm:grid-cols-2 xl:grid-cols-4"
                  >
                    {journeySteps.map((step) => {
                      const result = results[step.key];
                      const state = !result
                        ? null
                        : result.ok
                          ? "pass"
                          : result.skipped
                            ? "skipped"
                            : "fail";
                      return (
                        <li key={step.key} className="flex min-w-0 items-center gap-2 py-0.5">
                          <span className="w-4 shrink-0 text-right font-mono text-muted-foreground tabular-nums">
                            {step.index}
                          </span>
                          <span className="min-w-0 truncate" title={`${step.role} — ${step.label}`}>
                            <span className={ROLE_TONE[step.role] ?? "text-muted-foreground"}>
                              {ROLE_SHORT[step.role] ?? step.role}
                            </span>{" "}
                            {step.label}
                            {step.phase !== "forward" && (
                              <span className="text-muted-foreground"> · {step.phase}</span>
                            )}
                          </span>
                          {state === "pass" && (
                            <CircleCheck className="ml-auto size-3.5 shrink-0 text-success" aria-label="passed" />
                          )}
                          {state === "fail" && (
                            <CircleX className="ml-auto size-3.5 shrink-0 text-destructive" aria-label="failed" />
                          )}
                          {state === "skipped" && (
                            <span className="ml-auto shrink-0 text-muted-foreground">skipped</span>
                          )}
                        </li>
                      );
                    })}
                    {e2eSteps.length === 0 && (
                      <li className="italic text-muted-foreground">Loading journey…</li>
                    )}
                  </ol>
                </div>
              </>
            )}

            {mode === "role" && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="min-w-0 space-y-1.5">
                    <Label htmlFor="role">Role</Label>
                    <Select value={role} onValueChange={setRole}>
                      <SelectTrigger id="role" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="min-w-0 space-y-1.5">
                    <Label htmlFor="token">
                      {role.charAt(0).toUpperCase() + role.slice(1)} API token
                    </Label>
                    <Input
                      id="token"
                      type="password"
                      autoComplete="off"
                      value={apiToken}
                      onChange={(e) => setApiToken(e.target.value)}
                      placeholder="X-API-Key value"
                      aria-describedby="token-message"
                    />
                    <p id="token-message" className="min-h-4 text-xs text-muted-foreground">
                      Never saved — kept only until this tab is reloaded or closed.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label id="event-types-label">Event types to run</Label>
                    <div className="flex items-center gap-1">
                      <span className="mr-1 text-xs text-muted-foreground tabular-nums">
                        {checkedSet.size} of {eventTypesForRole.length} selected
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedEventTypes(eventTypesForRole)}
                        disabled={allSelected}
                      >
                        Select all
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedEventTypes([])}
                        disabled={checkedSet.size === 0}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                  <div
                    role="group"
                    aria-labelledby="event-types-label"
                    className="flex flex-wrap gap-2"
                  >
                    {eventTypesForRole.map((type) => {
                      const checked = checkedSet.has(type);
                      return (
                        <Toggle
                          key={type}
                          size="sm"
                          variant="outline"
                          pressed={checked}
                          onPressedChange={() => toggleEventType(type)}
                          // The base variant marks "on" with bg-muted, the same token as hover,
                          // so a chosen chip was indistinguishable from the one under the cursor.
                          className="data-[state=on]:border-selected/70 data-[state=on]:bg-selected/10 data-[state=on]:text-selected"
                        >
                          {/* Always rendered, faded when unselected: selection is then carried
                              by a mark as well as by colour, and the chip keeps one width. */}
                          <Check
                            className={checked ? "opacity-100" : "opacity-0"}
                            aria-hidden="true"
                          />
                          {type}
                        </Toggle>
                      );
                    })}
                  </div>
                  <p className="min-h-4 text-xs text-muted-foreground">
                    {checkedSet.size === 0 && eventTypesForRole.length > 0
                      ? "Pick at least one event type to enable the run."
                      : null}
                  </p>
                </div>
              </>
            )}

            {mode === "ui" && (
              <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label id="specs-label">Spec files</Label>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {selectedTests} test{selectedTests === 1 ? "" : "s"} selected
                    </span>
                  </div>
                  <div role="group" aria-labelledby="specs-label" className="flex flex-wrap gap-2">
                    {specs === null && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                        Loading the suite…
                      </span>
                    )}
                    {(specs || []).map((spec) => {
                      const checked = specFiles.includes(spec.file);
                      return (
                        <Toggle
                          key={spec.file}
                          size="sm"
                          variant="outline"
                          pressed={checked}
                          onPressedChange={() => toggleSpec(spec.file)}
                          className="data-[state=on]:border-selected/70 data-[state=on]:bg-selected/10 data-[state=on]:text-selected"
                        >
                          <Check className={checked ? "opacity-100" : "opacity-0"} aria-hidden="true" />
                          {specLabel(spec.file)}
                          <span className="text-muted-foreground tabular-nums">{spec.tests}</span>
                        </Toggle>
                      );
                    })}
                  </div>
                  <p className="min-h-4 text-xs text-muted-foreground">
                    {specsError ? (
                      <span className="text-destructive">{specsError}</span>
                    ) : (
                      "The lifecycle spec creates real batches and shipments on the portal. The HTML report is written to playwright-report/."
                    )}
                  </p>
                </div>
                <div className="flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2">
                  <Checkbox
                    id="pw-headed"
                    checked={headed}
                    onCheckedChange={(v) => setHeaded(v === true)}
                    aria-describedby="pw-headed-help"
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <Label htmlFor="pw-headed" className="text-sm font-medium">
                      Show the browser window
                    </Label>
                    <p id="pw-headed-help" className="mt-0.5 text-xs text-muted-foreground">
                      Opens Chromium on the machine running the dashboard so you can watch each
                      step. Off runs headless.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={submitDisabled}>
                {running || starting ? (
                  <Loader2 className="animate-spin" />
                ) : mode === "ui" ? (
                  <MonitorPlay />
                ) : (
                  <Settings2 />
                )}
                {running ? "Running…" : mode === "ui" ? "Run browser tests" : "Run…"}
              </Button>
              {runError && !running && <p className="text-sm text-destructive">{runError}</p>}
              {!runError && formHint && <p className="text-sm text-muted-foreground">{formHint}</p>}
            </div>
          </form>
        </CardContent>
      </Card>

      <RunModeDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        scope={mode === "e2e" ? "e2e" : "role"}
        documentMode={documentMode}
        onDocumentModeChange={setDocumentMode}
        journeySteps={e2eSteps.length}
        roleRequests={checkedSet.size * 2}
        baseUrl={baseUrl}
        products={products}
        productIds={productIds}
        onProductsChange={setProductIds}
        serialCount={serialCount}
        onSerialCountChange={setSerialCount}
        maxSerialCount={maxSerialCount}
        freshData={freshData}
        onFreshDataChange={setFreshData}
        portalBatches={portalBatches}
        onPortalBatchesChange={setPortalBatches}
        portalHeaded={portalHeaded}
        onPortalHeadedChange={setPortalHeaded}
        starting={starting}
        canStart={
          hostCheck.state === "ok" &&
          (mode === "e2e"
            ? documentMode === "oversize" ||
              (suppliedE2eTokens.length > 0 && (!usePortalBatches || Boolean(e2eTokens.manufacturer)))
            : Boolean(apiToken) && checkedSet.size > 0)
        }
        blockedReason={
          runError && !running
            ? runError
            : mode === "e2e" && usePortalBatches && !e2eTokens.manufacturer
              ? "Portal batches are commissioned by the manufacturer — add the manufacturer token."
            : hostCheck.state !== "ok"
              ? "The environment must be reachable before a run can start."
              : mode === "e2e" && documentMode !== "oversize" && suppliedE2eTokens.length === 0
                ? "Add at least one partner token on the form."
                : mode === "role" && !apiToken
                  ? "Add the role's API token on the form."
                  : mode === "role" && checkedSet.size === 0
                    ? "Pick at least one event type."
                    : null
        }
        onStart={startRun}
      />

      <RunStepDialog
        result={openStep ? (results[openStep] ?? null) : null}
        runId={runId}
        onOpenChange={(open) => !open && setOpenStep(null)}
      />

      {(runId || resultList.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>
              {kind === "ui" ? "Browser suite — live progress" : "Live progress"}
            </CardTitle>
            <CardAction className="flex gap-2">
              {!running && runId && !runStatus && (
                <Button type="button" variant="outline" size="sm" onClick={reconnect}>
                  <RefreshCw aria-hidden="true" />
                  Reconnect
                </Button>
              )}
              {kind === "ui" && running && (
                <Button type="button" variant="destructive" size="sm" onClick={() => void stopRun()}>
                  <Square aria-hidden="true" />
                  Stop
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={clearRun}
                disabled={running}
                title={running ? "Available once the run finishes" : undefined}
              >
                <Trash2 aria-hidden="true" />
                Clear
              </Button>
            </CardAction>
            <CardDescription>
              <span aria-live="polite">
                {`Run ${runId} — ${runStatus ?? "in progress"} — ${passed} passed, ${failedCount} failed${
                  skippedCount ? `, ${skippedCount} skipped` : ""
                }${total ? ` · ${resultList.length}/${total} done` : ""}`}
              </span>
              {runBaseUrl && <span className="block font-mono text-xs">{runBaseUrl}</span>}
              {runError && (
                <span className="mt-1 block text-xs text-destructive" role="alert">
                  {runError}
                </span>
              )}
              {testSheet &&
                (testSheet.ok ? (
                  <span className="mt-1 flex items-start gap-1 text-xs">
                    <FileSpreadsheet className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                    <span>
                      Test sheet written ({testSheet.matchedRows} rows) —{" "}
                      <span className="font-mono break-all">{testSheet.path}</span>
                    </span>
                  </span>
                ) : (
                  <span className="mt-1 flex items-start gap-1 text-xs text-destructive">
                    <CircleX className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                    <span>Test sheet not written — {testSheet.error}</span>
                  </span>
                ))}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {total ? (
              <div className="px-6 pb-3">
                <div
                  role="progressbar"
                  aria-label="Run progress"
                  aria-valuemin={0}
                  aria-valuemax={total}
                  aria-valuenow={resultList.length}
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full w-full origin-left bg-primary transition-transform duration-(--duration-enter) ease-(--ease-emphasis)"
                    style={{ transform: `scaleX(${Math.min(1, resultList.length / total)})` }}
                  />
                </div>
              </div>
            ) : null}
            <div className="divide-y border-t">
              {resultList.map((r) => {
                const key = r.stepKey || r.testId;
                // A browser test has no document to show; API steps open theirs.
                const sent = r.variants?.some((v) => v.requestBody || v.documentPath);
                const shared = (r.batchSize ?? 1) > 1;
                const Row = sent ? "button" : "div";
                return (
                  <Row
                    key={key}
                    {...(sent
                      ? {
                          type: "button" as const,
                          onClick: () => setOpenStep(key),
                          "aria-label": `Open the document sent for ${r.testId} ${r.eventType}`,
                        }
                      : {})}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-6 py-2 text-left text-sm",
                      sent &&
                        "cursor-pointer transition-colors duration-(--duration-quick) hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                    )}
                  >
                    <div className="min-w-0">
                      <span className="mr-2 font-mono text-xs text-muted-foreground">{r.testId}</span>
                      <span>{r.eventType}</span>
                      {shared && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          shares document {r.batchId} · {r.batchEventCount} events
                        </span>
                      )}
                      {/* Every failure says why in plain English; the raw error stays in the
                          step dialog. Older results without a reason show their error. */}
                      {!r.ok && !r.skipped && (r.reason || r.error) && (
                        <span className="line-clamp-2 block text-xs text-destructive" title={r.error || r.reason}>
                          {r.reason || r.error}
                        </span>
                      )}
                    </div>
                    <span className="flex shrink-0 items-center gap-2">
                      {sent && (
                        <FileJson className="size-3.5 text-muted-foreground" aria-hidden="true" />
                      )}
                      <Badge variant={r.ok ? "default" : r.skipped ? "outline" : "destructive"}>
                        {r.ok ? "PASS" : r.skipped ? "SKIPPED" : "FAIL"}
                      </Badge>
                    </span>
                  </Row>
                );
              })}
              {running && (
                <div className="flex items-center gap-2 px-6 py-2 text-sm italic text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  {kind === "ui" && total === null ? "Starting Playwright…" : "Waiting for next result…"}
                </div>
              )}
            </div>
            {kind === "ui" && logs.length > 0 && (
              <div className="border-t px-6 py-3">
                <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Runner output</h3>
                <pre
                  ref={logRef}
                  className="max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
                >
                  {logs.join("\n")}
                </pre>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default Run;
