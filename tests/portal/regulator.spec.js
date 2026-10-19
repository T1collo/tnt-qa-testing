// Regulator (PPB admin) - Events Explorer, Flagged Events and Analytics. Workbook sheets
// "Regulator - Events & Journey" and "Regulator - Analytics, Rules & ...".
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { qtest } = require('../helpers/qtest');
const { loginAs, newRolePage } = require('../helpers/auth');
const { logEntity } = require('../helpers/datalog');
const { postEvent } = require('../helpers/apiEnv');

function recorder(observed) {
  return () => {
    test.info().annotations.push({ type: 'actual', description: observed.join('; ') });
    console.log(`[actual] ${test.info().title}: ${observed.join('; ')}`);
  };
}

// Only the JSON API: the page itself is also served under /regulator/flagged-events, and its
// Next.js RSC fetches (/regulator/flagged-events?_rsc=...) answer with a "1:..." flight payload
// that JSON.parse rejects ("Unexpected non-whitespace character after JSON at position 1").
const FLAGGED_API = /\/api\/regulator\/flagged-events/;
const FLAGGED_LIST = /\/api\/regulator\/flagged-events\?/;

const eventsCount = async (page) => Number((await page.getByText(/^Events \(\d+\)/).first().innerText()).match(/\d+/)[0]);

async function openFlagged(page) {
  await loginAs(page, 'admin');
  const stats = page.waitForResponse((r) => FLAGGED_API.test(r.url()) && /\/statistics/.test(r.url()), { timeout: 30_000 });
  const queue = page.waitForResponse((r) => FLAGGED_API.test(r.url()) && /\/workqueue/.test(r.url()), { timeout: 30_000 });
  await page.goto('/regulator/flagged-events', { waitUntil: 'domcontentloaded' });
  const [s, q] = await Promise.all([stats, queue]);
  await expect(page.getByRole('button', { name: 'Workqueue' })).toBeVisible();
  return { stats: await s.json(), queue: await q.json() };
}

async function openAllEvents(page) {
  const list = page.waitForResponse((r) => FLAGGED_LIST.test(r.url()) && r.request().method() === 'GET', { timeout: 30_000 });
  await page.getByRole('button', { name: 'All Events' }).click();
  const res = await list;
  await expect(page.locator('main tbody tr').first()).toBeVisible({ timeout: 20_000 });
  return res.json();
}

test.describe('Regulator', () => {
  qtest('REG-EVT-004', 'Export downloads the currently filtered event list', async ({ page }) => {
    test.setTimeout(120_000);
    const observed = [];
    try {
      await loginAs(page, 'admin');
      await page.goto('/regulator/events/explorer', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText(/^Events \(\d+\)/).first()).toBeVisible({ timeout: 30_000 });
      // The heading reads "Events (0)" until the first page of events arrives.
      await expect.poll(() => eventsCount(page), { timeout: 30_000 }).toBeGreaterThan(0);
      const before = await eventsCount(page);

      // 1. Filter: Event Type = Object, applied with the search button.
      await page.getByRole('button', { name: 'Filters' }).click();
      await page.locator('main select').filter({ hasText: 'All Types' }).selectOption({ label: 'Object' });
      const filtered = page.waitForResponse((r) => /\/api\/epcis\/events\?/.test(r.url()) && /eventType=ObjectEvent/.test(r.url()), { timeout: 20_000 });
      await page.getByPlaceholder('Optional EPC/Event quick search...').press('Enter');
      await filtered;
      await expect.poll(() => eventsCount(page), { timeout: 15_000 }).not.toBe(before);
      const shown = await eventsCount(page);
      observed.push(`Event Type = Object: ${before} -> ${shown} events`);

      // 2. Export.
      const download = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
      const exportReq = page.waitForRequest((r) => /export/i.test(r.url()), { timeout: 30_000 }).catch(() => null);
      await page.getByRole('button', { name: 'Export' }).click();
      const [file, req] = await Promise.all([download, exportReq]);
      if (!file) {
        observed.push(`clicking Export produced no download in 30s${req ? ` (request ${req.url()})` : ' and no export request'}`);
      }
      expect(file, 'Export triggers a file download').not.toBeNull();

      const name = file.suggestedFilename();
      const path = test.info().outputPath(name);
      await file.saveAs(path);
      observed.push(`downloaded ${name} (${fs.statSync(path).size} bytes)`);
      expect(name).toMatch(/\.(csv|xlsx?)$/i);

      // 3. The file holds the filtered list: only ObjectEvents.
      let rows = [];
      if (/\.csv$/i.test(name)) {
        rows = fs.readFileSync(path, 'utf-8').trim().split(/\r?\n/).slice(1);
      } else {
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(path);
        wb.worksheets[0].eachRow((r, n) => n > 1 && rows.push(r.values.slice(1).join(',')));
      }
      const others = rows.filter((r) => /AggregationEvent|TransactionEvent|TransformationEvent|\bAggregation\b/.test(r));
      observed.push(`${rows.length} rows in file, ${others.length} non-Object`);
      expect(rows.length, 'file has event rows').toBeGreaterThan(0);
      expect(others.length, 'only the filtered (Object) events are exported').toBe(0);
    } finally {
      recorder(observed)();
    }
  });

  qtest('REG-FLAG-002', '"Workqueue" vs "All Events" tabs scope the flagged list differently', async ({ page }) => {
    test.setTimeout(90_000);
    const observed = [];
    try {
      const { stats, queue } = await openFlagged(page);
      const lanes = ['immediate', 'investigate', 'monitor'];
      const queued = lanes.flatMap((l) => queue[l] || []);
      const queueStatuses = [...new Set(queued.map((e) => e.status))];
      for (const lane of ['Immediate', 'Investigate', 'Monitor']) await expect(page.locator('main').getByText(lane, { exact: true }).first()).toBeVisible();
      observed.push(`Workqueue: lanes Immediate/Investigate/Monitor, ${queued.length} items loaded, statuses [${queueStatuses.join(', ')}]`);
      expect(queued.length, 'workqueue has items to act on').toBeGreaterThan(0);
      expect(queued.every((e) => /^(PENDING|UNDER_REVIEW)$/.test(e.status)), 'workqueue holds only unresolved items').toBe(true);

      const all = await openAllEvents(page);
      const caption = (await page.getByText(/Showing \d+ of \d+/).first().innerText()).trim();
      observed.push(`All Events: "${caption}"; API total ${all.total}; statistics total ${stats.totalFlagged} (resolved ${stats.byStatus?.RESOLVED}, dismissed ${stats.byStatus?.DISMISSED})`);
      // The full history: every flag, resolved and dismissed included.
      expect(all.total, 'All Events covers every flag').toBeGreaterThanOrEqual(stats.totalFlagged);
      const closed = stats.byStatus?.RESOLVED || 0;

      // Closed flags are reachable from All Events (status filter), never from the workqueue.
      await page.getByRole('button', { name: 'Filters' }).click();
      const statusSelect = page.locator('main select').filter({ hasText: 'All Statuses' });
      const resolvedRes = page.waitForResponse((r) => FLAGGED_LIST.test(r.url()) && /status=RESOLVED/i.test(r.url()), { timeout: 15_000 }).catch(() => null);
      await statusSelect.selectOption({ label: 'Resolved' });
      let resolved = await resolvedRes;
      if (!resolved) {
        const again = page.waitForResponse((r) => FLAGGED_LIST.test(r.url()) && /status=RESOLVED/i.test(r.url()), { timeout: 15_000 }).catch(() => null);
        await page.getByRole('button', { name: 'Refresh' }).click();
        resolved = await again;
      }
      expect(resolved, 'All Events can list resolved flags').not.toBeNull();
      const body = await resolved.json();
      observed.push(`All Events, Status = Resolved: ${body.total} flags`);
      if (closed > 0) expect(body.total).toBeGreaterThan(0);
      expect((body.data || []).every((e) => e.status === 'RESOLVED')).toBe(true);
    } finally {
      recorder(observed)();
    }
  });

  qtest('REG-FLAG-003', 'Refresh re-fetches the flagged events list', async ({ page }) => {
    test.setTimeout(90_000);
    const observed = [];
    try {
      await openFlagged(page);
      // Slow the API a little so the loading state is observable rather than a one-frame flash.
      await page.route('**/api/regulator/flagged-events/**', async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      });
      const refetched = [];
      const onReq = (r) => /\/api\/regulator\/flagged-events/.test(r.url()) && refetched.push(r.url().split('/api/regulator/')[1].split('?')[0]);
      page.on('request', onReq);
      const refresh = page.getByRole('button', { name: 'Refresh' });
      await refresh.click();

      const loading = await expect
        .poll(async () => {
          const disabled = await refresh.isDisabled().catch(() => false);
          const spin = await page.locator('main .animate-spin, main [aria-busy="true"], main .animate-pulse').count();
          const text = await page.locator('main').getByText(/Loading|Refreshing/i).count();
          return disabled || spin > 0 || text > 0 ? `${disabled ? 'button disabled ' : ''}${spin ? `${spin} spinner/skeleton ` : ''}${text ? 'loading text' : ''}`.trim() : '';
        }, { timeout: 1_400, intervals: [100] })
        .not.toBe('')
        .then(() => true, () => false);

      await expect.poll(() => refetched.length, { timeout: 15_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(2_500);
      page.off('request', onReq);
      await page.unroute('**/api/regulator/flagged-events/**');
      await expect(page.locator('main').getByText('Immediate', { exact: true }).first()).toBeVisible();
      observed.push(`Refresh re-requested [${[...new Set(refetched)].join(', ')}]; loading state ${loading ? 'shown' : 'not shown'}`);
      expect(refetched.length, 'list re-fetched').toBeGreaterThan(0);
      expect(loading, 'a brief loading state is shown').toBe(true);
    } finally {
      recorder(observed)();
    }
  });

  qtest('REG-FLAG-004', 'High-severity flags are visually distinguished from low-severity ones', async ({ page }) => {
    test.setTimeout(120_000);
    const observed = [];
    try {
      let { stats } = await openFlagged(page);
      const high = (stats.bySeverity?.CRITICAL || 0) + (stats.bySeverity?.HIGH || 0);
      if (!high) {
        // Precondition: no high-severity flag exists - raise one with a commissioning event for
        // an unregistered lot (INVALID_LOT is HIGH).
        const { loadCollection, findNode, freshenEventIds, freshenBusinessData } = require('../../dashboard/lib/postmanRunner');
        const node = findNode(loadCollection().item, ['Manufacturer Events', 'Commission (ObjectEvent)', 'JSON-LD']);
        const lot = `QA-AUTO-${Date.now()}`;
        const body = freshenBusinessData(freshenEventIds(node.request.body.raw)).replace(/"(lot|lotNumber|cbvmda:lotNumber)"\s*:\s*"[^"]*"/g, `"$1": "${lot}"`);
        const res = await postEvent('manufacturer', body);
        logEntity({ type: 'epcis_event', identifier: lot, testId: 'REG-FLAG-004', status: res.status, cleanup: 'test commissioning event with an unregistered lot; resolve its flag in Regulator > Flagged Events' });
        observed.push(`no HIGH/CRITICAL flag existed; posted commissioning with lot ${lot} -> ${res.status}`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        stats = await (await page.request.get('/api/regulator/flagged-events/statistics')).json();
      }
      observed.push(`flags by severity ${JSON.stringify(stats.bySeverity)}`);

      await openAllEvents(page);
      const badge = (label) => page.locator('main tbody tr td:first-child').getByText(label, { exact: true }).first();
      // Make sure both ends of the scale are on screen: the severity filter first, and when it
      // does not deliver (TrackIQ, 19 Oct 2026: GET /api/regulator/flagged-events?severity=...
      // answers HTTP 500 and the table keeps its unfiltered rows), the unfiltered list is paged
      // with "Next" until a row of that severity appears.
      const severitySelect = page.locator('main select').filter({ hasText: 'All Severities' });
      const styleOf = async (label) =>
        badge(label).evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, color: s.color, border: s.borderColor, cls: el.className };
        });
      // Brings a row of `sev` on screen.
      const showSeverity = async (sev) => {
        if (await badge(sev.toUpperCase()).isVisible().catch(() => false)) return;
        if (!(await severitySelect.isVisible().catch(() => false))) await page.getByRole('button', { name: 'Filters' }).click().catch(() => {});
        const filtered = page
          .waitForResponse((r) => FLAGGED_LIST.test(r.url()) && new RegExp(`severity=${sev}`, 'i').test(r.url()), { timeout: 15_000 })
          .catch(() => null);
        await severitySelect.selectOption({ label: sev });
        const res = await filtered;
        observed.push(`Severity filter = ${sev}: ${res ? `GET ${new URL(res.url()).search} -> ${res.status()}` : 'no request'}`);
        if (res && res.ok() && (await badge(sev.toUpperCase()).isVisible({ timeout: 10_000 }).catch(() => false))) return;
        const reset = page.waitForResponse((r) => FLAGGED_LIST.test(r.url()) && !/severity=/i.test(r.url()), { timeout: 15_000 }).catch(() => null);
        await severitySelect.selectOption({ label: 'All Severities' });
        await reset;
        let pageNo = 1;
        while (!(await badge(sev.toUpperCase()).isVisible().catch(() => false)) && pageNo < 20) {
          const next = page.waitForResponse((r) => FLAGGED_LIST.test(r.url()), { timeout: 15_000 }).catch(() => null);
          await page.getByRole('button', { name: 'Next' }).click();
          await next;
          pageNo++;
        }
        const found = await badge(sev.toUpperCase()).isVisible().catch(() => false);
        observed.push(`${sev.toUpperCase()} row ${found ? `found by paging the unfiltered list (page ${pageNo})` : `not found in ${pageNo} pages`}`);
      };
      const styles = {};
      for (const sev of ['High', 'Low']) {
        await showSeverity(sev);
        await expect(badge(sev.toUpperCase()), `a ${sev.toUpperCase()} flag is listed`).toBeVisible({ timeout: 5_000 });
        styles[sev] = await styleOf(sev.toUpperCase());
      }
      const hi = styles.High;
      const lo = styles.Low;
      const med = await badge('MEDIUM').isVisible().catch(() => false) ? await styleOf('MEDIUM') : null;
      observed.push(`HIGH badge bg ${hi.bg}; LOW badge bg ${lo.bg}${med ? `; MEDIUM bg ${med.bg}` : ''}; text ${hi.color}`);
      expect(hi.bg !== lo.bg || hi.color !== lo.color || hi.border !== lo.border, 'HIGH and LOW badges look different').toBe(true);

      // The Analytics dashboard breaks flags down the same way (Critical / High / Pending / Resolved).
      await page.goto('/regulator/analytics', { waitUntil: 'domcontentloaded' });
      const advisory = page.getByText('EPCIS Advisory Violations').locator('xpath=ancestor::*[contains(., "Resolved")][1]');
      await expect(advisory).toBeVisible({ timeout: 20_000 });
      const block = (await advisory.innerText()).replace(/\s+/g, ' ');
      observed.push(`Analytics: "${block.slice(0, 120)}"`);
      for (const k of ['Critical', 'High', 'Pending', 'Resolved']) expect(block).toContain(k);
      expect(block).toContain(String(stats.bySeverity?.HIGH ?? ''));
    } finally {
      recorder(observed)();
    }
  });

  // Reconciliation. A shipment from the manufacturer to KEMSA is listed by BOTH portals (the
  // manufacturer's outbound, KEMSA's incoming), and a return is listed by both too, so the two
  // lists are reconciled as the set of distinct shipments they show (by shipment id), not as the
  // sum of their counts. Each list is read with its scope selector on "All" (forward + returns;
  // the default view is forward only), from the data the page itself loads. The tile must cover
  // that set: at least every distinct forward shipment and at most every distinct shipment
  // including returns - the allowance for returns being classified either way.
  qtest('REG-AN-004', 'Total Shipments tile matches Manufacturer + Distributor shipment lists', async ({ page, browser }) => {
    test.setTimeout(240_000);
    const observed = [];
    try {
      await loginAs(page, 'admin');
      await page.goto('/regulator/analytics', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('Total Shipments').first()).toBeVisible({ timeout: 20_000 });
      await expect.poll(async () => (await page.locator('main').innerText()).replace(/\s+/g, ' '), { timeout: 20_000 }).toMatch(/Shipments by Status.*\d/);
      const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
      const total = Number(text.match(/Total Shipments\s*([\d,]+)/)[1].replace(/,/g, ''));
      const byStatus = (text.match(/Shipments by Status(.*?)EPCIS/) || [])[1]?.trim();
      observed.push(`Analytics Total Shipments ${total} (by status: ${byStatus})`);

      // One role's Shipments page, switched to "All": returns its rows and what its tiles say.
      const readList = async (role, area) => {
        const p = await newRolePage(browser, role).catch((e) => {
          observed.push(`${role} sign-in failed: ${String(e.message).slice(0, 120)}`);
          throw e;
        });
        try {
          const listApi = new RegExp(`/api/${area}/shipments(\\?|$)`);
          const first = p.waitForResponse((r) => listApi.test(r.url()) && r.request().method() === 'GET', { timeout: 30_000 });
          await p.goto(`/${area}/shipments`, { waitUntil: 'domcontentloaded' });
          let res = await first;
          const scope = p.locator('main select').filter({ has: p.locator('option[value=all]') }).filter({ hasText: 'Returns' });
          let scopeLabel = 'default view';
          if (await scope.count()) {
            const all = p.waitForResponse((r) => listApi.test(r.url()) && /scope=all/.test(r.url()), { timeout: 30_000 });
            await scope.first().selectOption('all');
            res = await all;
            scopeLabel = 'All';
          }
          const body = await res.json();
          const rows = Array.isArray(body) ? body : body.shipments || body.data || [];
          // The page's own tiles once the rows are on screen.
          await expect.poll(() => p.locator('main tbody tr').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(Math.min(rows.length, 1));
          const tiles = (await p.locator('main').innerText()).replace(/\s+/g, ' ');
          const tile = Number(((tiles.match(/TOTAL (?:FORWARD )?SHIPMENTS\s*([\d,]+)/i) || [])[1] || 'NaN').replace(/,/g, ''));
          const returns = rows.filter((s) => /return/i.test(String(s.shipment_category || ''))).length;
          observed.push(`${area} list (${scopeLabel}): ${rows.length} shipments (${rows.length - returns} forward, ${returns} returns), page tile ${tile}`);
          return rows;
        } finally {
          await p.context().close();
        }
      };

      const mRows = await readList('manufacturer', 'manufacturer');
      const dRows = await readList('kemsa', 'distributor');

      const byId = new Map();
      for (const s of [...mRows, ...dRows]) byId.set(s.id, s);
      const distinct = [...byId.values()];
      const isReturn = (s) => /return/i.test(String(s.shipment_category || ''));
      const distinctReturns = distinct.filter(isReturn).length;
      const distinctForward = distinct.length - distinctReturns;
      const mIds = new Set(mRows.map((s) => s.id));
      const both = dRows.filter((s) => mIds.has(s.id)).length;
      const dispatched = distinct.filter((s) => s.is_dispatched).length;
      observed.push(
        `raw sum ${mRows.length} + ${dRows.length} = ${mRows.length + dRows.length}, of which ${both} are listed by both; ` +
          `distinct ${distinct.length} (${distinctForward} forward + ${distinctReturns} returns; ${dispatched} dispatched, ${distinct.length - dispatched} not) vs tile ${total}`,
      );
      expect(total, `tile covers every distinct forward shipment (${distinctForward})`).toBeGreaterThanOrEqual(distinctForward);
      expect(total, `tile counts no shipment beyond the distinct shipments both lists show (${distinct.length} incl. returns); ${total - distinct.length} unaccounted`).toBeLessThanOrEqual(distinct.length);
    } finally {
      recorder(observed)();
    }
  });
});
