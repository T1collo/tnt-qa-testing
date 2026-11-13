"use client";

import { useMemo } from "react";
import { FileStack, Files, Gauge, Loader2, Play } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProductPicker } from "@/components/product-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type Product = { productId: string; gtin: string; brand: string; generic: string };
export type Scope = "role" | "e2e";
export type DocumentMode = "split" | "combined" | "oversize";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Chosen on the form, so the matching token fields are visible before this opens. */
  scope: Scope;
  documentMode: DocumentMode;
  onDocumentModeChange: (mode: DocumentMode) => void;
  /** Journey length, used to state how many requests each strategy will actually send. */
  journeySteps: number;
  /** Requests the single-role suite would fire (checked event types x2 variants). */
  roleRequests: number;
  baseUrl: string;
  /** Catalogue of products with a GTIN that passes its own GS1 check digit. */
  products: Product[];
  /** GTINs of the chosen products; several are mixed into one run. */
  productIds: string[];
  onProductsChange: (gtins: string[]) => void;
  serialCount: number;
  onSerialCountChange: (count: number) => void;
  maxSerialCount: number;
  /** Single-role suite only: mint fresh identifiers so repeat runs test validity, not novelty. */
  freshData: boolean;
  onFreshDataChange: (fresh: boolean) => void;
  /** Journey only: create each batch in the Manufacturer portal before commissioning. */
  portalBatches: boolean;
  onPortalBatchesChange: (value: boolean) => void;
  portalHeaded: boolean;
  onPortalHeadedChange: (value: boolean) => void;
  starting: boolean;
  canStart: boolean;
  blockedReason: string | null;
  onStart: () => void;
};

export const SCOPES: { value: Scope; label: string; detail: string }[] = [
  { value: "role", label: "Single role suite", detail: "Mapped collection requests for one partner role." },
  { value: "e2e", label: "End-to-end journey", detail: "One consignment walked through all three roles." },
];

const DOCUMENT_MODES: {
  value: DocumentMode;
  label: string;
  icon: typeof Files;
  detail: string;
}[] = [
  {
    value: "split",
    label: "One document per event",
    icon: Files,
    detail: "Each event is its own EPCIS document. A rejection only ever fails that one step.",
  },
  {
    value: "combined",
    label: "Combined per role",
    icon: FileStack,
    detail:
      "Consecutive steps for the same partner travel in one document. A rejection takes the whole document with it — nothing in it is stored.",
  },
  {
    value: "oversize",
    label: "Limits probe",
    icon: Gauge,
    detail:
      "Deliberately breaches the documented ceilings (50,000 serials, 10 MB) to check they are enforced. Covers API-MFG-COMM-EDGE-008 and -009.",
  },
];

// Batching groups contiguous same-role runs, with the synchronous dispense always alone.
// Kept in step with lib/documentPlan.js; shown so the operator knows what will actually
// hit the environment before they commit to it.
const COMBINED_REQUESTS = 7;
const OVERSIZE_REQUESTS = 2;

export function RunModeDialog({
  open,
  onOpenChange,
  scope,
  documentMode,
  onDocumentModeChange,
  journeySteps,
  roleRequests,
  baseUrl,
  products,
  productIds,
  onProductsChange,
  serialCount,
  onSerialCountChange,
  maxSerialCount,
  freshData,
  onFreshDataChange,
  portalBatches,
  onPortalBatchesChange,
  portalHeaded,
  onPortalHeadedChange,
  starting,
  canStart,
  blockedReason,
  onStart,
}: Props) {
  // Each extra product adds one commissioning event (one lot per event, guide 3.1.1.1).
  const productCount = Math.max(1, productIds.length);
  const extraCommissioning = productCount - 1;
  const plan = useMemo(() => {
    if (scope === "role") return { requests: roleRequests, events: roleRequests };
    if (documentMode === "combined")
      return { requests: COMBINED_REQUESTS, events: journeySteps + extraCommissioning };
    if (documentMode === "oversize") return { requests: OVERSIZE_REQUESTS, events: OVERSIZE_REQUESTS };
    return { requests: journeySteps, events: journeySteps + extraCommissioning };
  }, [scope, documentMode, journeySteps, roleRequests, extraCommissioning]);
  // Mirrors the server cap that keeps a whole mixed consignment within the message limit.
  const serialsPerProduct = Math.min(serialCount, Math.floor(maxSerialCount / productCount));
  const totalSerials = serialsPerProduct * productCount;
  const scopeLabel = SCOPES.find((s) => s.value === scope);
  const selectedMode = DOCUMENT_MODES.find((m) => m.value === documentMode) ?? DOCUMENT_MODES[0];
  const showConsignment =
    (scope === "e2e" && documentMode !== "oversize") || (scope === "role" && freshData);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wide enough for two columns, never full screen. grid-cols-[minmax(0,1fr)] stops
          long unbreakable content from widening the grid past the dialog's own edge. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Configure this run</DialogTitle>
          <DialogDescription>
            {scopeLabel?.label} — {scopeLabel?.detail} Events go to a live environment and
            cannot be withdrawn.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-w-0 gap-6 md:grid-cols-2">
          {/* Left: how the run is shaped. */}
          <div className="min-w-0 space-y-4">
            {scope === "e2e" ? (
              <div className="space-y-1.5">
                <Label htmlFor="run-document-mode">Document strategy</Label>
                <Select
                  value={documentMode}
                  onValueChange={(value) => onDocumentModeChange(value as DocumentMode)}
                >
                  <SelectTrigger id="run-document-mode" className="w-full" aria-describedby="run-document-mode-help">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DOCUMENT_MODES.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <option.icon aria-hidden="true" />
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p id="run-document-mode-help" className="text-xs text-muted-foreground">
                  {selectedMode.detail}
                </p>
              </div>
            ) : null}

            {scope === "e2e" && documentMode !== "oversize" ? (
              <div className="space-y-2 rounded-lg border px-3 py-2">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="run-portal-batches"
                    checked={portalBatches}
                    onCheckedChange={(value) => onPortalBatchesChange(value === true)}
                    aria-describedby="run-portal-batches-help"
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <Label htmlFor="run-portal-batches" className="text-sm font-medium">
                      Create batches in the portal first
                    </Label>
                    <p id="run-portal-batches-help" className="mt-0.5 text-xs text-muted-foreground">
                      {portalBatches
                        ? "Logs in to the Manufacturer portal (.env login), creates one batch per product with these serials, then commissions them using the portal's batch number and expiry."
                        : "Off: commissioning uses a generated lot, which the platform flags as INVALID_LOT."}
                    </p>
                  </div>
                </div>
                {portalBatches && (
                  <div className="flex items-center gap-3 pl-7">
                    <Checkbox
                      id="run-portal-headed"
                      checked={portalHeaded}
                      onCheckedChange={(value) => onPortalHeadedChange(value === true)}
                    />
                    <Label htmlFor="run-portal-headed" className="text-xs font-normal">
                      Show the browser while it creates them
                    </Label>
                  </div>
                )}
              </div>
            ) : scope === "e2e" ? null : (
              <div className="flex items-start gap-3 rounded-lg border px-3 py-2">
                <Checkbox
                  id="run-fresh-data"
                  checked={freshData}
                  onCheckedChange={(value) => onFreshDataChange(value === true)}
                  aria-describedby="run-fresh-data-help"
                  className="mt-0.5"
                />
                <div className="min-w-0">
                  <Label htmlFor="run-fresh-data" className="text-sm font-medium">
                    Mint fresh identifiers (happy path)
                  </Label>
                  <p id="run-fresh-data-help" className="mt-0.5 text-xs text-muted-foreground">
                    {freshData
                      ? "Each request gets new serials, SSCCs and timestamps, so a valid event is judged on validity. Error declarations submit their original event first."
                      : "Off: requests are fired exactly as written - only for testing duplicate rejection. After the first run most return 409 duplicate."}
                  </p>
                </div>
              </div>
            )}

            <div
              className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs"
              role="status"
              aria-atomic="true"
            >
              <span className="text-muted-foreground">Will send</span>
              <Badge variant="outline" className="tabular-nums">
                {plan.requests} request{plan.requests === 1 ? "" : "s"}
              </Badge>
              {scope === "e2e" && documentMode !== "oversize" && (
                <>
                  <Badge variant="outline" className="tabular-nums">
                    {plan.events} events
                  </Badge>
                  <Badge variant="outline" className="tabular-nums">
                    {totalSerials.toLocaleString()} serial{totalSerials === 1 ? "" : "s"}
                  </Badge>
                  {productCount > 1 && (
                    <Badge variant="outline" className="tabular-nums">
                      {productCount} products
                    </Badge>
                  )}
                  {portalBatches && (
                    <Badge variant="outline" className="tabular-nums">
                      {productCount} portal batch{productCount === 1 ? "" : "es"}
                    </Badge>
                  )}
                </>
              )}
              <span className="basis-full truncate font-mono text-muted-foreground" title={baseUrl}>
                {baseUrl}
              </span>
            </div>
          </div>

          {/* Right: what the consignment is made of. */}
          <div className="min-w-0 space-y-4">
            {showConsignment ? (
              <>
                <ProductPicker
                  products={products}
                  selected={productIds}
                  onChange={onProductsChange}
                  hint={
                    scope === "e2e"
                      ? "Pick one or more. Each product is commissioned in its own event with its own lot; cases, shipments and dispensing carry them all together."
                      : "Pick one or more. Products take turns across requests, one product per request."
                  }
                />

                {scope === "e2e" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="run-serials">
                      {productCount > 1 ? "Serials per product" : "Serials per consignment"}
                    </Label>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        id="run-serials"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={maxSerialCount}
                        value={serialCount}
                        onChange={(e) => onSerialCountChange(Number(e.target.value))}
                        className="w-28 tabular-nums"
                        aria-describedby="run-serials-help"
                      />
                      {[1, 2, 10, 100, 1000].map((preset) => (
                        <Button
                          key={preset}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onSerialCountChange(preset)}
                          aria-pressed={serialCount === preset}
                          className={
                            serialCount === preset
                              ? "border-selected/70 bg-selected/10 text-selected"
                              : undefined
                          }
                        >
                          {preset.toLocaleString()}
                        </Button>
                      ))}
                    </div>
                    <p id="run-serials-help" className="text-xs text-muted-foreground">
                      {serialsPerProduct < serialCount
                        ? `Capped at ${serialsPerProduct.toLocaleString()} per product so ${productCount} products stay within the ${maxSerialCount.toLocaleString()}-serial message limit.`
                        : `Carried by every step from commissioning to destruction. The platform rejects more than ${maxSerialCount.toLocaleString()} in one message.`}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                {scope === "e2e"
                  ? "The limits probe builds its own oversized payloads, so no product or serial count is needed."
                  : "Requests are sent exactly as the collection has them. Turn on fresh identifiers to choose products."}
              </p>
            )}
          </div>
        </div>

        {blockedReason && <p className="text-sm text-destructive">{blockedReason}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={starting}>
            Cancel
          </Button>
          <Button onClick={onStart} disabled={!canStart || starting}>
            {starting ? <Loader2 className="animate-spin" /> : <Play />}
            {starting ? "Starting…" : "Start run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RunModeDialog;
