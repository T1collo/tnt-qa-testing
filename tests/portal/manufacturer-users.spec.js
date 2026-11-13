// Manufacturer > System Management > User Management (workbook sheet "Manufacturer - UI").
//
// MFG-USER-001 creates a QA-AUTO sub-user; MFG-USER-002 deactivates and reactivates a QA-AUTO
// user (that one, or an earlier QA-AUTO user found in the table). Every user created is logged
// to the Test Data Log for cleanup (deactivate it in Manufacturer > System Management > User
// Management).
//
// Live form, as mapped on TrackIQ: the labels are not bound to their inputs, so fields are
// found by placeholder. The password fields enforce 12 characters (minLength + helper text
// "Must be at least 12 characters long") while their placeholder still reads "Minimum 8
// characters", and the server additionally requires upper, lower, digit and special character.
const { test, expect } = require('@playwright/test');
const { qtest } = require('../helpers/qtest');
const { loginAs } = require('../helpers/auth');
const { logEntity } = require('../helpers/datalog');

const PATH = '/manufacturer/user-management';
const STAMP = Date.now();
// Upper, lower, digits and specials, nothing sequential - the server rejects weak passwords.
const STRONG_PASSWORD = `Qa#Tr4ck!${STAMP.toString(36)}Zw`;

// Set by MFG-USER-001. Later tests fall back to any QA-AUTO user in the table, because a failed
// test restarts the worker and resets module state.
let created = null;

const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w+/;

// Email of a QA-AUTO user listed in the table (optionally with a given status), preferring the
// one MFG-USER-001 created.
async function qaUserEmail(page, status) {
  if (created) return created.email;
  const rows = await page.getByRole('row').filter({ hasText: /qa\.auto\./i }).allInnerTexts();
  const pick = rows.find((t) => !status || new RegExp(`\\b${status}\\b`, 'i').test(t));
  return pick ? (pick.match(EMAIL_RE) || [])[0] || null : null;
}

// Deactivate / Reactivate ask through a native window.confirm(); Playwright dismisses those by
// default, which silently cancels the action.
function acceptNextConfirm(page, observed) {
  page.once('dialog', (d) => {
    observed.push(`confirm "${d.message()}"`);
    d.accept();
  });
}

function recorder(observed) {
  return () => {
    test.info().annotations.push({ type: 'actual', description: observed.join('; ') });
    console.log(`[actual] ${test.info().title}: ${observed.join('; ')}`);
  };
}

async function openUsers(page) {
  await loginAs(page, 'manufacturer');
  await page.goto(PATH, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Create user' })).toBeVisible();
  // The table body arrives with /api/manufacturer/org-users.
  await expect(page.getByRole('row').nth(1)).toBeVisible({ timeout: 20_000 });
}

const form = (page) => ({
  name: page.getByPlaceholder('e.g., John Doe'),
  email: page.getByPlaceholder('user@example.com'),
  password: page.getByPlaceholder('Minimum 8 characters').nth(0),
  confirm: page.getByPlaceholder('Minimum 8 characters').nth(1),
  submit: page.getByRole('button', { name: 'Create', exact: true }),
});

async function fillCreate(page, { name, email, password, confirm = password }) {
  await page.getByRole('button', { name: 'Create user' }).click();
  const f = form(page);
  await expect(f.name).toBeVisible();
  await f.name.fill(name);
  await f.email.fill(email);
  await f.password.fill(password);
  await f.confirm.fill(confirm);
  return f;
}

// Submits the form and returns the POST to org-users, or null when the browser never sent one
// (HTML5 or client-side validation blocked it).
async function submit(page, f) {
  const post = page
    .waitForResponse((r) => /\/org-users/.test(r.url()) && r.request().method() === 'POST', { timeout: 6_000 })
    .catch(() => null);
  await f.submit.click();
  const res = await post;
  if (!res) return null;
  return { status: res.status(), body: await res.text().catch(() => '') };
}

const userRow = (page, email) => page.getByRole('row').filter({ hasText: email });

async function rowStatus(page, email) {
  const row = userRow(page, email);
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  const text = (await row.innerText()).replace(/\s+/g, ' ');
  const m = text.match(/\b(Active|Inactive|Pending|Deactivated|Suspended)\b/i);
  return { row, text, status: m ? m[1] : null };
}

test.describe('Manufacturer user management', () => {
  qtest('MFG-USER-001', 'Create a new manufacturer sub-user', async ({ page }) => {
    test.setTimeout(90_000);
    const observed = [];
    try {
      await openUsers(page);
      const scope = (await page.getByText(/scoped to /).first().innerText()).match(/scoped to ([^.]+)\./);
      const orgName = scope ? scope[1].trim() : null;
      observed.push(`page scoped to "${orgName}"`);

      const email = `qa.auto.${STAMP}@example.com`;
      const name = `QA-AUTO-${STAMP} Jane`;
      const f = await fillCreate(page, { name, email, password: STRONG_PASSWORD });
      const res = await submit(page, f);
      observed.push(`POST org-users -> ${res ? res.status : 'not sent'}${res && res.status >= 400 ? ` ${res.body.slice(0, 200)}` : ''}`);
      expect(res, 'Create must reach the server').not.toBeNull();
      expect(res.status, res.body.slice(0, 300)).toBeLessThan(300);

      created = { email, name };
      logEntity({
        type: 'user',
        identifier: email,
        testId: 'MFG-USER-001',
        name,
        role: 'manufacturer sub-user',
        cleanup: 'Deactivate in Manufacturer > System Management > User Management (row action Deactivate)',
      });

      await page.reload({ waitUntil: 'domcontentloaded' });
      const { row, text, status } = await rowStatus(page, email);
      observed.push(`row: "${text.slice(0, 160)}"`);
      expect(status, `status in "${text}"`).toMatch(/^(Active|Pending)$/i);
      // ORG column ties the user to the manufacturer that created it.
      const orgCell = (await row.getByRole('cell').nth(1).innerText()).trim();
      observed.push(`ORG = "${orgCell}", STATUS = ${status}`);
      expect(orgCell, 'ORG column').not.toBe('');
      if (orgName) expect(orgName.includes(orgCell) || orgCell.includes(orgName), `ORG "${orgCell}" vs scope "${orgName}"`).toBeTruthy();
    } finally {
      recorder(observed)();
    }
  });

  qtest('MFG-USER-002', 'Deactivated user can be reactivated', async ({ page }) => {
    test.setTimeout(90_000);
    const observed = [];
    try {
      await openUsers(page);
      const email = await qaUserEmail(page);
      expect(email, 'a QA-AUTO user to act on (run MFG-USER-001 first)').toBeTruthy();
      const before = await rowStatus(page, email);
      observed.push(`${email} starts ${before.status}`);

      // 1. Deactivate, unless an earlier run already left this QA user inactive.
      if (/^active$/i.test(before.status)) {
        const deactivate = before.row.getByRole('button', { name: 'Deactivate account' });
        await expect(deactivate, 'an active user offers a Deactivate action').toBeVisible();
        acceptNextConfirm(page, observed);
        await deactivate.click();
        await expect.poll(async () => (await rowStatus(page, email)).status, { timeout: 15_000 }).toMatch(/^inactive$/i);
        observed.push('after Deactivate: Inactive');
      }

      // 2. Reactivate.
      const reactivate = userRow(page, email).getByRole('button', { name: /reactivate/i });
      await expect(reactivate, 'an inactive user offers Reactivate').toBeVisible();
      acceptNextConfirm(page, observed);
      const put = page.waitForResponse((r) => /\/org-users\//.test(r.url()) && r.request().method() !== 'GET', { timeout: 10_000 }).catch(() => null);
      await reactivate.click();
      const res = await put;
      observed.push(`reactivate request -> ${res ? `${res.request().method()} ${res.status()}` : 'none seen'}`);
      // On TrackIQ the row keeps reading Inactive until the page is reloaded (Deactivate, by
      // contrast, updates in place); recorded, and the verdict is taken from the reloaded list.
      const inPlace = await expect
        .poll(async () => (await rowStatus(page, email)).status, { timeout: 8_000 })
        .toMatch(/^active$/i)
        .then(() => true, () => false);
      observed.push(inPlace ? 'row updated to Active in place' : 'row still showed Inactive until reload (stale list)');

      // The change must survive a reload (server state, not just optimistic UI).
      await page.reload({ waitUntil: 'domcontentloaded' });
      const after = await rowStatus(page, email);
      observed.push(`after Reactivate + reload: ${after.status}`);
      expect(after.status).toMatch(/^active$/i);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MFG-USER-003', 'Search users by name or email', async ({ page }) => {
    const observed = [];
    try {
      await openUsers(page);
      const dataRows = page.getByRole('row').filter({ has: page.getByRole('cell') });
      const total = await dataRows.count();
      // A partial email of a user that exists: ours if MFG-USER-001 ran, else the signed-in user.
      const listed = (await page.getByRole('row').filter({ hasText: '@' }).allInnerTexts()).map((t) => (t.match(EMAIL_RE) || [])[0]);
      const target = (await qaUserEmail(page)) || listed.find(Boolean);
      expect(target, 'a listed user to search for').toBeTruthy();
      const fragment = target.split('@')[0].slice(0, Math.max(6, target.split('@')[0].length - 3));
      await page.getByPlaceholder('Search users by name or email...').fill(fragment);
      await expect.poll(async () => (await dataRows.allInnerTexts()).every((t) => t.toLowerCase().includes(fragment.toLowerCase())), { timeout: 10_000 }).toBe(true);
      const shown = await dataRows.count();
      observed.push(`search "${fragment}": ${total} rows -> ${shown}`);
      expect(shown, 'at least the target user matches').toBeGreaterThan(0);
      await expect(userRow(page, target)).toBeVisible();

      // A name fragment filters too, and something that matches nobody empties the table.
      await page.getByPlaceholder('Search users by name or email...').fill('zzz-no-such-user-zzz');
      await expect.poll(async () => dataRows.filter({ hasText: '@' }).count(), { timeout: 10_000 }).toBe(0);
      observed.push('non-matching search: 0 user rows');
    } finally {
      recorder(observed)();
    }
  });

  qtest('MFG-USER-EDGE-001', 'Password shorter than 8 characters is rejected', async ({ page }) => {
    const observed = [];
    try {
      await openUsers(page);
      const f = await fillCreate(page, { name: `QA-AUTO-${STAMP} short`, email: `qa.auto.short.${STAMP}@example.com`, password: 'abc123' });
      const placeholder = await f.password.getAttribute('placeholder');
      const res = await submit(page, f);
      const validity = await f.password.evaluate((el) => el.validationMessage);
      observed.push(`placeholder "${placeholder}"; request ${res ? `sent (${res.status})` : 'not sent'}; browser says "${validity}"`);
      if (res && res.status < 300) {
        logEntity({ type: 'user', identifier: `qa.auto.short.${STAMP}@example.com`, testId: 'MFG-USER-EDGE-001', cleanup: 'Deactivate in Manufacturer > System Management > User Management' });
      }
      expect(placeholder).toBe('Minimum 8 characters');
      expect(res === null || res.status >= 400, 'submission must be blocked').toBeTruthy();
      expect(validity, 'browser blocks the short password').not.toBe('');
    } finally {
      recorder(observed)();
    }
  });

  qtest('MFG-USER-EDGE-002', 'Password and Confirm Password mismatch is rejected', async ({ page }) => {
    const observed = [];
    try {
      await openUsers(page);
      // Workbook data is Password123 / Password456; both are padded to the live 12-char minimum
      // so the mismatch rule, not the length rule, is what gets exercised.
      const f = await fillCreate(page, {
        name: `QA-AUTO-${STAMP} mismatch`,
        email: `qa.auto.mismatch.${STAMP}@example.com`,
        password: 'Password123!x',
        confirm: 'Password456!x',
      });
      const res = await submit(page, f);
      const error = page.getByText('Passwords do not match').first();
      const shown = await error.isVisible({ timeout: 5_000 }).catch(() => false);
      observed.push(`request ${res ? `sent (${res.status})` : 'not sent'}; mismatch error ${shown ? 'shown: "Passwords do not match"' : 'not shown'}`);
      if (res && res.status < 300) {
        logEntity({ type: 'user', identifier: `qa.auto.mismatch.${STAMP}@example.com`, testId: 'MFG-USER-EDGE-002', cleanup: 'Deactivate in Manufacturer > System Management > User Management' });
      }
      expect(res === null || res.status >= 400, 'submission must be blocked').toBeTruthy();
      expect(shown, 'a mismatch error is shown').toBe(true);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MFG-USER-EDGE-003', 'Creating a user with an already-registered email is rejected', async ({ page }) => {
    const observed = [];
    try {
      await openUsers(page);
      // An address already registered: the QA user from MFG-USER-001, else another listed user.
      let existing = await qaUserEmail(page);
      if (!existing) {
        const rows = await page.getByRole('row').filter({ hasText: '@' }).allInnerTexts();
        existing = rows.map((t) => (t.match(EMAIL_RE) || [])[0]).find(Boolean);
      }
      expect(existing, 'an existing user email').toBeTruthy();
      const f = await fillCreate(page, { name: `QA-AUTO-${STAMP} duplicate`, email: existing, password: STRONG_PASSWORD });
      const res = await submit(page, f);
      const toast = await page.getByText(/already|exists|duplicate|in use|taken|registered/i).first().innerText({ timeout: 6_000 }).catch(() => '');
      observed.push(`email ${existing}: POST ${res ? res.status : 'not sent'} ${res ? res.body.slice(0, 200) : ''}; message "${toast.slice(0, 160)}"`);
      if (res && res.status < 300) {
        logEntity({ type: 'user', identifier: existing, testId: 'MFG-USER-EDGE-003', name: `QA-AUTO-${STAMP} duplicate`, cleanup: 'DUPLICATE account created with an existing email - remove/deactivate the QA-AUTO duplicate row in Manufacturer > User Management' });
      }
      expect(res, 'the duplicate reaches the server').not.toBeNull();
      expect(res.status, 'duplicate email is rejected').toBeGreaterThanOrEqual(400);
      expect(`${res.body} ${toast}`, 'a duplicate-email error').toMatch(/already|exists|duplicate|in use|taken|registered/i);
    } finally {
      recorder(observed)();
    }
  });

  qtest('MFG-USER-EDGE-004', 'Malformed email is rejected', async ({ page }) => {
    const observed = [];
    try {
      await openUsers(page);
      const f = await fillCreate(page, { name: `QA-AUTO-${STAMP} bad email`, email: 'not-an-email', password: STRONG_PASSWORD });
      const res = await submit(page, f);
      const validity = await f.email.evaluate((el) => el.validationMessage);
      observed.push(`request ${res ? `sent (${res.status})` : 'not sent'}; email validation "${validity}"`);
      if (res && res.status < 300) {
        logEntity({ type: 'user', identifier: 'not-an-email', testId: 'MFG-USER-EDGE-004', cleanup: 'Deactivate in Manufacturer > System Management > User Management' });
      }
      expect(res === null || res.status >= 400, 'submission must be blocked').toBeTruthy();
      if (res === null) expect(validity, 'HTML5 email validation').not.toBe('');
    } finally {
      recorder(observed)();
    }
  });
});
