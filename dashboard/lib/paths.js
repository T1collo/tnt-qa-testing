// Turbopack/webpack rewrite __dirname inside bundled server code to point into .next/,
// not the original lib/ source file - so path.join(__dirname, '..', '..') silently resolves
// to the wrong place once Next.js is involved (confirmed: works fine under plain `node`,
// breaks under `next dev`). process.cwd() is a real OS-level property Next.js doesn't touch,
// and this app is always started with `npm run dev`/`npm start` from inside dashboard/, so
// it reliably points one level below the parent qa-testing-suite repo root.
// The Playwright specs also load these modules, but from the repo root itself; that root is
// recognised by its playwright.config.js.
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = fs.existsSync(path.join(process.cwd(), 'playwright.config.js'))
  ? process.cwd()
  : path.join(process.cwd(), '..');

module.exports = { PROJECT_ROOT };
