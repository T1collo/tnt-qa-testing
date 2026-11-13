// Helpers for the Master Data Registry spec (/master-data/*, signed in as the PPB admin).
const { test, expect } = require('@playwright/test');
const { loginAs } = require('../helpers/auth');

// Records `observed` as the workbook's Actual Result and echoes it to the list reporter.
function recorder(observed) {
  return () => {
    test.info().annotations.push({ type: 'actual', description: observed.join('; ') });
    console.log(`[actual] ${test.info().title}: ${observed.join('; ')}`);
  };
}

const CRASH_TEXT = /This page couldn.t load|Application error|Something went wrong|Internal Server Error/i;

// Opens a catalog page and waits for its table (or its own empty state) to render. Fails with
// a clear message when the page crashes into the framework error screen.
async function openCatalog(page, slug, { login = true } = {}) {
  if (login) await loginAs(page, 'admin');
  const errors = [];
  const onError = (e) => errors.push(e.message);
  page.on('pageerror', onError);
  await page.goto(`/master-data/${slug}`, { waitUntil: 'domcontentloaded' });
  const ready = page.locator('tbody tr').first().or(page.getByText(CRASH_TEXT).first());
  await ready.waitFor({ timeout: 30_000 }).catch(() => {});
  // Premise Data renders its first rows and then crashes once the filter options arrive, so
  // give the page a moment before trusting it.
  await page.waitForTimeout(2_500);
  page.off('pageerror', onError);
  const crashed = await page.getByText(CRASH_TEXT).first().isVisible().catch(() => false);
  if (crashed) {
    throw new Error(`/master-data/${slug} crashed: "${(await page.getByText(CRASH_TEXT).first().innerText()).trim()}"${errors.length ? ` (page error: ${errors[0]})` : ''}`);
  }
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
}

const search = (page) => page.locator('main').getByPlaceholder(/^Search/).first();

const dataRows = (page) => page.locator('tbody tr').filter({ has: page.locator('td:nth-child(2)') });

async function columnIndex(page, name) {
  const headers = (await page.locator('thead th').allInnerTexts()).map((h) => h.trim().toLowerCase());
  const i = headers.findIndex((h) => h === name.toLowerCase());
  if (i < 0) throw new Error(`Column "${name}" not found (have: ${headers.join(' | ')})`);
  return i;
}

async function columnValues(page, name) {
  const i = await columnIndex(page, name);
  return (await dataRows(page).locator(`td:nth-child(${i + 1})`).allInnerTexts()).map((t) => t.trim());
}

// A filter control whose "all" choice reads `allLabel` (e.g. "All Types", "All Counties").
// Handles both native <select> and Radix comboboxes. Picks option `nth` (1 = first real value)
// and returns its label, or null when no such filter exists on the page.
async function pickFilter(page, allLabel, nth = 1) {
  const native = page.locator('main select').filter({ has: page.locator('option', { hasText: allLabel }) });
  if (await native.count()) {
    const labels = await native.first().locator('option').allInnerTexts();
    if (labels.length <= nth) throw new Error(`Filter "${allLabel}" has no option #${nth} (${labels.join(', ')})`);
    await native.first().selectOption({ index: nth });
    return labels[nth].trim();
  }
  const combo = page.getByRole('combobox').filter({ hasText: allLabel });
  if (!(await combo.count())) return null;
  await combo.first().click();
  const options = page.getByRole('option');
  await expect(options.first()).toBeVisible();
  const labels = await options.allInnerTexts();
  if (labels.length <= nth) throw new Error(`Filter "${allLabel}" has no option #${nth} (${labels.join(', ')})`);
  await options.nth(nth).click();
  return labels[nth].trim();
}

// The first number shown under a stat tile label, e.g. "Total Products 11858".
async function tileNumber(page, label) {
  const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  const m = text.match(new RegExp(`${label}\\s*([\\d,]+)`, 'i'));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// Accepts every window.confirm/alert the page raises (the sync buttons use both) and keeps the
// messages for the Actual Result.
function acceptDialogs(page, sink) {
  const handler = (d) => {
    sink.push(d.message().replace(/\s+/g, ' ').trim());
    d.accept().catch(() => {});
  };
  page.on('dialog', handler);
  return () => page.off('dialog', handler);
}

module.exports = { recorder, openCatalog, search, dataRows, columnIndex, columnValues, pickFilter, tileNumber, acceptDialogs, CRASH_TEXT };
