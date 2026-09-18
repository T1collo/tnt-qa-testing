// Turbopack/webpack rewrite __dirname inside bundled server code to point into .next/,
// not the original lib/ source file - so path.join(__dirname, '..', '..') silently resolves
// to the wrong place once Next.js is involved (confirmed: works fine under plain `node`,
// breaks under `next dev`). process.cwd() is a real OS-level property Next.js doesn't touch,
// and this app is always started with `npm run dev`/`npm start` from inside dashboard/, so
// it reliably points one level below the parent qa-testing-suite repo root.
const path = require('path');

const PROJECT_ROOT = path.join(process.cwd(), '..');

module.exports = { PROJECT_ROOT };
