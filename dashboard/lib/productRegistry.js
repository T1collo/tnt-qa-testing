// The real product catalogue, read from data/products.csv, plus the GS1 conversion needed to
// turn a GTIN into a usable SGTIN EPC URI.
//
// This exists so the suite can build a valid consignment on its own. Previously the only
// product identifier in play was the collection's hard-coded (and malformed)
// urn:epc:id:sgtin:6161102974997.CW2278, which is why every run drew UNKNOWN_SGTIN.
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./paths');

const CATALOGUE_PATH = path.join(PROJECT_ROOT, 'data', 'products.csv');

// GS1 company prefixes vary in length (7-10 digits) and the authoritative length only comes
// from GS1's own registry, which we do not have. Seven is the most common allocation and, as
// the audit established, the platform validates that companyPrefix + itemRef totals 13
// digits rather than checking the split itself - so a 7-digit split is both conventional and
// accepted. Documented here rather than buried, because it IS an assumption.
const ASSUMED_GCP_LENGTH = 7;

// Standard GS1 modulo-10 check digit, computed over the digits to the left of the check.
function gs1CheckDigit(digitsWithoutCheck) {
  let sum = 0;
  // Weights alternate 3,1 reading right-to-left from the position next to the check digit.
  for (let i = digitsWithoutCheck.length - 1, weight = 3; i >= 0; i -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(digitsWithoutCheck[i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

function isValidGtin(gtin) {
  if (!/^\d{8}$|^\d{12,14}$/.test(gtin)) return false;
  const body = gtin.slice(0, -1);
  return gs1CheckDigit(body) === Number(gtin.slice(-1));
}

/**
 * GTIN -> the SGTIN prefix an EPC URI needs, i.e. everything before the serial.
 *
 * A GTIN-14 is indicator + 12 body digits + check. An SGTIN URI is
 * `urn:epc:id:sgtin:<companyPrefix>.<indicator+itemRef>.<serial>`, so the indicator moves to
 * the front of the item reference and the check digit is dropped entirely.
 */
function sgtinPrefix(gtin, gcpLength = ASSUMED_GCP_LENGTH) {
  const gtin14 = String(gtin).padStart(14, '0');
  const indicator = gtin14[0];
  const body = gtin14.slice(1, 13); // 12 digits, check digit dropped
  const companyPrefix = body.slice(0, gcpLength);
  const itemRef = indicator + body.slice(gcpLength);
  return `urn:epc:id:sgtin:${companyPrefix}.${itemRef}`;
}

// Minimal CSV reader: handles the quoted fields this file actually uses (product names carry
// commas) without pulling in a parser dependency.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

let cache = null;
let cacheMtime = null;

function loadProducts() {
  const { mtimeMs } = fs.statSync(CATALOGUE_PATH);
  if (cache && mtimeMs === cacheMtime) return cache;

  const rows = parseCsv(fs.readFileSync(CATALOGUE_PATH, 'utf-8'));
  const [header, ...body] = rows;
  const col = Object.fromEntries(header.map((name, i) => [name.trim(), i]));

  cache = body.map((r) => {
    const gtin = (r[col.gtin] || '').trim();
    return {
      productId: (r[col.etcd_product_id] || '').trim(),
      genericCode: (r[col.generic_concept_code] || '').trim(),
      brand: (r[col.brand_display_name] || '').trim(),
      generic: (r[col.generic_display_name] || '').trim(),
      gtin,
      packageCode: (r[col.package_code] || '').trim(),
      packageName: (r[col.package_name] || '').trim(),
      gtinValid: isValidGtin(gtin),
      sgtinPrefix: sgtinPrefix(gtin),
    };
  });
  cacheMtime = mtimeMs;
  return cache;
}

// Products safe to build a consignment from: a GTIN that passes its own check digit.
function usableProducts() {
  return loadProducts().filter((p) => p.gtinValid);
}

function findProduct(productIdOrGtin) {
  if (!productIdOrGtin) return null;
  const all = loadProducts();
  return (
    all.find((p) => p.gtin === String(productIdOrGtin)) ||
    all.find((p) => p.productId === String(productIdOrGtin)) ||
    null
  );
}

// A deterministic default so a run with no product chosen still uses a real, valid GTIN.
function defaultProduct() {
  const usable = usableProducts();
  return usable.find((p) => p.gtin === '6161102974997') || usable[0] || null;
}

module.exports = {
  ASSUMED_GCP_LENGTH,
  CATALOGUE_PATH,
  gs1CheckDigit,
  isValidGtin,
  sgtinPrefix,
  loadProducts,
  usableProducts,
  findProduct,
  defaultProduct,
};
