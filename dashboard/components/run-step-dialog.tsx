"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BrowserTestDetail,
  CodeBlock,
  EventSummary,
  NO_SCROLLBAR,
  pretty,
  DurationPill,
  RoleChip,
  StatusPill,
  type DocEvent,
} from "@/components/document-view";
import { eventsFromBody, returnedEventIds } from "@/lib/epcisEvents";
import type { RunResult } from "@/lib/run-session";
import { cn, isTestStep, showsTestDetail } from "@/lib/utils";

/**
 * One step of a live run: the document it was sent in - whole, including every event when a
 * document carries several - the platform's response, and the identifiers involved.
 *
 * A journey document too large to travel with the progress stream is fetched from the copy the
 * run saved on disk, so Copy always yields the entire document.
 */
export function RunStepDialog({
  result,
  runId,
  onOpenChange,
}: {
  result: RunResult | null;
  runId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [variantIndex, setVariantIndex] = useState(0);
  const [fetched, setFetched] = useState<{ step: string; text: string } | null>(null);
  const [fetchError, setFetchError] = useState<{ step: string; message: string } | null>(null);

  const step = result?.stepKey || result?.testId || null;
  // A browser test opens on its own result, then one tab per request it sent.
  const exchanges = result?.exchanges ?? [];
  const variants = [...(result?.variants ?? []), ...exchanges];
  const variant = variants[Math.min(variantIndex, Math.max(variants.length - 1, 0))];
  const needsFetch = Boolean(result && variant && !variant.requestBody && variant.documentPath && runId && step);

  // Back to the first variant whenever a different step is opened. Adjusted during render,
  // React's documented pattern for resetting state on a prop change.
  const [stepShown, setStepShown] = useState(step);
  if (step !== stepShown) {
    setStepShown(step);
    setVariantIndex(0);
  }

  useEffect(() => {
    if (!needsFetch || !runId || !step) return;
    let cancelled = false;
    fetch(`/api/runs?id=${encodeURIComponent(runId)}&document=${encodeURIComponent(step)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { text: string }) => {
        if (!cancelled) setFetched({ step, text: d.text });
      })
      .catch((err: Error) => {
        if (!cancelled) setFetchError({ step, message: `Could not load the saved document (${err.message}).` });
      });
    return () => {
      cancelled = true;
    };
  }, [needsFetch, runId, step]);

  if (!result) return null;

  const document = variant?.requestBody ?? (fetched?.step === step ? fetched.text : null);
  const events: DocEvent[] = eventsFromBody(document ?? "");
  const returned = returnedEventIds(variant?.responseBody ?? "");
  const shared = (result.batchSize ?? 1) > 1;
  const isTest = showsTestDetail(variant);
  const tabLabel = (v: (typeof variants)[number]) => (showsTestDetail(v) ? "Test" : v.variant);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] rounded-3xl sm:max-w-3xl"
        )}
      >
        <DialogHeader>
          <DialogTitle>{result.eventType}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{result.testId}</span>
            {shared
              ? ` · document ${result.batchId ?? ""} carries ${result.batchEventCount ?? events.length} events for ${result.batchSize} steps`
              : events.length > 1
                ? ` · ${events.length} events in this document`
                : ""}
          </DialogDescription>
        </DialogHeader>

        <div className={cn("flex min-h-0 min-w-0 flex-col gap-5 overflow-y-auto", NO_SCROLLBAR)}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <RoleChip role={result.role} />
            <Badge variant={result.ok ? "default" : result.skipped ? "outline" : "destructive"}>
              {result.ok ? "PASS" : result.skipped ? "SKIPPED" : "FAIL"}
            </Badge>
            <StatusPill status={variant?.status} />
            <DurationPill
              ms={variant?.durationMs}
              step={result.stepKey || result.testId}
              untimed={isTestStep(variant?.method)}
            />
            {variants.length > 1 && (
              <span className={cn("flex flex-wrap gap-1", exchanges.length ? "basis-full" : "ml-auto")}>
                {variants.map((v, i) => (
                  <Button
                    key={`${v.variant}-${i}`}
                    type="button"
                    size="sm"
                    variant={i === variantIndex ? "secondary" : "ghost"}
                    aria-pressed={i === variantIndex}
                    onClick={() => setVariantIndex(i)}
                  >
                    {tabLabel(v)}
                  </Button>
                ))}
              </span>
            )}
          </div>

          {variant?.url && !isTest && (
            <p className="font-mono text-xs break-all">
              {variant.method ?? "POST"} {variant.url}
            </p>
          )}
          {isTest ? (
            <BrowserTestDetail
              variant={variant}
              ok={result.ok}
              skipped={result.skipped}
              reason={result.reason}
              requestCount={exchanges.length}
              tracking={result.tracking}
            />
          ) : (
            <>
            {result.error && !result.ok && !exchanges.length && (
              <p className="text-sm text-destructive" role="alert">
                {result.error}
              </p>
            )}

            {/* A portal call that is not an EPCIS document has no events or EPCs to list. */}
            {(events.length > 0 || !exchanges.length) && (
              <EventSummary
                events={events}
                returnedIds={returned}
                fallbackEventId={result.eventId ?? null}
                missingNote="This step sent no document, so there is nothing to copy."
              />
            )}

            {document ? (
              <CodeBlock
                label={shared ? "Document sent (shared by several steps)" : "Document sent"}
                text={pretty(document)}
                copyable
              />
            ) : needsFetch && fetchError?.step !== step ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                Loading the saved document…
              </p>
            ) : fetchError?.step === step ? (
              <p className="text-xs text-destructive" role="alert">
                {fetchError.message}
              </p>
            ) : null}

            <CodeBlock label="Response" text={pretty(variant?.responseBody)} copyable />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default RunStepDialog;
