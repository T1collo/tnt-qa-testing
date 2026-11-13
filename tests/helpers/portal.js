// Shared steps for the Manufacturer portal's Create Batch form, used by the lifecycle spec and
// by scripts/portal/create-batches.cjs (the dashboard's "create batches in the portal" step).

// The portal and data/products.csv can differ only by leading zeros (GTIN-13 vs GTIN-14).
const sameGtin = (a, b) => String(a).replace(/^0+/, '') === String(b).replace(/^0+/, '');

async function selectProduct(page, productName) {
  await page.locator('text=Search by brand name, generic name...').first().click();
  const search = page.getByPlaceholder('Type to search products...');
  await search.fill(productName);
  // Scoped to the dropdown: the same name also appears in the batches table behind the modal.
  const option = search.locator('../..').getByText(productName, { exact: true }).first();
  await option.waitFor({ timeout: 10_000 }).catch(() => {
    throw new Error(`Product "${productName}" was not found in the portal's product search`);
  });
  await option.click();
}

// Picks the package whose GTIN matches `gtin`, or the first package with any GTIN when `gtin`
// is omitted. Packages without a GTIN are rejected server-side, so they are never chosen.
async function selectPackage(page, gtin = null) {
  const combo = page.locator('text=Select package size...');
  await page.waitForTimeout(600);
  if (!(await combo.count())) return; // single-package products are selected automatically
  await combo.first().click();
  // Scoped to the open dropdown: "GTIN: ..." also appears in the batches table behind the
  // modal, and matching there picks an element the modal covers (only once the table loads).
  const dropdown = page.getByPlaceholder('Type to search packages...').locator('xpath=../..');
  const withGtin = dropdown.locator('text=/^GTIN: \\d+/');
  await withGtin.first().waitFor({ timeout: 5_000 }).catch(() => {
    throw new Error('No package of this product has a GTIN in the portal, so it cannot be batched');
  });
  const labels = await withGtin.allTextContents();
  const index = gtin ? labels.findIndex((t) => sameGtin(t.match(/GTIN:\s*(\d+)/)[1], gtin)) : 0;
  if (index < 0) {
    throw new Error(`No package with GTIN ${gtin} for this product (portal offers: ${labels.join('; ')})`);
  }
  // Click the whole option row: its size label sits on top of the GTIN line and takes the click.
  await withGtin.nth(index).locator('xpath=..').click();
}

module.exports = { selectProduct, selectPackage, sameGtin };
