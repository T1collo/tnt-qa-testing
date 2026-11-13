/**
 * TL-1846 — create 50 partner orgs, log each in, then burst-test login rate limits.
 * Writes credentials workbook + Jira comment under new/.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'new');
const BASE = 'https://tnt-demo.apeiro-digital.com';
const ORIGIN = BASE;
const PASSWORD = 'Password-123';
const PARTY_TYPE = 'MANUFACTURER_DOMESTIC';
const TYPE_LABEL = 'Domestic Manufacturer (MANUFACTURER_DOMESTIC)';
const COUNTRY = 'KE';
const COUNT = 50;
const START = 2; // qatest001 is the manual seed row

const HEADERS = {
  'Content-Type': 'application/json',
  Origin: ORIGIN,
  Referer: `${BASE}/partners/register`,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function pad(n) {
  return String(n).padStart(3, '0');
}

function classifySignup(status, body) {
  if (status === 429) return 'Rate limited (429)';
  if (status >= 200 && status < 300) return 'Accepted';
  const msg = body?.message || body?.error || `HTTP ${status}`;
  return `Rejected (${status}: ${msg})`;
}

function classifyLogin(status, body) {
  if (status === 429) return 'Rate limited (429)';
  if (status >= 200 && status < 300 && (body?.token || body?.user)) return 'Passed';
  if (status === 401) return 'Failed (401)';
  const msg = body?.message || body?.error || `HTTP ${status}`;
  return `Failed (${status}: ${msg})`;
}

async function postJson(url, body) {
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  const rateHeaders = {};
  for (const [k, v] of res.headers.entries()) {
    if (/rate|limit|retry/i.test(k)) rateHeaders[k] = v;
  }
  return {
    status: res.status,
    ok: res.ok,
    body: json,
    rateHeaders,
    durationMs: Date.now() - started,
  };
}

async function registerOne(row) {
  const payload = {
    email: row.email,
    password: PASSWORD,
    organization: row.organization,
    party_type: PARTY_TYPE,
    country_code: COUNTRY,
  };
  const result = await postJson(`${BASE}/api/auth/register`, payload);
  return {
    ...row,
    password: PASSWORD,
    type: TYPE_LABEL,
    gln: result.body?.gln_number || '',
    signup: classifySignup(result.status, result.body),
    signupStatus: result.status,
    signupBody: result.body,
    signupRateHeaders: result.rateHeaders,
    signupMs: result.durationMs,
  };
}

async function loginOne(row) {
  const result = await postJson(`${BASE}/api/auth/user/sign-in/email`, {
    email: row.email,
    password: PASSWORD,
  });
  return {
    ...row,
    login: classifyLogin(result.status, result.body),
    loginStatus: result.status,
    loginBody: result.body,
    loginRateHeaders: result.rateHeaders,
    loginMs: result.durationMs,
  };
}

async function rateLimitBurst(seedEmail) {
  // Rapid failed + successful logins against one account to trip the limiter.
  const attempts = [];
  for (let i = 0; i < 30; i++) {
    const wrong = i % 3 !== 0;
    const result = await postJson(`${BASE}/api/auth/user/sign-in/email`, {
      email: seedEmail,
      password: wrong ? 'Definitely-Wrong-Password-123' : PASSWORD,
    });
    attempts.push({
      n: i + 1,
      wrongPassword: wrong,
      status: result.status,
      durationMs: result.durationMs,
      rateHeaders: result.rateHeaders,
      body: result.body,
    });
  }
  return attempts;
}

async function writeWorkbook(rows, rateAttempts) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TL-1846 QA';
  wb.created = new Date();

  const sheet = wb.addWorksheet('Credentials');
  sheet.columns = [
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Password', key: 'password', width: 16 },
    { header: 'Organization', key: 'organization', width: 18 },
    { header: 'Type', key: 'type', width: 42 },
    { header: 'GLN', key: 'gln', width: 18 },
    { header: 'Signup', key: 'signup', width: 36 },
    { header: 'Login', key: 'login', width: 28 },
  ];
  sheet.getRow(1).font = { name: 'Arial', bold: true };
  for (const r of rows) {
    const row = sheet.addRow({
      email: r.email,
      password: r.password,
      organization: r.organization,
      type: r.type,
      gln: r.gln || '',
      signup: r.signup,
      login: r.login,
    });
    row.font = { name: 'Arial' };
  }

  const notes = wb.addWorksheet('Notes');
  notes.getColumn(1).width = 28;
  notes.getColumn(2).width = 90;
  const noteRows = [
    ['Ticket', 'TL-1846'],
    ['Environment', BASE],
    ['Register endpoint', 'POST /api/auth/register'],
    ['Login endpoint', 'POST /api/auth/user/sign-in/email'],
    ['Password policy', 'UI requires ≥12 characters; Password-123 used for all rows'],
    ['Org type', TYPE_LABEL],
    ['Country', COUNTRY],
    ['Row 1', 'Manual seed via Playwright codegen (GLN 0614141000005)'],
    ['Rows 2–51', 'Automated register + login; GLN left blank → auto test GLN'],
    ['Generated', new Date().toISOString()],
    [
      'Assumption',
      'Probe account probe-tl1846-* created during API discovery is excluded from this sheet',
    ],
  ];
  for (const [k, v] of noteRows) {
    const row = notes.addRow([k, v]);
    row.font = { name: 'Arial' };
  }

  const rl = wb.addWorksheet('RateLimit');
  rl.columns = [
    { header: 'Attempt', key: 'n', width: 10 },
    { header: 'Wrong password', key: 'wrongPassword', width: 16 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Duration ms', key: 'durationMs', width: 14 },
    { header: 'Rate headers', key: 'rateHeaders', width: 50 },
    { header: 'Body snippet', key: 'body', width: 60 },
  ];
  rl.getRow(1).font = { name: 'Arial', bold: true };
  for (const a of rateAttempts) {
    const row = rl.addRow({
      n: a.n,
      wrongPassword: a.wrongPassword ? 'yes' : 'no',
      status: a.status,
      durationMs: a.durationMs,
      rateHeaders: JSON.stringify(a.rateHeaders),
      body: JSON.stringify(a.body)?.slice(0, 200) || '',
    });
    row.font = { name: 'Arial' };
  }

  const xlsxPath = path.join(OUT_DIR, 'TL-1846_Partner_Register_Login_Credentials.xlsx');
  await wb.xlsx.writeFile(xlsxPath);
  return xlsxPath;
}

function buildJiraComment(rows, rateAttempts) {
  const accepted = rows.filter((r) => r.signup === 'Accepted').length;
  const signup429 = rows.filter((r) => String(r.signup).includes('429')).length;
  const loginPass = rows.filter((r) => r.login === 'Passed').length;
  const login429 = rows.filter((r) => String(r.login).includes('429')).length;
  const loginFail = rows.length - loginPass - login429;

  const rl429 = rateAttempts.filter((a) => a.status === 429);
  const first429 = rl429[0];
  const statuses = [...new Set(rateAttempts.map((a) => a.status))].sort((a, b) => a - b);

  return `h3. TL-1846 — Partner registration / login load + rate-limit check (tnt-demo)

*Environment:* ${BASE}
*Paths exercised:*
* Register UI: {{/partners/register}} → {{POST /api/auth/register}}
* Login UI: {{/partners/login}} → {{POST /api/auth/user/sign-in/email}}

*Password:* {{Password-123}} (plain {{password}} is rejected by the UI — minimum 12 characters)
*Organization type:* Domestic Manufacturer ({{MANUFACTURER_DOMESTIC}}), country {{KE}}

h4. Manual seed (row 1)
* Email: {{qatest001@test.com}}
* Org: {{QA-Test001}}
* GLN: {{0614141000005}}
* Signup: Accepted
* Login: Passed (partner portal reachable — Tokens / Certification / API Logs)

h4. Automated batch (rows 2–51 = 50 accounts)
* Signup Accepted: ${accepted - 1} / 50 (plus seed = ${accepted} / ${rows.length} overall)
* Signup rate-limited (429): ${signup429}
* Login Passed: ${loginPass} / ${rows.length}
* Login Failed (non-429): ${loginFail}
* Login rate-limited (429) during sequential batch: ${login429}
* Auto-assigned test GLNs returned on successful signup (blank GLN on request)

h4. Dedicated login rate-limit burst
30 rapid {{POST /api/auth/user/sign-in/email}} calls against seed account {{qatest001@test.com}} (mix of wrong/correct password).
* Statuses observed: ${statuses.join(', ') || 'none'}
* 429 count: ${rl429.length}${
    first429
      ? `\n* First 429 at attempt #${first429.n} (wrongPassword=${first429.wrongPassword})`
      : '\n* No 429 observed in this burst'
  }

h4. Evidence
Credentials workbook (51 rows + RateLimit sheet): {{new/TL-1846_Partner_Register_Login_Credentials.xlsx}}

h4. Verdict
${
    rl429.length > 0
      ? 'Partner login *is rate-limited* under burst traffic (429 observed). Batch create/login of 50 orgs completed with results captured in the workbook.'
      : 'Batch create/login of 50 orgs completed. Dedicated burst did *not* return 429 in this run — capture headers/body in the RateLimit sheet; re-check if limiter is IP-window based or only trips on consecutive failures.'
  }
`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const seed = {
    email: 'qatest001@test.com',
    password: PASSWORD,
    organization: 'QA-Test001',
    type: TYPE_LABEL,
    gln: '0614141000005',
    signup: 'Accepted',
    login: 'Passed',
    source: 'manual',
  };

  console.log(`Creating ${COUNT} partner accounts (Password-123)...`);
  const created = [];
  for (let i = 0; i < COUNT; i++) {
    const n = START + i;
    const draft = {
      email: `qatest${pad(n)}@test.com`,
      organization: `QA-Test${pad(n)}`,
      source: 'auto',
    };
    process.stdout.write(`  register ${draft.email} ... `);
    let row = await registerOne(draft);
    console.log(`${row.signupStatus} ${row.signup}${row.gln ? ` gln=${row.gln}` : ''}`);

    // brief pause so we don't only measure rate-limit on create; still finish in one run
    await new Promise((r) => setTimeout(r, 150));

    process.stdout.write(`  login    ${draft.email} ... `);
    row = await loginOne(row);
    console.log(`${row.loginStatus} ${row.login}`);
    created.push(row);

    await new Promise((r) => setTimeout(r, 150));
  }

  console.log('\nRate-limit burst against seed login...');
  const rateAttempts = await rateLimitBurst(seed.email);
  for (const a of rateAttempts) {
    console.log(
      `  #${a.n} status=${a.status} wrong=${a.wrongPassword} ${JSON.stringify(a.rateHeaders)}`,
    );
  }

  const rows = [seed, ...created];
  const xlsxPath = await writeWorkbook(rows, rateAttempts);
  const comment = buildJiraComment(rows, rateAttempts);
  const commentPath = path.join(OUT_DIR, 'TL-1846_Jira_Comment.txt');
  const jsonPath = path.join(OUT_DIR, 'TL-1846_Partner_Register_Login_Results.json');
  fs.writeFileSync(commentPath, comment, 'utf8');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ seed, created, rateAttempts, generatedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );

  console.log('\nWrote:');
  console.log(' ', xlsxPath);
  console.log(' ', commentPath);
  console.log(' ', jsonPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
