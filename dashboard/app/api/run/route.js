import { NextResponse } from 'next/server';
import { runForRole } from '../../../lib/postmanRunner';
import { createRun, restartRun, readRun, appendResult, finishRun } from '../../../lib/runStore';
import { emitProgress } from '../../../lib/runBus';
import { getBaseUrl } from '../../../lib/env';
import { normalizeBaseUrl } from '../../../lib/baseUrl';
import { ROLES } from '../../../lib/testIdMap';
import { writeDailyTestSheet } from '../../../lib/testSheets';
import { checkReachable, healthSnapshot } from '../../../lib/reachability';
import { findProduct } from '../../../lib/productRegistry';

export const dynamic = 'force-dynamic';

// The sheet is a side effect of finishing a run, not the point of it: if writing fails
// (folder locked, Excel holding the file open) the run result itself must still be
// reported, so the failure is surfaced in the payload rather than thrown.
async function writeDaySheetSafely(runId) {
  try {
    const { outPath, matchedRows, dateKey } = await writeDailyTestSheet();
    return { ok: true, path: outPath, dateKey, matchedRows };
  } catch (err) {
    console.error(`[run ${runId}] failed to write day test sheet:`, err);
    return { ok: false, error: err.message };
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { role, apiToken, eventTypes } = body;
  // Happy-path option: mint fresh serials/SSCCs/timestamps per request instead of firing the
  // collection's fixed identifiers, which are duplicates on every run after the first.
  // On unless explicitly turned off (duplicate-rejection testing).
  const freshData = body.freshData !== false;

  if (!Object.values(ROLES).includes(role)) {
    return NextResponse.json({ error: `role must be one of: ${Object.values(ROLES).join(', ')}` }, { status: 400 });
  }
  if (!apiToken || typeof apiToken !== 'string') {
    return NextResponse.json({ error: 'apiToken is required' }, { status: 400 });
  }

  // The form sends the base URL it displayed, so the run targets exactly the environment
  // the operator saw. Omitted (or an older client) falls back to the .env default.
  let baseUrl = getBaseUrl();
  if (body.baseUrl !== undefined) {
    const normalized = normalizeBaseUrl(body.baseUrl);
    if (!normalized.ok) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }
    baseUrl = normalized.value;
  }

  // Server-authoritative gate: the client's green "Reachable" badge is a convenience, not
  // permission. Re-probe here so a stale badge or a host that dropped in between can't start
  // a run whose every step would fail as a network error dressed up as a test result.
  const reachability = await checkReachable(baseUrl);
  if (!reachability.reachable) {
    return NextResponse.json(
      { error: `${baseUrl} is not reachable — ${reachability.error}`, reachability },
      { status: 502 }
    );
  }
  const health = healthSnapshot(baseUrl, reachability);

  // `products` (a list) rotates several products across requests; `product` is the older
  // single form.
  const products = [];
  const productRefs = !freshData ? [] : Array.isArray(body.products) ? body.products : body.product ? [body.product] : [];
  for (const ref of productRefs) {
    const found = findProduct(ref);
    if (!found) {
      return NextResponse.json({ error: `Unknown product ${ref}` }, { status: 400 });
    }
    if (!found.gtinValid) {
      return NextResponse.json({ error: `GTIN ${found.gtin} fails its GS1 check digit` }, { status: 400 });
    }
    if (!products.some((p) => p.gtin === found.gtin)) products.push(found);
  }
  const product = products[0] || null;

  const config = {
    role,
    eventTypes: eventTypes || null,
    baseUrl,
    documentMode: freshData ? 'fresh-data' : null,
    health,
    consignment: product
      ? {
          product: { productId: product.productId, gtin: product.gtin, brand: product.brand, sgtinPrefix: product.sgtinPrefix },
          products: products.map((p) => ({ productId: p.productId, gtin: p.gtin, brand: p.brand, sgtinPrefix: p.sgtinPrefix })),
        }
      : null,
  };
  // `rerunOf`: run again under that run's id, replacing its results, instead of a new run.
  let run;
  if (body.rerunOf) {
    const previous = readRun(String(body.rerunOf));
    if (!previous) return NextResponse.json({ error: `Run ${body.rerunOf} not found` }, { status: 404 });
    if (previous.role !== role) {
      return NextResponse.json({ error: `Run ${previous.id} was a ${previous.role} run, not ${role}` }, { status: 400 });
    }
    run = restartRun(previous.id, 'role', config);
  } else {
    run = createRun(config);
  }

  // Fire-and-forget: the run executes in this same long-running Node process (this app
  // isn't deployed as stateless serverless functions), streaming progress over SSE via
  // runBus while persisting each result to disk via runStore as it lands.
  (async () => {
    try {
      await runForRole(
        {
          role,
          apiToken,
          baseUrl,
          eventTypes: eventTypes || null,
          freshData,
          sgtinPrefix: product?.sgtinPrefix ?? null,
          sgtinPrefixes: products.map((p) => p.sgtinPrefix),
        },
        (result) => {
          appendResult(run.id, result);
          emitProgress(run.id, { type: 'result', result });
        }
      );
      finishRun(run.id, { status: 'complete' });
      // finishRun() has to land first - the day sheet is built by re-reading the store, so
      // this run only appears in it once its finishedAt is on disk.
      const sheet = await writeDaySheetSafely(run.id);
      emitProgress(run.id, { type: 'done', status: 'complete', testSheet: sheet });
    } catch (err) {
      finishRun(run.id, { status: 'error', error: err.message });
      const sheet = await writeDaySheetSafely(run.id);
      emitProgress(run.id, { type: 'done', status: 'error', error: err.message, testSheet: sheet });
    }
  })();

  return NextResponse.json({ runId: run.id });
}
