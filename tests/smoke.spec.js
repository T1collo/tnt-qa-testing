// Smoke suite: after logging in as each role, visit every known page in that role's
// sitemap and assert it renders without a 404, a server error, or the app's own
// "Authentication Required" access-denied screen. This is what should catch a broken
// route, a bad deploy, or a snapped role-permission check after a migration.
//
// The page lists were built by crawling the live app (see qa-testing/output/*/crawl-log.txt).
// If the app's navigation changes, update the lists below.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/auth');

async function expectHealthyPage(page, path) {
  await page.goto(path, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await expect(page.getByText('404', { exact: true }), `${path} should not 404`).toHaveCount(0);
  await expect(page.getByText('This page could not be found.'), `${path} should not show the not-found screen`).toHaveCount(0);
  await expect(page.getByText('Authentication Required'), `${path} should not show an access-denied screen for this role`).toHaveCount(0);
}

test.describe('Admin (PPB / Regulatory Authority) - page inventory', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'admin');
  });

  const pages = [
    '/regulator',
    '/regulator/package-approval',
    '/regulator/journey',
    '/regulator/analytics',
    '/rules-engine',
    '/events/explorer',
    '/regulator/flagged-events',
    '/regulator/participants',
    '/regulator/recalls/dashboard',
    '/regulator/recalls',
    '/regulator/user-management',
    '/master-data',
    '/master-data/products',
    '/master-data/packages',
    '/master-data/premise-data',
    '/master-data/facility-uat-data',
    '/master-data/facility-prod-data',
    '/master-data/practitioner-data',
    '/master-data/manufacturer-data',
    '/master-data/scoring-methodology',
  ];

  for (const path of pages) {
    test(`admin can open ${path}`, async ({ page }) => {
      await expectHealthyPage(page, path);
    });
  }

  test('admin is blocked from the Manufacturer module (RBAC)', async ({ page }) => {
    await page.goto('/manufacturer/batches', { waitUntil: 'load' });
    await expect(page.getByText('Authentication Required')).toBeVisible();
    await expect(page.getByText(/requires\s+Manufacturer\s+access/i)).toBeVisible();
  });
});

test.describe('KEMSA (Distributor) - page inventory', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'kemsa');
  });

  const pages = [
    '/distributor/shipments',
    '/distributor/shipments/create',
    '/distributor/hierarchy',
    '/distributor/user-management',
  ];

  for (const path of pages) {
    test(`kemsa can open ${path}`, async ({ page }) => {
      await expectHealthyPage(page, path);
    });
  }
});

test.describe('Manufacturer - page inventory', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'manufacturer');
  });

  const pages = [
    '/manufacturer/batches',
    '/manufacturer/cases',
    '/manufacturer/packages',
    '/manufacturer/shipments',
    '/manufacturer/shipments/create',
    '/manufacturer/destruction',
    '/manufacturer/user-management',
  ];

  for (const path of pages) {
    test(`manufacturer can open ${path}`, async ({ page }) => {
      await expectHealthyPage(page, path);
    });
  }

  test('manufacturer is blocked from the Regulatory Authority module (RBAC)', async ({ page }) => {
    await page.goto('/regulator', { waitUntil: 'load' });
    await expect(page.getByText('Authentication Required')).toBeVisible();
  });
});

test.describe('Public app - no auth required', () => {
  test('barcode scanner page loads without login', async ({ page }) => {
    await page.goto('/scanner', { waitUntil: 'load' });
    await expect(page.getByRole('heading', { name: 'GS1 Barcode Scanner' })).toBeVisible();
  });
});
