// Shared plumbing for the TrackIQ partner-portal specs.
//
// A certification case is proven end to end: an event is submitted through the partner API
// with a sandbox key, then the portal is checked in the browser - the API Logs page must list
// that exact eventID, and the Certification page must show the case Passed with its attempt
// count moved on (every case already reads Passed, so the count is what proves this run's
// submission was the one that counted).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('@playwright/test');
const {
  loadCollection,
  findNode,
  freshenEventIds,
  freshenBusinessData,
} = require('../../dashboard/lib/postmanRunner');

const PORTAL = (process.env.TRACKIQ_BASE_URL || 'https://trackiq.apeiro-digital.com').replace(/\/+$/, '');
const AUTH_FILE = path.join(__dirname, '..', '..', 'playwright', '.auth', 'partner-facility.json');

// One partner account per role. The facility .env key names carry a typo (FASCILITY, EMAL)
// that is accepted alongside the correct spelling so either works.
const PARTNER_ACCOUNTS = {
  manufacturer: {
    email: process.env.TRACKIQ_MANUFACTURER_PARTNER_EMAIL,
    password: process.env.TRACKIQ_MANUFACTURER_PARTNER_PASSWORD,
  },
  distributor: {
    email: process.env.TRACKIQ_DISTRIBUTOR_PARTNER_EMAIL,
    password: process.env.TRACKIQ_DISTRIBUTOR_PARTNER_PASSWORD,
  },
  facility: {
    email: process.env.TRACKIQ_FACILITY_PARTNER_EMAIL || process.env.TRACKIQ_FASCILITY_PARTNER_EMAL,
    password: process.env.TRACKIQ_FACILITY_PARTNER_PASSWORD || process.env.TRACKIQ_FASCILITY_PARTNER_PASSWORD,
  },
};
const FACILITY_LOGIN = PARTNER_ACCOUNTS.facility;

// Runs a Turnstile-gated form flow (partner-flows.js) in its own process and returns its JSON.
// A sign-in that never got an answer (status null - Turnstile slow after several sign-ins in a
// row) is tried once more; a refusal is a real answer and is returned as is.
function partnerFlow(flow, args) {
  const first = partnerFlowOnce(flow, args);
  return flow === 'login' && !first.ok && first.status == null ? partnerFlowOnce(flow, args) : first;
}

function partnerFlowOnce(flow, args) {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'partner-flows.js'), flow, JSON.stringify(args)], {
    encoding: 'utf-8',
    timeout: 120_000,
  });
  const line = String(run.stdout || '').trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, error: (run.stderr || run.stdout || 'flow process failed').trim() };
  }
}

const sessionFile = (role) => path.join(__dirname, '..', '..', 'playwright', '.auth', `partner-${role}.json`);

async function sessionValid(requestCtx) {
  const res = await requestCtx.get(`${PORTAL}/api/partners/certification/status?_=${Date.now()}`);
  return res.status() === 200;
}

// A browser context signed in as the `role` partner: the saved session when the portal still
// accepts it, otherwise a fresh sign-in (one Turnstile-gated flow) that is then saved.
async function partnerContext(browser, role) {
  const account = PARTNER_ACCOUNTS[role];
  if (!account?.email || !account?.password) throw new Error(`No ${role} partner account in .env`);
  const file = sessionFile(role);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (fs.existsSync(file)) {
      const context = await browser.newContext({ storageState: file, viewport: { width: 1440, height: 900 } });
      if (await sessionValid(context.request)) return context;
      await context.close();
    }
    const result = partnerFlow('login', { email: account.email, password: account.password, out: file });
    if (!result.ok) throw new Error(`${role} partner sign-in failed: ${result.message || result.error || result.status}`);
  }
  throw new Error(`${role} partner session was not accepted after signing in`);
}

const FACILITY_KEY = process.env.TRACKIQ_FACILITY_API_TOKEN;

const ENDPOINTS = {
  facility: `${PORTAL}/api/integration/facility/events`,
  dispense: `${PORTAL}/api/integration/facility/events/dispense`,
};

// A collection request rendered with fresh serials, SSCCs, eventIDs and timestamps, so the
// platform judges it on validity rather than rejecting it as a duplicate.
function buildEvent(collectionPath, variant) {
  const node = findNode(loadCollection().item, [...collectionPath, variant]);
  if (!node) throw new Error(`Collection request not found: ${[...collectionPath, variant].join(' > ')}`);
  const body = freshenBusinessData(freshenEventIds(node.request.body.raw));
  const eventIds = [...new Set(body.match(/urn:uuid:[0-9A-Za-z-]+/g) || [])];
  const contentType = variant === 'XML' ? 'application/xml' : 'application/ld+json';
  return { body, eventIds, contentType };
}

async function submit(endpoint, { body, contentType }) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'X-API-Key': FACILITY_KEY },
    body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body - kept as text
  }
  return { status: res.status, json, text };
}

// The portal's own certification state, read with the browser session's cookies.
async function certificationStatus(page) {
  const res = await page.request.get(`${PORTAL}/api/partners/certification/status?_=${Date.now()}`);
  expect(res.status(), 'certification status needs a signed-in partner session').toBe(200);
  return res.json();
}

function stepOf(status, stepId) {
  const step = (status.steps || []).find((s) => s.step_id === stepId);
  if (!step) throw new Error(`Certification step ${stepId} not found (have: ${(status.steps || []).map((s) => s.step_id).join(', ')})`);
  return step;
}

// Polls until the step has recorded at least `minAttempts` attempts. Ingestion is async, so
// the count can trail the 202 by a few seconds.
async function waitForAttempts(page, stepId, minAttempts, timeoutMs = 45_000) {
  let step;
  await expect
    .poll(
      async () => {
        step = stepOf(await certificationStatus(page), stepId);
        return step.attempts;
      },
      { timeout: timeoutMs, intervals: [1_000, 2_000, 3_000] }
    )
    .toBeGreaterThanOrEqual(minAttempts);
  return step;
}

// API Logs page: filter by eventID and expect exactly that submission's row.
async function expectInApiLogs(page, eventId, outcome) {
  await page.goto(`${PORTAL}/partners/logs`, { waitUntil: 'domcontentloaded' });
  // Wait for the page to hydrate first: a click on Filters before then is silently dropped.
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 20_000 });
  const filters = page.getByRole('button', { name: /Filters/ });
  const eventField = page.getByPlaceholder(/^urn:uuid:/);
  await expect(async () => {
    if (!(await eventField.isVisible())) await filters.click();
    await expect(eventField).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await eventField.fill(eventId);
  await page.getByRole('button', { name: 'Apply' }).click();
  const row = page.locator('tbody tr').filter({ hasText: eventId });
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  if (outcome) await expect(row).toContainText(outcome);
  return row;
}

// The portal's log entry for one eventID (the row shows only a warning count; the codes are
// in the entry's response summary).
async function logEntry(page, eventId) {
  const res = await page.request.get(`${PORTAL}/api/partners/logs?eventId=${encodeURIComponent(eventId)}`);
  expect(res.status()).toBe(200);
  const json = await res.json();
  const items = json.items || json.data || json.logs || (Array.isArray(json) ? json : []);
  return items[0] || null;
}

// Certification page: the case card for `stepName` reads Passed.
async function expectCasePassed(page, stepName) {
  await page.goto(`${PORTAL}/partners/certification`, { waitUntil: 'domcontentloaded' });
  const card = page.getByRole('button', { name: new RegExp(escapeRegExp(stepName)) }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText('Passed', { exact: true })).toBeVisible();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  PORTAL,
  AUTH_FILE,
  FACILITY_LOGIN,
  PARTNER_ACCOUNTS,
  partnerFlow,
  partnerContext,
  sessionFile,
  FACILITY_KEY,
  ENDPOINTS,
  buildEvent,
  submit,
  certificationStatus,
  stepOf,
  waitForAttempts,
  expectInApiLogs,
  expectCasePassed,
  logEntry,
};
