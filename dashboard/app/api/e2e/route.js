import { NextResponse } from 'next/server';
import {
  runEndToEnd,
  FLOW_STEPS,
  DOCUMENT_MODES,
  mintIdentifiers,
  applyPortalBatches,
  clampSerialCount,
  MAX_SERIAL_COUNT,
} from '../../../lib/e2eFlow';
import { usableProducts, findProduct } from '../../../lib/productRegistry';
import { createRun, appendResult, finishRun, saveDocument, updateConsignment } from '../../../lib/runStore';
import { emitProgress } from '../../../lib/runBus';
import { getBaseUrl } from '../../../lib/env';
import { normalizeBaseUrl } from '../../../lib/baseUrl';
import { writeDailyTestSheet } from '../../../lib/testSheets';
import { checkReachable } from '../../../lib/reachability';
import { createPortalBatches, MAX_PORTAL_SERIALS } from '../../../lib/portalBatches';

export const dynamic = 'force-dynamic';

const ROLES = ['manufacturer', 'distributor', 'facility'];

// A journey step is recorded in the same shape as a per-role test result, so the runs list,
// logs, Excel export and the daily test sheet all consume it without special-casing.
// Large documents live only in the saved file; the result keeps its path and, when small
// enough to be a readable repro on the Logs page, the body itself.
const INLINE_BODY_LIMIT = 100_000;

function toRunResult(step, documentPath) {
  return {
    // Two return steps legitimately share a workbook Test ID (a Return Shipping row covers
    // both the facility->distributor and distributor->manufacturer leg), so the UI keys off
    // stepKey. testId stays for stamping the workbook row.
    stepKey: step.key,
    phase: step.phase,
    documentMode: step.documentMode,
    batchId: step.batchId,
    batchSize: step.batchSize,
    batchEventCount: step.batchEventCount,
    eventId: step.eventId,
    attributedWarnings: step.attributedWarnings,
    unattributedWarnings: step.unattributedWarnings,
    testId: step.testId,
    eventType: `${step.index}. ${step.label}`,
    path: step.path,
    role: step.role,
    ok: step.ok,
    // A step whose role had no token was never sent. It is not a failure and must not be
    // counted or drawn as one.
    skipped: Boolean(step.skipped),
    error: step.ok ? undefined : step.summary,
    variants: [
      {
        variant: 'JSON-LD',
        method: 'POST',
        url: step.url,
        status: step.status ?? null,
        requestBody:
          step.requestBody && step.requestBody.length <= INLINE_BODY_LIMIT ? step.requestBody : undefined,
        documentPath,
        responseBody: step.responseBody ?? step.summary,
        ok: step.ok,
        durationMs: step.durationMs ?? 0,
      },
    ],
  };
}

// The portal batch step is not an API request, but it is recorded in the same result shape
// so the run views, Logs and the day sheet show it like any other step.
function portalBatchResult(outcome, ids, baseUrl) {
  const failed = outcome.lines.filter((l) => !l.ok);
  const summary = outcome.lines
    .map((l, i) => {
      const name = ids.lines[i].product.brand;
      return l.ok ? `${name}: ${l.batchNo} (expires ${l.expiry})` : `${name}: FAILED - ${l.error}`;
    })
    .join('\n');
  return {
    stepKey: 'portal-batch',
    phase: 'setup',
    testId: 'MFG-BATCH-001',
    eventType: '0. Create batch in portal (UI)',
    path: ['Manufacturer portal', 'Batches', 'Create Batch'],
    role: 'manufacturer',
    ok: failed.length === 0,
    skipped: false,
    error: failed.length ? failed.map((l) => l.error).join('; ') : undefined,
    batches: outcome.lines.map((l, i) => ({
      ...l,
      product: ids.lines[i].product.brand,
      gtin: ids.lines[i].product.gtin,
    })),
    variants: [
      {
        variant: 'Portal UI',
        method: 'UI',
        url: `${baseUrl}/manufacturer/batches`,
        status: outcome.lines.find((l) => l.status)?.status ?? null,
        requestBody: 'node scripts/portal/create-batches.cjs  (PORTAL_BATCH_REQUEST: product, GTIN and serials per line)',
        responseBody: summary + (outcome.output && failed.length ? `\n\n${outcome.output}` : ''),
        ok: failed.length === 0,
        durationMs: outcome.durationMs,
      },
    ],
  };
}

async function writeDaySheetSafely(runId) {
  try {
    const { outPath, matchedRows, dateKey } = await writeDailyTestSheet();
    return { ok: true, path: outPath, dateKey, matchedRows };
  } catch (err) {
    console.error(`[e2e ${runId}] failed to write day test sheet:`, err);
    return { ok: false, error: err.message };
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const tokens = body.tokens || {};
  const supplied = ROLES.filter((role) => typeof tokens[role] === 'string' && tokens[role].length > 0);
  if (supplied.length === 0) {
    return NextResponse.json(
      { error: 'At least one role token is required to run the journey' },
      { status: 400 }
    );
  }

  const documentMode = body.documentMode || 'split';
  if (!DOCUMENT_MODES.includes(documentMode)) {
    return NextResponse.json(
      { error: `documentMode must be one of: ${DOCUMENT_MODES.join(', ')}` },
      { status: 400 }
    );
  }

  let baseUrl = getBaseUrl();
  if (body.baseUrl !== undefined) {
    const normalized = normalizeBaseUrl(body.baseUrl);
    if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });
    baseUrl = normalized.value;
  }

  // Same server-authoritative gate as /api/run - an 11-step journey against a dead host is
  // 11 network errors, not a test result.
  const reachability = await checkReachable(baseUrl);
  if (!reachability.reachable) {
    return NextResponse.json(
      { error: `${baseUrl} is not reachable — ${reachability.error}`, reachability },
      { status: 502 }
    );
  }

  // Minted before the run so the consignment is on disk even if the very first request
  // fails - a batch you cannot identify afterwards is not traceable.
  // `products` (a list) mixes products in one consignment; `product` is the older single form.
  const productRefs = Array.isArray(body.products) ? body.products : body.product ? [body.product] : [];
  const unusable = productRefs.filter((ref) => !findProduct(ref)?.gtinValid);
  if (unusable.length) {
    return NextResponse.json(
      { error: `Unknown product or invalid GTIN: ${unusable.join(', ')}` },
      { status: 400 }
    );
  }
  const serialCount = clampSerialCount(body.serialCount);
  const identifiers = mintIdentifiers(serialCount, productRefs);

  const portalBatches = Boolean(body.portalBatches) && documentMode !== 'oversize';
  if (portalBatches) {
    if (!tokens.manufacturer) {
      return NextResponse.json(
        { error: 'Creating batches in the portal needs the manufacturer token for the commissioning that follows' },
        { status: 400 }
      );
    }
    if (identifiers.serialsPerProduct > MAX_PORTAL_SERIALS) {
      return NextResponse.json(
        { error: `Portal batches are typed into the Create Batch form, so they are limited to ${MAX_PORTAL_SERIALS.toLocaleString()} serials per product` },
        { status: 400 }
      );
    }
  }
  const run = createRun({
    role: 'end-to-end',
    eventTypes: null,
    baseUrl,
    documentMode,
    consignment: {
      tag: identifiers.tag,
      product: identifiers.product,
      lot: identifiers.lot,
      products: identifiers.lines.map((line) => ({ ...line.product, lot: line.lot })),
      serialsPerProduct: identifiers.serialsPerProduct,
      portalBatches,
      serialCount: identifiers.serialCount,
      serials: identifiers.serials,
      caseA: identifiers.caseA,
      caseB: identifiers.caseB,
      caseC: identifiers.caseC,
      pallet: identifiers.pallet,
      distCase: identifiers.distCase,
    },
  });

  (async () => {
    try {
      // Setup: the manufacturer creates each batch in the portal first, and commissioning then
      // uses the batch number and expiry the portal assigned.
      if (portalBatches) {
        const outcome = await createPortalBatches({
          lines: identifiers.lines,
          baseUrl,
          headed: Boolean(body.portalHeaded),
        });
        applyPortalBatches(identifiers, outcome.lines);
        // The consignment was recorded before the portal assigned lots; record the real ones.
        updateConsignment(run.id, {
          lot: identifiers.lot,
          products: identifiers.lines.map((line) => ({
            ...line.product,
            lot: line.lot,
            expiry: line.expiry,
            batchSource: line.batchSource,
            batchId: line.batchId ?? null,
            serials: line.serials,
          })),
        });
        const result = portalBatchResult(outcome, identifiers, baseUrl);
        appendResult(run.id, result);
        emitProgress(run.id, { type: 'result', result });
      }

      const summary = await runEndToEnd(
        {
          tokens,
          baseUrl,
          documentMode,
          identifiers,
          settleMs: Number.isFinite(body.settleMs) ? body.settleMs : undefined,
        },
        (step) => {
          // One file per request: d01-mfg-commission (split) or b01-manufacturer (combined).
          const request = String(step.batchId || `s${step.index}`).replace(/\d+/, (n) => n.padStart(2, '0'));
          const name = step.batchSize > 1 ? `${request}-${step.role}` : `${request}-${step.key}`;
          const documentPath = step.requestBody ? saveDocument(run.id, name, step.requestBody) : undefined;
          const result = toRunResult(step, documentPath);
          appendResult(run.id, result);
          emitProgress(run.id, { type: 'result', result });
        }
      );
      finishRun(run.id, { status: 'complete' });
      const sheet = await writeDaySheetSafely(run.id);
      emitProgress(run.id, {
        type: 'done',
        status: 'complete',
        testSheet: sheet,
        identifiers: summary.identifiers,
        documentMode,
        requestCount: summary.requestCount,
        requests: summary.requests,
      });
    } catch (err) {
      finishRun(run.id, { status: 'error', error: err.message });
      const sheet = await writeDaySheetSafely(run.id);
      emitProgress(run.id, { type: 'done', status: 'error', error: err.message, testSheet: sheet });
    }
  })();

  return NextResponse.json({
    runId: run.id,
    totalSteps: FLOW_STEPS.length,
    rolesSupplied: supplied,
    portalBatches,
    documentMode,
    serialCount: identifiers.serialCount,
    product: identifiers.product,
    lot: identifiers.lot,
    products: identifiers.lines.map((line) => ({ ...line.product, lot: line.lot })),
  });
}

// Lets the UI render the journey (and which role each step needs) before anything is run.
export async function GET() {
  return NextResponse.json({
    documentModes: DOCUMENT_MODES,
    maxSerialCount: MAX_SERIAL_COUNT,
    products: usableProducts().map((p) => ({
      productId: p.productId,
      gtin: p.gtin,
      brand: p.brand,
      generic: p.generic,
    })),
    steps: FLOW_STEPS.map((s, i) => ({
      key: s.key,
      index: i + 1,
      role: s.role,
      label: s.label,
      testId: s.testId,
      phase: s.phase,
      sync: Boolean(s.sync),
    })),
  });
}
