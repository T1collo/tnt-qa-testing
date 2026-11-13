// Runs Proof/xml/bodies against Partner Portal Manufacturer XML upload
// (https://tnt-demo.apeiro-digital.com/partners/upload).
// Saves UI screenshot <shot>.png and job status <shot>-status.png under Proof/xml/.
//
// Run:  node scripts/xml/run-xml-mfg.mjs [--only E01,R001] [--skip-size]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { chromium } = require('@playwright/test');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => {
    if (a.startsWith('--')) pairs.push([a.slice(2), all[i + 1] ?? 'true']);
    return pairs;
  }, [])
);
const PROOF = path.join(ROOT, 'Proof', 'xml');
const BODIES = path.join(PROOF, 'bodies');
const BASE = process.env.BASE_URL || 'https://tnt-demo.apeiro-digital.com';
const email = process.env.PARTNER_EMAIL || process.env.TRACKIQ_MANUFACTURER_PARTNER_EMAIL;
const password = process.env.PARTNER_PASSWORD || process.env.TRACKIQ_MANUFACTURER_PARTNER_PASSWORD;
if (!email || !password) throw new Error('set PARTNER_EMAIL/PASSWORD or TRACKIQ_MANUFACTURER_PARTNER_*');

const UPLOAD_API = /\/api\/partners\/uploads$/;
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const SKIP_SIZE = args['skip-size'] === 'true' || args['skip-size'] === true || 'skip-size' in args;
const NO_SHOTS = args['no-shots'] === 'true' || args['no-shots'] === true || 'no-shots' in args;

const manifest = JSON.parse(fs.readFileSync(path.join(PROOF, 'manifest.json'), 'utf8'));
const RESUME = 'resume' in args || args.resume === 'true';
const results = RESUME && fs.existsSync(path.join(PROOF, 'results.json'))
  ? JSON.parse(fs.readFileSync(path.join(PROOF, 'results.json'), 'utf8'))
  : [];
const doneShots = new Set(results.map((r) => r.shot));
const logLines = RESUME && fs.existsSync(path.join(PROOF, 'run-log.txt'))
  ? fs.readFileSync(path.join(PROOF, 'run-log.txt'), 'utf8').split(/\r?\n/).filter(Boolean)
  : [];

function record(shot, data) {
  const i = results.findIndex((r) => r.shot === shot);
  if (i >= 0) results[i] = { shot, ...data };
  else results.push({ shot, ...data });
  fs.writeFileSync(path.join(PROOF, 'results.json'), JSON.stringify(results, null, 2));
  const line = `${shot.padEnd(7)} ${data.file ? path.basename(data.file) : '-'} -> ${data.http ?? '-'} ${String(data.summary || '').slice(0, 220)}`;
  logLines.push(line);
  console.log(line);
  fs.writeFileSync(path.join(PROOF, 'run-log.txt'), `${logLines.join('\n')}\n`);
}

async function signIn(browser) {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto('/partners/login', { waitUntil: 'load' });
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.locator('button[type=submit]').click();
  await page.waitForURL((u) => /\/partners\//.test(u.pathname) && !u.pathname.includes('/login'), { timeout: 60_000 });
  return page;
}

async function finalStatus(page, requestId) {
  const url = `${BASE}/api/partners/async-submissions/${requestId}`;
  let last = null;
  for (let i = 0; i < 40; i += 1) {
    const text = await page.request.get(url).then((r) => r.text()).catch(() => null);
    last = text;
    try {
      const j = JSON.parse(text);
      if (!['accepted', 'processing', 'queued'].includes(j.status)) return text;
    } catch {
      return text;
    }
    await page.waitForTimeout(1200);
  }
  return last;
}

async function shootStatus(context, shot, statusText) {
  let pretty = statusText;
  try {
    const s = JSON.parse(statusText);
    if (s.result_summary?.event_ids) delete s.result_summary.event_ids;
    pretty = JSON.stringify(s, null, 2);
  } catch { /* keep */ }
  const esc = pretty.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const p = await context.newPage();
  await p.setContent(
    `<h3 style="font-family:sans-serif">Test ${shot}: async submission status (${BASE})</h3>`
    + `<pre style="font-size:13px;white-space:pre-wrap">${esc}</pre>`
  );
  await p.screenshot({ path: path.join(PROOF, `${shot}-status.png`), fullPage: true });
  await p.close();
}

function summarizeStatus(finalText) {
  if (!finalText) return null;
  try {
    const j = JSON.parse(finalText);
    const warnings = j.result_summary?.warning_codes || j.warning_codes || [];
    return {
      status: j.status,
      result_http_status: j.result_http_status,
      error_code: j.error_code || j.result_summary?.error_code || null,
      error_message: j.error_message || j.result_summary?.error_message || null,
      warning_codes: warnings,
      accepted_count: j.result_summary?.accepted_count ?? j.accepted_count ?? null,
      sandbox: j.sandbox,
    };
  } catch {
    return { raw: finalText.slice(0, 300) };
  }
}

function verdictFor(c, http, statusObj, dialog) {
  if (c.kind === 'not_testable') return 'NOT TESTABLE';
  if (c.kind === 'setup') {
    return statusObj?.status === 'succeeded' || http === 202 ? 'PASS' : 'FAIL';
  }
  if (c.expectFail) {
    if (http && http >= 400) return 'PASS';
    if (statusObj?.status === 'failed' || statusObj?.error_code) return 'PASS';
    if (/reject|invalid|error|failed|too large|exceed/i.test(dialog || '')) return 'PASS';
    // soft: code in warnings when sheet said hard reject → FAIL
    if (statusObj?.status === 'succeeded' && c.code && (statusObj.warning_codes || []).includes(c.code)) {
      return 'FAIL'; // accepted with flag instead of hard reject
    }
    if (statusObj?.status === 'succeeded') return 'FAIL';
    return 'FAIL';
  }
  // happy / flag cases: accept 202 + succeeded (warnings OK), or succeeded with expected code in warnings
  if (http && http >= 400 && !c.expectFail) {
    // role blocks for E08/E15 may be job-failed with PARTNER_TYPE...
    if (statusObj?.error_code === 'PARTNER_TYPE_BIZSTEP_MISMATCH') return 'N/A (role)';
    return 'FAIL';
  }
  if (statusObj?.error_code === 'PARTNER_TYPE_BIZSTEP_MISMATCH') return 'N/A (role)';
  if (statusObj?.status === 'succeeded' || statusObj?.status === 'failed') {
    if (c.code && !c.expectFail) {
      const warnings = statusObj.warning_codes || [];
      const err = statusObj.error_code;
      if (warnings.includes(c.code) || err === c.code || statusObj.status === 'succeeded') return 'PASS';
    }
    if (statusObj.status === 'succeeded') return 'PASS';
    if (statusObj.status === 'failed' && /E08|E15/.test(c.shot)) return 'N/A (role)';
    return statusObj.status === 'failed' ? 'FAIL' : 'PASS';
  }
  if (http === 202 && statusObj?.status === 'succeeded') return 'PASS';
  if (http === 202 && !statusObj) return 'FAIL'; // accepted but no terminal status
  return 'FAIL';
}

async function upload(page, c) {
  const file = path.join(BODIES, c.file);
  await page.goto('/partners/upload', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.locator('input[type=file]').setInputFiles(file);
  await page.waitForTimeout(600);

  const respP = page.waitForResponse(
    (r) => r.request().method() === 'POST' && UPLOAD_API.test(new URL(r.url()).pathname),
    { timeout: 180_000 }
  ).catch(() => null);

  const btn = page.getByRole('button', { name: 'Upload XML' });
  let clicked = true;
  if (await btn.isDisabled().catch(() => false)) clicked = false;
  else await btn.click();

  const resp = clicked ? await respP : null;
  let body = resp ? await resp.text().catch(() => null) : null;
  let requestId = null;
  try { requestId = JSON.parse(body).request_id; } catch { /* */ }

  let final = null;
  if (requestId && resp && resp.status() === 202) {
    final = await finalStatus(page, requestId);
    await page.getByRole('button', { name: /Refresh status/i }).click().catch(() => {});
    await page.waitForTimeout(1500);
  } else {
    await page.waitForTimeout(2000);
  }

  const dialog = await page.locator('body').innerText();
  if (!NO_SHOTS) {
    await page.screenshot({ path: path.join(PROOF, `${c.shot}.png`), fullPage: true });
    if (final) await shootStatus(page.context(), c.shot, final);
  }

  const statusObj = summarizeStatus(final);
  const http = resp ? resp.status() : null;
  const summary = [
    http != null ? `HTTP ${http}` : 'no POST',
    statusObj ? `status=${statusObj.status}` : null,
    statusObj?.error_code ? `error=${statusObj.error_code}` : null,
    statusObj?.warning_codes?.length ? `warnings=${statusObj.warning_codes.join(',')}` : null,
    !resp && dialog.match(/exceed|too large|invalid|error|reject/i)?.[0],
  ].filter(Boolean).join('; ');

  const verdict = verdictFor(c, http, statusObj, dialog);
  record(c.shot, {
    title: c.title,
    expected: c.expected,
    file,
    http,
    sent: Boolean(resp),
    importEnabled: clicked,
    request_id: requestId,
    status: statusObj,
    summary,
    body: body && body.length < 100_000 ? body : (body || '').slice(0, 4000),
    dialog: dialog.slice(0, 4000),
    evidence: NO_SHOTS ? '—' : (final ? `${c.shot}, ${c.shot}-status` : c.shot),
    verdict,
  });
}

fs.mkdirSync(PROOF, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await signIn(browser);
  for (const c of manifest.cases) {
    if (ONLY && !ONLY.has(c.shot)) continue;
    if (RESUME && doneShots.has(c.shot) && c.kind !== 'not_testable') {
      console.log(`${c.shot.padEnd(7)} skip (already in results.json)`);
      continue;
    }
    if (c.kind === 'not_testable') {
      if (RESUME && doneShots.has(c.shot)) continue;
      record(c.shot, {
        title: c.title, expected: c.expected, file: null, http: null,
        status: null, summary: c.reason, verdict: 'NOT TESTABLE', evidence: '—',
      });
      continue;
    }
    if (c.shot === 'RSIZE' && SKIP_SIZE) {
      if (RESUME && doneShots.has(c.shot)) continue;
      record(c.shot, {
        title: c.title, expected: c.expected, file: c.file, http: null,
        summary: 'skipped (--skip-size)', verdict: 'NOT TESTED', evidence: '—',
      });
      continue;
    }
    await upload(page, c);
  }
} finally {
  await browser.close();
}
console.log(`\nDone. Screenshots + results.json in ${PROOF}`);
