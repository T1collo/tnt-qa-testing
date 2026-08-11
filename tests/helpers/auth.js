const CREDS = {
  admin: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
  kemsa: { email: process.env.KEMSA_EMAIL, password: process.env.KEMSA_PASSWORD },
  manufacturer: { email: process.env.MANUFACTURER_EMAIL, password: process.env.MANUFACTURER_PASSWORD },
};

async function loginAs(page, role) {
  const creds = CREDS[role];
  if (!creds || !creds.email || !creds.password) {
    throw new Error(`Missing credentials for role "${role}" - check your .env file (see .env.example)`);
  }
  await page.goto('/login', { waitUntil: 'load' });
  await page.locator('#email').fill(creds.email);
  await page.locator('#password').fill(creds.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
  await page.waitForTimeout(500);
}

module.exports = { loginAs, CREDS };
