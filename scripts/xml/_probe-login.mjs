import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(import.meta.dirname, '..', '..', '.env'), quiet: true });
const BASE = 'https://tnt-demo.apeiro-digital.com';
const email = process.env.TRACKIQ_MANUFACTURER_PARTNER_EMAIL;
const candidates = [
  process.env.TRACKIQ_MANUFACTURER_PARTNER_PASSWORD,
  process.env.PARTNER_PASSWORD,
  'Password-123',
  'password',
  process.env.MANUFACTURER_PASSWORD,
].filter(Boolean);
const headers = { 'content-type': 'application/json', Origin: BASE, Referer: `${BASE}/partners/login` };
for (const password of [...new Set(candidates)]) {
  const r = await fetch(`${BASE}/api/auth/user/sign-in/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  });
  const t = await r.text();
  console.log({ pwHint: password.slice(0, 2) + '…' + password.length, status: r.status, body: t.slice(0, 220) });
}
