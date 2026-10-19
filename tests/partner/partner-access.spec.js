// Partner portal: authentication, role-based access (RBAC) and account creation, for each
// partner account (manufacturer, distributor, facility).
//
// Sign-in and registration sit behind Cloudflare Turnstile, so every form submission runs as
// a separate visible-browser process (partner-flows.js); everything else uses the saved
// sessions headlessly. These cases are not in the master workbook - the export adds them as
// their own section of the Partner portal sheet.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { test, expect } = require('@playwright/test');
const { qtest } = require('../helpers/qtest');
const { logEntity } = require('../helpers/datalog');
const { PORTAL, PARTNER_ACCOUNTS, partnerFlow, partnerContext } = require('./partner-helpers');

const ROLES = ['manufacturer', 'distributor', 'facility'];
const ROLE_ID = { manufacturer: 'MAN', distributor: 'DIST', facility: 'FAC' };
// partner_type values the certification API reports for each account.
const PARTNER_TYPE = { manufacturer: /manufacturer/i, distributor: /distributor|supplier/i, facility: /facility/i };
// Main-portal (role) pages a partner session must not open.
const MAIN_PORTAL_PAGES = ['/manufacturer/shipments', '/distributor/shipments', '/regulator'];
const ENDPOINTS = {
  manufacturer: `${PORTAL}/api/integration/manufacturer/events`,
  distributor: `${PORTAL}/api/integration/supplier/events`,
  facility: `${PORTAL}/api/integration/facility/events`,
};
const API_KEY = {
  manufacturer: process.env.TRACKIQ_MANUFACTURER_API_TOKEN,
  distributor: process.env.TRACKIQ_DISTRIBUTOR_API_TOKEN,
  facility: process.env.TRACKIQ_FACILITY_API_TOKEN,
};

// Annotations the dashboard turns into the workbook's Expected / Actual Result columns.
function recorder(expected) {
  test.info().annotations.push({ type: 'expected', description: expected });
  const observed = [];
  return {
    observed,
    done: () => test.info().annotations.push({ type: 'actual', description: observed.join('; ') }),
  };
}

async function certificationStatus(context) {
  const res = await context.request.get(`${PORTAL}/api/partners/certification/status?_=${Date.now()}`);
  return { status: res.status(), json: res.ok() ? await res.json() : null };
}

test.describe('Partner portal - authentication', () => {
  for (const role of ROLES) {
    qtest(`PARTNER-AUTH-${ROLE_ID[role]}-001`, `${role} partner signs in and lands on its own portal`, async ({ browser }) => {
      test.setTimeout(150_000);
      const r = recorder(`Sign-in succeeds, lands on /partners/dashboard, and the portal identifies the account as a ${role} partner`);
      try {
        const account = PARTNER_ACCOUNTS[role];
        expect(account.email, `${role} partner account missing from .env`).toBeTruthy();
        // A fresh sign-in through the form (not a reused session), so the login itself is tested.
        const flow = partnerFlow('login', { email: account.email, password: account.password });
        r.observed.push(`sign-in HTTP ${flow.status}, landed on ${new URL(flow.url || PORTAL).pathname}`);
        expect(flow.ok, flow.message).toBe(true);

        const context = await partnerContext(browser, role);
        try {
          const { json } = await certificationStatus(context);
          r.observed.push(`portal reports partner_type "${json?.partner_type}"`);
          expect(json?.partner_type).toMatch(PARTNER_TYPE[role]);
        } finally {
          await context.close();
        }
      } finally {
        r.done();
      }
    });
  }

  qtest('PARTNER-AUTH-NEG-001', 'partner sign-in rejects a wrong password', async () => {
    test.setTimeout(150_000);
    const r = recorder('Sign-in refused (401), stays on /partners/login with "Invalid email or password"');
    try {
      const flow = partnerFlow('login', { email: PARTNER_ACCOUNTS.facility.email, password: `wrong-${Date.now()}` });
      r.observed.push(`sign-in HTTP ${flow.status}, ended on ${new URL(flow.url || PORTAL).pathname}`);
      expect(flow.ok).toBe(false);
      expect(flow.status).toBe(401);
      expect(flow.message).toContain('Invalid email or password');
      r.observed.push('"Invalid email or password" shown');
    } finally {
      r.done();
    }
  });

  qtest('PARTNER-AUTH-NEG-002', 'partner sign-in rejects an unknown email', async () => {
    test.setTimeout(150_000);
    const r = recorder('Sign-in refused (401) for an email with no account; no session is created');
    try {
      const flow = partnerFlow('login', { email: `nobody.${Date.now()}@example.com`, password: 'Whatever-123!' });
      r.observed.push(`sign-in HTTP ${flow.status}, ended on ${new URL(flow.url || PORTAL).pathname}`);
      expect(flow.ok).toBe(false);
      expect(flow.status).toBe(401);
    } finally {
      r.done();
    }
  });

  qtest('PARTNER-AUTH-002', 'partner logout ends the session', async ({ browser }) => {
    test.setTimeout(150_000);
    const r = recorder('Logout returns to /partners/login; the old session no longer opens the portal or its API');
    // Its own throwaway session: logging out invalidates it server-side, so the shared saved
    // sessions other tests rely on must not be used here.
    const file = path.join(os.tmpdir(), `partner-logout-${Date.now()}.json`);
    try {
      const account = PARTNER_ACCOUNTS.facility;
      const flow = partnerFlow('login', { email: account.email, password: account.password, out: file });
      expect(flow.ok, flow.message).toBe(true);
      const context = await browser.newContext({ storageState: file });
      try {
        const page = await context.newPage();
        await page.goto(`${PORTAL}/partners/dashboard`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: 'Logout' }).click();
        await page.waitForURL('**/partners/login**', { timeout: 20_000 });
        r.observed.push(`after Logout: ${new URL(page.url()).pathname}`);
        await page.goto(`${PORTAL}/partners/dashboard`, { waitUntil: 'domcontentloaded' });
        await page.waitForURL('**/partners/login**', { timeout: 20_000 });
        r.observed.push(`reopening the dashboard redirects to ${new URL(page.url()).pathname}`);
        const { status } = await certificationStatus(context);
        r.observed.push(`partner API with the old session: HTTP ${status}`);
        expect(status).not.toBe(200);
      } finally {
        await context.close();
      }
    } finally {
      fs.rmSync(file, { force: true });
      r.done();
    }
  });
});

test.describe('Partner portal - role-based access', () => {
  for (const role of ROLES) {
    qtest(`PARTNER-RBAC-${ROLE_ID[role]}-001`, `${role} partner session cannot open the main portal`, async ({ browser }) => {
      test.setTimeout(150_000);
      const r = recorder(`A ${role} partner session is not accepted by the main portal: ${MAIN_PORTAL_PAGES.join(', ')} send it to sign in, and the main portal reports no session`);
      try {
        const context = await partnerContext(browser, role);
        try {
          const res = await context.request.get(`${PORTAL}/api/auth/get-session`);
          const session = res.ok() ? await res.json().catch(() => null) : null;
          r.observed.push(`main-portal get-session: ${session?.session ? 'SIGNED IN' : 'no session'}`);
          expect(session?.session ?? null).toBeNull();
          const page = await context.newPage();
          for (const route of MAIN_PORTAL_PAGES) {
            await page.goto(`${PORTAL}${route}`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1_500);
            const landed = new URL(page.url()).pathname;
            r.observed.push(`${route} -> ${landed}`);
            expect(landed, `${route} should not open for a partner session`).not.toBe(route);
          }
        } finally {
          await context.close();
        }
      } finally {
        r.done();
      }
    });

    qtest(`PARTNER-RBAC-${ROLE_ID[role]}-002`, `${role} partner sees only its own role's certification`, async ({ browser }) => {
      test.setTimeout(150_000);
      const r = recorder(`Certification lists only ${role} cases, and the page is titled for that role`);
      try {
        const context = await partnerContext(browser, role);
        try {
          const { json } = await certificationStatus(context);
          const types = [...new Set((json?.steps || []).map((s) => s.partner_type))];
          r.observed.push(`${json?.steps?.length ?? 0} cases, partner types [${types.join(', ')}]`);
          expect(json?.steps?.length).toBeGreaterThan(0);
          for (const t of types) expect(t).toMatch(PARTNER_TYPE[role]);
          const page = await context.newPage();
          await page.goto(`${PORTAL}/partners/certification`, { waitUntil: 'domcontentloaded' });
          const heading = page.getByRole('heading', { level: 1 });
          await expect(heading).toContainText(/Certification/, { timeout: 20_000 });
          // The title is filled from the account's data once it loads; give it time to settle
          // before judging, so a loading placeholder is not mistaken for the final title.
          await expect(heading).not.toContainText('undefined', { timeout: 15_000 }).catch(() => {});
          const title = await heading.innerText();
          r.observed.push(`page title "${title}"`);
          expect(title).toMatch(PARTNER_TYPE[role]);
        } finally {
          await context.close();
        }
      } finally {
        r.done();
      }
    });

    qtest(`PARTNER-RBAC-${ROLE_ID[role]}-003`, `${role} partner API key is refused on other roles' endpoints`, async () => {
      const r = recorder(`The ${role} key passes authorisation on its own endpoint and gets 403 on every other role's endpoint`);
      try {
        const key = API_KEY[role];
        expect(key, `TRACKIQ_${role.toUpperCase()}_API_TOKEN missing from .env`).toBeTruthy();
        for (const target of ROLES) {
          // An empty document: authorisation is decided before validation, so the status
          // alone shows whether the key was allowed in (4xx validation) or refused (403).
          const res = await fetch(ENDPOINTS[target], {
            method: 'POST',
            headers: { 'Content-Type': 'application/ld+json', 'X-API-Key': key },
            body: '{}',
          });
          r.observed.push(`${target} endpoint: HTTP ${res.status}`);
          if (target === role) expect([401, 403], `own endpoint refused the ${role} key`).not.toContain(res.status);
          else expect(res.status, `${role} key on the ${target} endpoint`).toBe(403);
        }
      } finally {
        r.done();
      }
    });
  }

  qtest('PARTNER-RBAC-004', 'a main-portal session cannot open the partner portal', async ({ browser }) => {
    test.setTimeout(150_000);
    const r = recorder('Signed in to the main portal only, /partners/dashboard sends you to /partners/login and the partner API refuses the session');
    const { loginAs } = require('../helpers/auth');
    const prev = process.env.BASE_URL;
    process.env.BASE_URL = PORTAL;
    // Explicitly empty: contexts made inside this project otherwise inherit its saved facility
    // partner session, and the check would then be answered by that partner cookie.
    const context = await browser.newContext({ baseURL: PORTAL, storageState: { cookies: [], origins: [] } });
    try {
      const page = await context.newPage();
      await loginAs(page, 'manufacturer');
      r.observed.push('signed in to the main portal as manufacturer');
      const { status, json } = await certificationStatus(context);
      // When the partner API does accept the session, record whose partner data it served.
      r.observed.push(`partner API: HTTP ${status}${json ? ` (served partner_type "${json.partner_type}", ${json.total_cases ?? '?'} cases)` : ''}`);
      expect(status, 'a main-portal session must not be accepted by the partner API').not.toBe(200);
      await page.goto(`${PORTAL}/partners/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL('**/partners/login**', { timeout: 20_000 });
      r.observed.push(`/partners/dashboard -> ${new URL(page.url()).pathname}`);
    } finally {
      await context.close();
      process.env.BASE_URL = prev;
      r.done();
    }
  });

  for (const role of ROLES) {
    qtest(`PARTNER-RBAC-${ROLE_ID[role]}-005`, `${role} partner credentials do not sign in to the main portal`, async () => {
      test.setTimeout(150_000);
      const r = recorder('The partner account is refused by the main portal /login (partner and portal users are separate)');
      try {
        const account = PARTNER_ACCOUNTS[role];
        const run = spawnSync(
          process.execPath,
          [path.join(__dirname, '..', 'helpers', 'headed-login.js'), PORTAL, account.email, account.password],
          { encoding: 'utf-8', timeout: 120_000 }
        );
        const result = JSON.parse(String(run.stdout || '{}').trim().split('\n').pop() || '{}');
        r.observed.push(`main-portal sign-in: ${result.ok ? `SIGNED IN (${result.url})` : 'refused'}`);
        expect(result.ok).toBe(false);
      } finally {
        r.done();
      }
    });
  }
});

// A registration whose request never went out (Turnstile slow to issue its token) says
// nothing about the platform, so it is tried once more before being judged.
function register(form) {
  const first = partnerFlow('register', form);
  return first.requestSent || first.invalidFields > 0 ? first : partnerFlow('register', form);
}

// One organisation per run, shared by the cases that build on it (sign-in, duplicate).
const stamp = Date.now();
const account = {
    orgName: `QA-AUTO Partner ${stamp}`,
    orgType: 'DISTRIBUTOR',
    country: 'KE',
    contactName: 'QA Auto',
    phone: '+254700000000',
    email: `qa.auto.partner.${stamp}@example.com`,
  password: `QaAuto-${stamp}!x`,
};

test.describe('Partner portal - account creation', () => {
  // These three build on one another (register, then sign in, then register again).
  test.describe.configure({ mode: 'serial' });

  qtest('PARTNER-REG-001', 'register a new partner organisation', async () => {
    test.setTimeout(150_000);
    const r = recorder('Registration is accepted (2xx) and the new organisation is created');
    try {
      const result = register(account);
      r.observed.push(`register HTTP ${result.status}${result.response?.message ? ` "${result.response.message}"` : ''}, ended on ${new URL(result.url || PORTAL).pathname}`);
      expect(result.requestSent, `no registration request was sent: ${result.message}`).toBe(true);
      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(300);
      logEntity({
        type: 'partner_account',
        identifier: account.email,
        testId: 'PARTNER-REG-001',
        relatedTo: account.orgName,
        notes: `${account.orgType} partner organisation registered through /partners/register`,
        cleanup: 'Remove the organisation and its user from the partner registry (TrackIQ admin)',
      });
    } finally {
      r.done();
    }
  });

  qtest('PARTNER-REG-002', 'a newly registered partner can sign in', async () => {
    test.setTimeout(150_000);
    const r = recorder('The new account signs in and lands on /partners/dashboard');
    try {
      const flow = partnerFlow('login', { email: account.email, password: account.password });
      r.observed.push(`sign-in HTTP ${flow.status}, landed on ${new URL(flow.url || PORTAL).pathname}`);
      expect(flow.ok, flow.message).toBe(true);
    } finally {
      r.done();
    }
  });

  qtest('PARTNER-REG-003', 'registering an already-registered email is rejected', async () => {
    test.setTimeout(150_000);
    const r = recorder('A second registration with the same email is refused (4xx) with a clear message; no second account');
    try {
      const result = register({ ...account, orgName: `${account.orgName} duplicate` });
      r.observed.push(result.requestSent ? `register HTTP ${result.status}${result.response?.message ? ` "${result.response.message}"` : ''}` : 'no registration request was sent (captcha did not clear) - inconclusive');
      expect(result.requestSent, 'the registration request never went out').toBe(true);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.status).toBeLessThan(500);
    } finally {
      r.done();
    }
  });

});

test.describe('Partner portal - registration validation', () => {
  qtest('PARTNER-REG-004', 'registration with mismatched passwords is blocked', async () => {
    test.setTimeout(150_000);
    const r = recorder('The form refuses to submit (or the server rejects it) when Password and Confirm password differ; no account is created');
    try {
      const email = `qa.auto.partner.mismatch.${Date.now()}@example.com`;
      const result = register({ ...account, email, confirm: `${account.password}-different` });
      r.observed.push(result.requestSent ? `submitted: HTTP ${result.status}` : 'blocked before submitting');
      if (result.requestSent && result.status >= 200 && result.status < 300) {
        logEntity({ type: 'partner_account', identifier: email, testId: 'PARTNER-REG-004', notes: 'created despite mismatched passwords (defect)', cleanup: 'Remove from the partner registry' });
      }
      expect(!result.requestSent || result.status >= 400).toBe(true);
    } finally {
      r.done();
    }
  });

  qtest('PARTNER-REG-005', 'registration without an organisation name is blocked', async () => {
    test.setTimeout(150_000);
    const r = recorder('The required Organization name blocks submission; no account is created');
    try {
      const email = `qa.auto.partner.noname.${Date.now()}@example.com`;
      const result = register({ ...account, email, orgName: '' });
      r.observed.push(result.requestSent ? `submitted: HTTP ${result.status}` : `blocked before submitting (${result.invalidFields} invalid field(s))`);
      if (result.requestSent && result.status >= 200 && result.status < 300) {
        logEntity({ type: 'partner_account', identifier: email, testId: 'PARTNER-REG-005', notes: 'created without an organisation name (defect)', cleanup: 'Remove from the partner registry' });
      }
      expect(!result.requestSent || result.status >= 400).toBe(true);
    } finally {
      r.done();
    }
  });
});
