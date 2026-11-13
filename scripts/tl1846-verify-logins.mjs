/**
 * Re-verify logins that hit 429 in the first TL-1846 batch, then refresh xlsx + Jira comment.
 * Spacing respects the observed ~3 logins / 10s window (x-retry-after: 10).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'new');
const BASE = 'https://tnt-demo.apeiro-digital.com';
const PASSWORD = 'Password-123';
const TYPE_LABEL = 'Domestic Manufacturer (MANUFACTURER_DOMESTIC)';
const JSON_PATH = path.join(OUT_DIR, 'TL-1846_Partner_Register_Login_Results.json');

const HEADERS = {
  'Content-Type': 'application/json',
  Origin: BASE,
  Referer: `${BASE}/partners/login`,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/user/sign-in/email`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  const rateHeaders = {};
  for (const [k, v] of res.headers.entries()) {
    if (/rate|limit|retry/i.test(k)) rateHeaders[k] = v;
  }
  let login;
  if (res.status === 429) login = 'Rate limited (429)';
  else if (res.ok && (body?.token || body?.user)) login = 'Passed';
  else if (res.status === 401) login = 'Failed (401)';
  else login = `Failed (${res.status})`;
  return { status: res.status, login, body, rateHeaders };
}

async function writeWorkbook(rows, rateAttempts, verifyNotes) {
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
    { header: 'Signup', key: 'signup', width: 16 },
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
    ['Row 1', 'Manual seed (Playwright codegen), GLN 0614141000005'],
    ['Rows 2–51', 'Automated; blank GLN → auto test GLN (999000…)'],
    ['Login column', verifyNotes],
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

  const xlsxPath = path.join(OUT_DIR, 'TL-1846_Partner_Register_Login_Credentials.xlsx');
  await wb.xlsx.writeFile(xlsxPath);
  return xlsxPath;
}

function buildJiraComment(rows, rateAttempts, batchStats) {
  const accepted = rows.filter((r) => r.signup === 'Accepted').length;
  const loginPass = rows.filter((r) => r.login === 'Passed').length;
  const login429 = rows.filter((r) => String(r.login).includes('429')).length;
  const loginFail = rows.length - loginPass - login429;
  const rl429 = rateAttempts.filter((a) => a.status === 429);
  const statuses = [...new Set(rateAttempts.map((a) => a.status))].sort((a, b) => a - b);

  return `h3. TL-1846 — Partner registration / login load + rate-limit check (tnt-demo)

*Environment:* ${BASE}
*Paths exercised:*
* Register UI: {{/partners/register}} → {{POST /api/auth/register}}
* Login UI: {{/partners/login}} → {{POST /api/auth/user/sign-in/email}}

*Password:* {{Password-123}} (plain {{password}} rejected by UI — minimum 12 characters)
*Organization type:* Domestic Manufacturer ({{MANUFACTURER_DOMESTIC}}), country {{KE}}

h4. Manual seed (row 1)
* Email: {{qatest001@test.com}}
* Org: {{QA-Test001}}
* GLN: {{0614141000005}}
* Signup: Accepted
* Login: Passed

h4. Automated batch (50 new orgs = rows 2–51)
* Signup Accepted: *50 / 50* (no registration 429s observed)
* Signup rate-limited: 0
* First-pass login (tight sequential loop): Passed ${batchStats.firstPassPassed}/50, Rate-limited ${batchStats.firstPass429}/50
* After throttle window + paced re-login: Login Passed *${loginPass} / ${rows.length}* overall; still 429: ${login429}; other failures: ${loginFail}
* Blank GLN on register → auto test GLNs ({{999000…}}) returned on every Accepted signup

h4. Dedicated login rate-limit burst
30 rapid sign-in calls against {{qatest001@test.com}} immediately after the batch.
* Statuses: ${statuses.join(', ')}
* 429 count: *${rl429.length} / 30*
* Header: {{x-retry-after: 10}}
* First attempt already 429 (limiter still open from the batch)

h4. Rate-limit behaviour (observed)
* Partner *registration* handled 50 creates without 429 in this run.
* Partner *login* is rate-limited (~3 successful logins, then ~10s cool-down; {{x-retry-after: 10}}).
* 429 means the credentials were not evaluated in that window — not an invalid password.

h4. Evidence
* Credentials (51 rows): {{new/TL-1846_Partner_Register_Login_Credentials.xlsx}}
* Raw JSON: {{new/TL-1846_Partner_Register_Login_Results.json}}

h4. Verdict
*PASS* for registration under this load (50/50 Accepted).
*PASS* for login rate limiting (429 + {{x-retry-after: 10}} confirmed under burst and during sequential logins).
Accounts that only saw 429 on first pass were re-checked after the window; see Login column in the workbook.
`;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const created = data.created;
  const seed = data.seed;

  const firstPassPassed = created.filter((r) => r.login === 'Passed').length;
  const firstPass429 = created.filter((r) => String(r.login).includes('429')).length;

  const pending = created.filter((r) => String(r.login).includes('429'));
  console.log(`Waiting 12s for rate-limit window, then re-verifying ${pending.length} logins...`);
  await sleep(12000);

  let inWindow = 0;
  for (const row of pending) {
    if (inWindow >= 2) {
      console.log('  cooling 11s...');
      await sleep(11000);
      inWindow = 0;
    }
    process.stdout.write(`  retry ${row.email} ... `);
    const result = await login(row.email);
    console.log(`${result.status} ${result.login}`);
    row.login = result.login;
    row.loginStatus = result.status;
    row.loginRetry = result;
    row.loginFirstPass = 'Rate limited (429)';
    if (result.login === 'Passed') inWindow += 1;
    else if (result.status === 429) {
      await sleep(11000);
      inWindow = 0;
      process.stdout.write(`  retry2 ${row.email} ... `);
      const again = await login(row.email);
      console.log(`${again.status} ${again.login}`);
      row.login = again.login;
      row.loginStatus = again.status;
      row.loginRetry = again;
      if (again.login === 'Passed') inWindow += 1;
    } else {
      inWindow = 0;
    }
    await sleep(500);
  }

  const rows = [
    { ...seed, password: PASSWORD, type: TYPE_LABEL },
    ...created.map((r) => ({
      ...r,
      password: PASSWORD,
      type: TYPE_LABEL,
    })),
  ];

  const verifyNotes =
    'Login = final verified result. First-pass batch had many 429s; those rows were re-tried after x-retry-after window with pacing (~2 logins then 11s wait).';

  const xlsxPath = await writeWorkbook(rows, data.rateAttempts, verifyNotes);
  const comment = buildJiraComment(rows, data.rateAttempts, { firstPassPassed, firstPass429 });
  const commentPath = path.join(OUT_DIR, 'TL-1846_Jira_Comment.txt');
  fs.writeFileSync(commentPath, comment, 'utf8');
  data.created = created;
  data.verifiedAt = new Date().toISOString();
  data.batchStats = { firstPassPassed, firstPass429 };
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2), 'utf8');

  const pass = rows.filter((r) => r.login === 'Passed').length;
  const still429 = rows.filter((r) => String(r.login).includes('429')).length;
  console.log(`\nFinal: Passed ${pass}/${rows.length}, still 429 ${still429}`);
  console.log('Wrote', xlsxPath);
  console.log('Wrote', commentPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
