/**
 * TL-1846 TrackIQ — create 50 partner orgs, log each in, burst-test login rate limits,
 * re-verify any 429 logins, write new/trackiq-creds.xlsx.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'new');
const BASE = 'https://trackiq.apeiro-digital.com';
const PASSWORD = 'Password-123';
const PARTY_TYPE = 'MANUFACTURER_DOMESTIC';
const TYPE_LABEL = 'Domestic Manufacturer (MANUFACTURER_DOMESTIC)';
const COUNTRY = 'KE';
const COUNT = 50;
const XLSX_NAME = 'trackiq-creds.xlsx';
const JSON_NAME = 'TL-1846_TrackIQ_Partner_Register_Login_Results.json';
const COMMENT_NAME = 'TL-1846_TrackIQ_Jira_Comment.txt';

const HEADERS = {
  'Content-Type': 'application/json',
  Origin: BASE,
  Referer: `${BASE}/partners/register`,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function postJson(url, body, referer) {
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, Referer: referer || HEADERS.Referer },
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
  const result = await postJson(
    `${BASE}/api/auth/register`,
    {
      email: row.email,
      password: PASSWORD,
      organization: row.organization,
      party_type: PARTY_TYPE,
      country_code: COUNTRY,
    },
    `${BASE}/partners/register`,
  );
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
  const result = await postJson(
    `${BASE}/api/auth/user/sign-in/email`,
    { email: row.email, password: PASSWORD },
    `${BASE}/partners/login?returnTo=%2Fpartners%2Ftokens`,
  );
  return {
    ...row,
    login: classifyLogin(result.status, result.body),
    loginStatus: result.status,
    loginBody: result.body,
    loginRateHeaders: result.rateHeaders,
    loginMs: result.durationMs,
  };
}

async function rateLimitBurst(email) {
  const attempts = [];
  for (let i = 0; i < 30; i++) {
    const wrong = i % 3 !== 0;
    const result = await postJson(
      `${BASE}/api/auth/user/sign-in/email`,
      {
        email,
        password: wrong ? 'Definitely-Wrong-Password-123' : PASSWORD,
      },
      `${BASE}/partners/login?returnTo=%2Fpartners%2Ftokens`,
    );
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

async function reverify429(rows) {
  const pending = rows.filter((r) => String(r.login).includes('429'));
  const firstPassPassed = rows.filter((r) => r.login === 'Passed').length;
  const firstPass429 = pending.length;
  if (!pending.length) return { firstPassPassed, firstPass429 };

  console.log(`\nWaiting 12s, then re-verifying ${pending.length} rate-limited logins...`);
  await sleep(12000);

  let inWindow = 0;
  for (const row of pending) {
    if (inWindow >= 2) {
      console.log('  cooling 11s...');
      await sleep(11000);
      inWindow = 0;
    }
    row.loginFirstPass = 'Rate limited (429)';
    process.stdout.write(`  retry ${row.email} ... `);
    let result = await loginOne(row);
    console.log(`${result.loginStatus} ${result.login}`);
    row.login = result.login;
    row.loginStatus = result.loginStatus;
    row.loginRetry = result;
    if (result.login === 'Passed') inWindow += 1;
    else if (result.loginStatus === 429) {
      await sleep(11000);
      inWindow = 0;
      process.stdout.write(`  retry2 ${row.email} ... `);
      result = await loginOne(row);
      console.log(`${result.loginStatus} ${result.login}`);
      row.login = result.login;
      row.loginStatus = result.loginStatus;
      row.loginRetry = result;
      if (result.login === 'Passed') inWindow += 1;
    } else {
      inWindow = 0;
    }
    await sleep(500);
  }
  return { firstPassPassed, firstPass429 };
}

async function writeWorkbook(rows, rateAttempts, batchStats) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TL-1846 QA TrackIQ';
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
      password: r.password || PASSWORD,
      organization: r.organization,
      type: r.type || TYPE_LABEL,
      gln: r.gln || '',
      signup: r.signup,
      login: r.login,
    });
    row.font = { name: 'Arial' };
  }

  const notes = wb.addWorksheet('Notes');
  notes.getColumn(1).width = 28;
  notes.getColumn(2).width = 100;
  for (const [k, v] of [
    ['Ticket', 'TL-1846'],
    ['Environment', BASE],
    ['Register', 'POST /api/auth/register'],
    ['Login', 'POST /api/auth/user/sign-in/email'],
    ['Password', PASSWORD],
    ['Org type', TYPE_LABEL],
    ['Country', COUNTRY],
    ['Accounts', `${COUNT} automated (qatiq001–qatiq050); blank GLN → auto test GLN`],
    [
      'Login column',
      `Final verified result. First-pass: Passed ${batchStats.firstPassPassed}/${COUNT}, 429 ${batchStats.firstPass429}/${COUNT}`,
    ],
    ['Generated', new Date().toISOString()],
  ]) {
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

  const xlsxPath = path.join(OUT_DIR, XLSX_NAME);
  await wb.xlsx.writeFile(xlsxPath);
  return xlsxPath;
}

function buildJiraComment(rows, rateAttempts, batchStats) {
  const accepted = rows.filter((r) => r.signup === 'Accepted').length;
  const signup429 = rows.filter((r) => String(r.signup).includes('429')).length;
  const loginPass = rows.filter((r) => r.login === 'Passed').length;
  const login429 = rows.filter((r) => String(r.login).includes('429')).length;
  const loginFail = rows.length - loginPass - login429;
  const rl429 = rateAttempts.filter((a) => a.status === 429);
  const first429 = rl429[0];
  const statuses = [...new Set(rateAttempts.map((a) => a.status))].sort((a, b) => a - b);
  const burstEmail = rows.find((r) => r.login === 'Passed')?.email || rows[0]?.email || 'n/a';

  return `h3. TL-1846 — Partner registration / login load + rate-limit check (TrackIQ)

*Environment:* ${BASE}
*Paths exercised:*
* Register UI: {{/partners/register}} → {{POST /api/auth/register}}
* Login UI: {{/partners/login?returnTo=%2Fpartners%2Ftokens}} → {{POST /api/auth/user/sign-in/email}}

*Password:* {{Password-123}}
*Organization type:* Domestic Manufacturer ({{MANUFACTURER_DOMESTIC}}), country {{KE}}
*Accounts:* {{qatiq001@test.com}} … {{qatiq050@test.com}}

h4. Automated batch (50 orgs)
* Signup Accepted: *${accepted} / ${rows.length}*
* Signup rate-limited (429): ${signup429}
* First-pass login: Passed ${batchStats.firstPassPassed}/${COUNT}, Rate-limited ${batchStats.firstPass429}/${COUNT}
* After throttle window + paced re-login: Login Passed *${loginPass} / ${rows.length}*; still 429: ${login429}; other failures: ${loginFail}
* Blank GLN on register → auto test GLNs returned on Accepted signups

h4. Dedicated login rate-limit burst
30 rapid sign-in calls against {{${burstEmail}}} (mix of wrong/correct password).
* Statuses: ${statuses.join(', ') || 'none'}
* 429 count: *${rl429.length} / 30*${
    first429
      ? `\n* First 429 at attempt #${first429.n} (wrongPassword=${first429.wrongPassword}); headers ${JSON.stringify(first429.rateHeaders)}`
      : '\n* No 429 observed in this burst'
  }

h4. Evidence
* Credentials: {{new/${XLSX_NAME}}}
* Raw JSON: {{new/${JSON_NAME}}}

h4. Verdict
${
    accepted === rows.length
      ? '*PASS* for registration under this load (50/50 Accepted).'
      : `Registration: ${accepted}/${rows.length} Accepted — see workbook.`
  }
${
    rl429.length > 0 || batchStats.firstPass429 > 0
      ? '*PASS* for login rate limiting (429 observed under sequential load and/or burst).'
      : 'Login rate limiting *not* confirmed in this run — see RateLimit sheet.'
  }
`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`TrackIQ: creating ${COUNT} partner accounts (${PASSWORD}) at ${BASE}...`);
  const created = [];
  for (let i = 1; i <= COUNT; i++) {
    const draft = {
      email: `qatiq${pad(i)}@test.com`,
      organization: `QA-Tiq${pad(i)}`,
      source: 'auto',
    };
    process.stdout.write(`  register ${draft.email} ... `);
    let row = await registerOne(draft);
    console.log(`${row.signupStatus} ${row.signup}${row.gln ? ` gln=${row.gln}` : ''}`);
    await sleep(150);

    process.stdout.write(`  login    ${draft.email} ... `);
    row = await loginOne(row);
    console.log(`${row.loginStatus} ${row.login}`);
    created.push(row);
    await sleep(150);
  }

  const burstTarget =
    created.find((r) => r.login === 'Passed')?.email ||
    created.find((r) => r.signup === 'Accepted')?.email ||
    created[0].email;

  console.log(`\nRate-limit burst against ${burstTarget}...`);
  const rateAttempts = await rateLimitBurst(burstTarget);
  for (const a of rateAttempts) {
    console.log(
      `  #${a.n} status=${a.status} wrong=${a.wrongPassword} ${JSON.stringify(a.rateHeaders)}`,
    );
  }

  const batchStats = await reverify429(created);

  const xlsxPath = await writeWorkbook(created, rateAttempts, batchStats);
  const comment = buildJiraComment(created, rateAttempts, batchStats);
  const commentPath = path.join(OUT_DIR, COMMENT_NAME);
  const jsonPath = path.join(OUT_DIR, JSON_NAME);
  fs.writeFileSync(commentPath, comment, 'utf8');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        environment: BASE,
        created,
        rateAttempts,
        batchStats,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  const pass = created.filter((r) => r.login === 'Passed').length;
  const still429 = created.filter((r) => String(r.login).includes('429')).length;
  console.log(
    `\nFinal: Signup Accepted ${created.filter((r) => r.signup === 'Accepted').length}/50; Login Passed ${pass}/50; still 429 ${still429}`,
  );
  console.log('Wrote:');
  console.log(' ', xlsxPath);
  console.log(' ', commentPath);
  console.log(' ', jsonPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
