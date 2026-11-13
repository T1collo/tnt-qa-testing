// Master Data Registry (/master-data/*), signed in as the PPB admin. Workbook sheet
// "Master Data Registry".
//
// Sync buttons ask through window.confirm (and report through window.alert); those are accepted.
// Every sync this file triggers is logged to the Test Data Log as type 'sync'. The owner approved
// syncs for MD-PROD-002 and MD-EDGE-002; MD-FAC-003's own step 1 is a UAT facility sync.
const { test, expect } = require('@playwright/test');
const { qtest } = require('../helpers/qtest');
const { loginAs } = require('../helpers/auth');
const { logEntity } = require('../helpers/datalog');
const { recorder, openCatalog, search, dataRows, columnValues, pickFilter, tileNumber, acceptDialogs, CRASH_TEXT } = require('./master-data.helpers');

const logSync = (testId, what) =>
  logEntity({ type: 'sync', identifier: what, testId, cleanup: 'none - read-only refresh from the source system' });

// Waits for a sync POST and returns { status, json, text }.
async function syncResponse(page, pathPart, click) {
  const wait = page.waitForResponse((r) => r.url().includes(pathPart) && /\/sync\b/.test(r.url()) && r.request().method() === 'POST', { timeout: 60_000 });
  await click();
  const res = await wait;
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status(), json, text };
}

const syncTag = async (page) => {
  const m = (await page.locator('main').innerText()).match(/Sync #\s*(\d+)/i);
  return m ? Number(m[1]) : null;
};

const statsOf = async (page, entity) => (await page.request.get(`/api/master-data/${entity}/stats`)).json();

test.describe('Master Data Registry', () => {
  qtest('MD-PROD-002', '"Sync from Regulatory Authority" triggers a data refresh', async ({ page }) => {
    test.setTimeout(120_000);
    const observed = [];
    const dialogs = [];
    try {
      await openCatalog(page, 'products');
      const before = await syncTag(page);
      observed.push(`sync tag before: ${before === null ? 'none shown' : `#${before}`}`);
      const stop = acceptDialogs(page, dialogs);
      const res = await syncResponse(page, '/products/', () => page.getByRole('button', { name: 'Sync from Regulatory Authority' }).click());
      logSync('MD-PROD-002', 'products: Sync from Regulatory Authority');
      await page.waitForTimeout(2_000);
      stop();
      observed.push(`POST products/sync -> ${res.status} ${res.text.slice(0, 220)}`);
      if (dialogs.length) observed.push(`dialogs: ${dialogs.map((d) => `"${d.slice(0, 140)}"`).join(' / ')}`);

      expect(res.status, 'sync request accepted').toBeLessThan(300);
      expect(res.json?.skipped, `the server must actually start a sync job (reason: ${res.json?.reason})`).not.toBe(true);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
      const after = await syncTag(page);
      observed.push(`sync tag after: ${after === null ? 'none shown' : `#${after}`}`);
      expect(after, 'a "Product Sync #<id>" tag after syncing').not.toBeNull();
      if (before !== null) expect(after, 'sync # increments').toBeGreaterThan(before);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MD-PROD-003', 'Search filters the Product Catalog by name, brand, generic name, or GTIN', async ({ page }) => {
    const observed = [];
    try {
      await openCatalog(page, 'products');
      const total = await tileNumber(page, 'Total Products');
      await search(page).fill('Telmicos');
      await expect
        .poll(async () => {
          const rows = await dataRows(page).allInnerTexts();
          return rows.length > 0 && rows.every((t) => /telmicos/i.test(t));
        }, { timeout: 15_000 })
        .toBe(true);
      const products = await columnValues(page, 'Product');
      observed.push(`"Telmicos": ${products.length} rows of ${total} (${products.map((p) => p.split('\n')[0]).join(', ')})`);
      expect(products.length).toBeLessThan(total || Infinity);

      // A GTIN/registration fragment is not checked here: TrackIQ products carry no GTINs.
      // The generic-name path: Telmicos is telmisartan, which must match by generic name too.
      await search(page).fill('Telmisartan');
      await expect
        .poll(async () => {
          const rows = await dataRows(page).allInnerTexts();
          return rows.length > 0 && rows.every((t) => /telmisartan/i.test(t));
        }, { timeout: 15_000 })
        .toBe(true);
      observed.push(`"Telmisartan" (generic): ${await dataRows(page).count()} matching rows`);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MD-PROD-004', 'Type filter narrows the catalog to a specific product type', async ({ page }) => {
    const observed = [];
    try {
      await openCatalog(page, 'products');
      const allTypes = await columnValues(page, 'Type');
      // Prefer a minority type so the narrowing is visible on page 1.
      const combo = page.getByRole('combobox').filter({ hasText: 'All Types' });
      await combo.click();
      const labels = (await page.getByRole('option').allInnerTexts()).map((t) => t.trim());
      await page.keyboard.press('Escape');
      const pick = labels.indexOf('Supplement') > 0 ? labels.indexOf('Supplement') : 1;
      const chosen = await pickFilter(page, 'All Types', pick);
      await expect.poll(async () => (await columnValues(page, 'Type')).every((t) => t === chosen), { timeout: 15_000 }).toBe(true);
      const types = await columnValues(page, 'Type');
      observed.push(`page 1 types before: [${[...new Set(allTypes)].join(', ')}]; Type = ${chosen}: ${types.length} rows, all "${chosen}"`);
      expect(types.length, `at least one ${chosen} product`).toBeGreaterThan(0);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MD-PROD-006', 'Data Analysis / Data Quality Report / Audit History tabs render distinct views', async ({ page }) => {
    const observed = [];
    try {
      await openCatalog(page, 'products');
      // Each tab is ready once its own panel has rendered its content - not just its heading,
      // which (like the tab button itself, also inside <main>) can show before the data loads.
      // `ready` is the panel content or a known empty state; `api` is the panel's data request.
      const views = [
        { tab: 'Data Analysis', ready: /Distribution and statistical overview|Status Distribution/i },
        { tab: 'Data Quality Report', ready: /Overall Data Quality Score[\s\S]*\d+(\.\d+)?\s*\/\s*100/i, api: /data-quality-report/ },
        {
          tab: 'Audit History',
          ready: /No Quality Audit Data Yet|Audit Snapshot\s+#|\b\d{1,2}\s+\w{3}\s+\d{4}\b|\d{4}-\d{2}-\d{2}/i,
          api: /quality-history/,
        },
      ];
      const seen = [];
      const apiStatus = {};
      for (const v of views) {
        const call = v.api ? page.waitForResponse((r) => v.api.test(r.url()), { timeout: 20_000 }).catch(() => null) : null;
        await page.getByRole('button', { name: v.tab, exact: true }).click();
        const res = call ? await call : null;
        if (res) apiStatus[v.tab] = `${new URL(res.url()).pathname}${new URL(res.url()).search} -> ${res.status()}${res.status() >= 400 ? ` ${(await res.text()).slice(0, 120)}` : ''}`;
        const panel = () => page.locator('main').innerText().then((t) => t.replace(/\s+/g, ' '));
        await expect.poll(panel, { timeout: 20_000, message: `${v.tab} panel content` }).toMatch(v.ready);
        await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
        const body = await panel();
        const view = body.slice(body.indexOf('Audit History') + 'Audit History'.length).trim();
        seen.push(view);
        observed.push(`${v.tab}: "${view.slice(0, 110)}"${apiStatus[v.tab] ? ` [${apiStatus[v.tab]}]` : ''}`);
      }
      // Three different views, not one panel repeated.
      expect(new Set(seen.map((s) => s.slice(0, 200))).size).toBe(3);
      expect(seen[0], 'analysis view shows distributions').toMatch(/Distribution/i);
      expect(seen[1], 'quality report is scored').toMatch(/\d+(\.\d+)?\s*\/\s*100/);
      expect(seen[2], 'audit history view').toMatch(/Audit History/i);
      // A change-history log: the history must actually load. An empty log is acceptable only as
      // the server's answer, not as the fallback for a request the server refused.
      const historyCall = apiStatus['Audit History'] || 'no quality-history request seen';
      expect(historyCall, 'the Audit History tab loads its history without an error').toMatch(/-> [23]\d\d$/);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MD-PREM-002', 'Premise filters narrow by Business Type, Constituency, and Ward', async ({ page }) => {
    test.setTimeout(120_000);
    const observed = [];
    try {
      await openCatalog(page, 'premise-data').catch((e) => {
        observed.push(e.message);
        throw e;
      });
      const rowsBefore = await dataRows(page).count();
      const totalBefore = await tileNumber(page, 'Total');
      observed.push(`page loads, ${rowsBefore} rows (total ${totalBefore})`);

      const changed = async (fn) => {
        const res = page.waitForResponse((r) => /\/premises\?/.test(r.url()) && r.request().method() === 'GET', { timeout: 15_000 }).catch(() => null);
        const label = await fn();
        const r = await res;
        const body = r ? await r.json().catch(() => null) : null;
        return { label, url: r?.url() || '', total: body?.total ?? null, rows: body?.premises || [] };
      };

      const bt = await changed(() => pickFilter(page, 'All Business Types'));
      expect(bt.label, 'an "All Business Types" filter').not.toBeNull();
      observed.push(`Business Type = ${bt.label}: total ${bt.total}`);
      expect(bt.rows.every((p) => String(p.business_type).toUpperCase() === bt.label.toUpperCase()), 'every premise has that business type').toBe(true);

      const co = await changed(() => pickFilter(page, 'All Constituencies'));
      expect(co.label, 'an "All Constituencies" filter').not.toBeNull();
      observed.push(`+ Constituency = ${co.label}: total ${co.total}`);
      expect(co.rows.every((p) => String(p.constituency).toUpperCase() === co.label.toUpperCase() && String(p.business_type).toUpperCase() === bt.label.toUpperCase()), 'combination applies both filters').toBe(true);

      const wa = await changed(() => pickFilter(page, 'All Wards'));
      expect(wa.label, 'an "All Wards" filter').not.toBeNull();
      observed.push(`+ Ward = ${wa.label}: total ${wa.total}`);
      expect(wa.rows.every((p) => String(p.ward).toUpperCase() === wa.label.toUpperCase()), 'every premise is in that ward').toBe(true);
      if (bt.total !== null && wa.total !== null) expect(wa.total).toBeLessThanOrEqual(bt.total);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MD-FAC-003', 'Facility UAT and Production data sets sync independently', async ({ page }) => {
    test.setTimeout(120_000);
    const observed = [];
    const dialogs = [];
    try {
      await openCatalog(page, 'facility-uat-data');
      const uatBefore = await statsOf(page, 'uat-facilities');
      const prodBefore = await statsOf(page, 'prod-facilities');
      observed.push(`before: UAT lastSync ${uatBefore.lastSync} (${uatBefore.total}), Prod lastSync ${prodBefore.lastSync} (${prodBefore.total})`);

      // 1. Sync UAT only.
      const stop = acceptDialogs(page, dialogs);
      const res = await syncResponse(page, '/uat-facilities/', () => page.getByRole('button', { name: 'Sync from Safaricom HIE', exact: true }).click());
      logSync('MD-FAC-003', 'facility-uat: Sync from Safaricom HIE');
      await page.waitForTimeout(3_000);
      stop();
      observed.push(`POST uat-facilities/sync -> ${res.status} ${res.text.slice(0, 200)}`);

      // 2. Production is untouched.
      const uatAfter = await statsOf(page, 'uat-facilities');
      const prodAfter = await statsOf(page, 'prod-facilities');
      observed.push(`after: UAT lastSync ${uatAfter.lastSync}, Prod lastSync ${prodAfter.lastSync} (${prodAfter.total})`);
      expect(prodAfter.lastSync, 'Production Last Synced unchanged by a UAT sync').toBe(prodBefore.lastSync);
      expect(prodAfter.total, 'Production row count unchanged').toBe(prodBefore.total);

      // Isolation is only demonstrated if the UAT sync really ran.
      expect(res.json?.skipped, `UAT sync must actually run for isolation to be shown (server: ${res.json?.reason})`).not.toBe(true);
      expect(uatAfter.lastSync, 'UAT Last Synced moved').not.toBe(uatBefore.lastSync);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MD-PRAC-002', 'Practitioner filters narrow by Cadre, County, and License Status', async ({ page }) => {
    const observed = [];
    try {
      await openCatalog(page, 'practitioner-data');
      const filters = [
        { all: 'All Cadres', column: 'Cadre' },
        { all: 'All Counties', column: 'County' },
        { all: 'All License Statuses', column: 'License Status' },
      ];
      const missing = [];
      for (const f of filters) {
        const chosen = await pickFilter(page, f.all);
        if (chosen === null) {
          missing.push(f.all);
          continue;
        }
        await expect.poll(async () => (await columnValues(page, f.column)).every((v) => v.toUpperCase() === chosen.toUpperCase()), { timeout: 15_000 }).toBe(true);
        observed.push(`${f.column} = ${chosen}: ${await dataRows(page).count()} rows`);
      }
      if (missing.length) observed.push(`filters not on the page: ${missing.join(', ')} (only search and page size are offered)`);
      expect(missing, 'Cadre / County / License Status filters present').toEqual([]);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MD-MFR-002', 'Manufacturers Approval Status reflects PPB approval state', async ({ page }) => {
    const observed = [];
    try {
      await openCatalog(page, 'manufacturer-data');
      const tile = await tileNumber(page, 'Approved');
      await search(page).fill('Test Manufacturer');
      const empty = page.getByText(/No manufacturers found/i);
      await expect(dataRows(page).first().or(empty)).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await dataRows(page).allInnerTexts()).every((t) => /test manufacturer/i.test(t)), { timeout: 15_000 }).toBe(true);
      const statuses = await columnValues(page, 'Approval Status');
      observed.push(`"Approved" tile = ${tile}; search "Test Manufacturer": ${statuses.length ? statuses.join(', ') : 'No manufacturers found'}`);
      expect(statuses.length, 'Test Manufacturer is in the PPB manufacturer catalogue').toBeGreaterThan(0);
      // Test Manufacturer is an approved, onboarded manufacturer (it signs in and batches).
      expect(statuses.every((s) => /approved/i.test(s)), 'Approval Status = Approved').toBe(true);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MD-DQ-003', 'Data Quality Report reflects the documented scoring methodology', async ({ page }) => {
    const observed = [];
    try {
      await openCatalog(page, 'products');
      const catalogTotal = await tileNumber(page, 'Total Products');
      await page.getByRole('button', { name: 'Data Quality Report', exact: true }).click();
      const main = page.locator('main');
      await expect(main.getByText('Overall Data Quality Score')).toBeVisible({ timeout: 20_000 });
      const text = (await main.innerText()).replace(/\s+/g, ' ');
      const report = text.slice(text.indexOf('Overall Data Quality Score'));
      const overall = Number((report.match(/([\d.]+)\s*\/\s*100/) || [])[1]);
      const dim = (name) => {
        const m = report.match(new RegExp(`${name}\\s+(N/A|[\\d.]+%?)`, 'i'));
        return m ? m[1] : null;
      };
      const parts = { Completeness: dim('Completeness'), Validity: dim('Validity'), Consistency: dim('Consistency'), Timeliness: dim('Timeliness') };
      const reportTotal = Number(((report.match(/Total Products\s*([\d,]+)/i) || [])[1] || '').replace(/,/g, ''));
      observed.push(`catalog ${catalogTotal} products; report: overall ${overall}/100, Total Products ${reportTotal}, ${Object.entries(parts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      const note = (await page.request.get('/api/master-data/products/data-quality-report').then((r) => r.json()).catch(() => null))?.overview?.note;
      if (note) observed.push(`API note: "${note}"`);

      expect(reportTotal, 'the report covers the catalog\'s records').toBe(catalogTotal);
      for (const [k, v] of Object.entries(parts)) expect(v, `${k} is scored`).toMatch(/^[\d.]+%?$/);
      const pct = (v) => Number(String(v).replace('%', ''));
      const expected = 0.4 * pct(parts.Completeness) + 0.3 * pct(parts.Validity) + 0.15 * pct(parts.Consistency) + 0.15 * pct(parts.Timeliness);
      observed.push(`formula 0.4C+0.3V+0.15Cn+0.15T = ${expected.toFixed(1)}`);
      expect(Math.abs(expected - overall), 'overall score follows the documented weights').toBeLessThanOrEqual(1);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MD-TERM-002', 'Terminology search works per code system (RxNorm "amoxicillin")', async ({ page }) => {
    const observed = [];
    try {
      await loginAs(page, 'admin');
      await page.goto('/master-data', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('link', { name: 'Product Catalog' }).first()).toBeVisible({ timeout: 20_000 });
      const terminology = page.getByRole('button', { name: /^Terminology/ }).or(page.getByRole('link', { name: /^Terminology/ }));
      const hasMenu = (await terminology.count()) > 0;
      const navItems = (await page.locator('aside, nav').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      observed.push(hasMenu ? 'Terminology menu present' : `no Terminology entry in the Master Data nav (${navItems.slice(0, 160)})`);
      expect(hasMenu, 'Master Data offers a Terminology menu').toBe(true);

      await terminology.first().click();
      await page.getByRole('link', { name: /RxNorm/ }).first().click();
      const box = page.getByPlaceholder(/RxCUI or drug name/i);
      await expect(box).toBeVisible({ timeout: 20_000 });
      await box.fill('amoxicillin');
      await expect.poll(async () => {
        const rows = await dataRows(page).allInnerTexts();
        return rows.length > 0 && rows.every((t) => /amoxicillin/i.test(t));
      }, { timeout: 15_000 }).toBe(true);
      observed.push(`RxNorm "amoxicillin": ${await dataRows(page).count()} matching rows`);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MD-EDGE-001', 'Search with no matches shows an empty state on every catalog page', async ({ page }) => {
    test.setTimeout(180_000);
    const observed = [];
    const failures = [];
    try {
      await loginAs(page, 'admin');
      // Every catalog in the Master Data nav. Terminology pages are not on TrackIQ (see MD-TERM-002).
      const slugs = ['products', 'packages', 'premise-data', 'facility-uat-data', 'facility-prod-data', 'practitioner-data', 'manufacturer-data'];
      for (const slug of slugs) {
        try {
          await openCatalog(page, slug, { login: false });
          await search(page).fill('zzznonexistentzzz');
          const empty = page.locator('main').getByText(/^No .* found$|No results|No matching|Nothing found/i).first();
          await expect(empty, `${slug}: empty-state message`).toBeVisible({ timeout: 15_000 });
          await expect(dataRows(page)).toHaveCount(0);
          observed.push(`${slug}: "${(await empty.innerText()).trim()}"`);
        } catch (e) {
          failures.push(slug);
          observed.push(`${slug}: ${String(e.message).split('\n')[0].slice(0, 160)}`);
        }
      }
      expect(failures, 'pages without a clean empty state').toEqual([]);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MD-EDGE-002', 'Rapid double-click on a sync button is handled gracefully', async ({ page }) => {
    test.setTimeout(120_000);
    const observed = [];
    const dialogs = [];
    try {
      await openCatalog(page, 'products');
      const totalBefore = await tileNumber(page, 'Total Products');
      const posts = [];
      page.on('response', (r) => {
        if (/\/products\/sync\b/.test(r.url()) && r.request().method() === 'POST') posts.push(r);
      });
      const stop = acceptDialogs(page, dialogs);
      const btn = page.getByRole('button', { name: 'Sync from Regulatory Authority' });
      // Two clicks back to back, before the first sync can finish.
      await btn.evaluate((b) => {
        b.click();
        b.click();
      });
      logSync('MD-EDGE-002', 'products: Sync from Regulatory Authority x2 (rapid double-click)');
      await expect.poll(() => posts.length, { timeout: 30_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(5_000);
      stop();
      const results = await Promise.all(posts.map(async (r) => `${r.status()} ${(await r.text().catch(() => '')).slice(0, 140)}`));
      observed.push(`${posts.length} sync POST(s): ${results.join(' | ')}`);
      expect(posts.every((r) => r.status() < 500), 'no server error from overlapping syncs').toBe(true);

      // No corrupted state: the page still renders and the catalog total is intact.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
      const totalAfter = await tileNumber(page, 'Total Products');
      const inserted = (await Promise.all(posts.map((r) => r.json().catch(() => ({}))))).reduce((n, j) => n + (j.inserted || 0), 0);
      observed.push(`Total Products ${totalBefore} -> ${totalAfter} (inserted ${inserted})`);
      expect(totalAfter).toBe(totalBefore + inserted);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MD-EDGE-003', 'Pagination through 5 pages shows distinct, non-overlapping rows', async ({ page }) => {
    test.setTimeout(120_000);
    const observed = [];
    try {
      await openCatalog(page, 'products');
      const ids = async () => (await columnValues(page, 'ETCD ID')).filter(Boolean);
      const pages = [];
      for (let n = 1; n <= 5; n++) {
        if (n > 1) {
          const prevFirst = pages[pages.length - 1][0];
          await page.getByRole('button', { name: String(n), exact: true }).click();
          await expect.poll(async () => (await ids())[0], { timeout: 15_000 }).not.toBe(prevFirst);
        }
        const rows = await ids();
        pages.push(rows);
        observed.push(`p${n}: ${rows.length} rows ${rows[0]}..${rows[rows.length - 1]}`);
      }
      const all = pages.flat();
      const dupes = all.filter((id, i) => all.indexOf(id) !== i);
      observed.push(`${all.length} ids, ${new Set(all).size} distinct`);
      expect(dupes, 'no row appears on two pages').toEqual([]);
      for (const p of pages.slice(0, 4)) expect(p.length, 'full pages').toBe(pages[0].length);
    } finally {
      recorder(observed)();
    }
  });
});
