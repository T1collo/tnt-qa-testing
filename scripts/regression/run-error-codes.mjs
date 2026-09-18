// Runs a chosen subset of the 52-case error-code collection through Newman and redacts the
// result. The collection is flat - setup requests sit as separate items just before their
// assertion - so a case is selected together with the setup items that precede it.
//
// Newman's JSON reporter embeds request headers, which means the partner API keys. A leak
// was already found and cleaned out of these reports on 14 Sep, so redaction here is not
// optional: the output file is rewritten before this script returns.
//
// Run: node --env-file=.env scripts/regression/run-error-codes.mjs --out=<file> TC-S1-006 ...
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Newman as a library rather than a CLI: spawning it on Windows needs a shell, and the
// partner keys would then travel through an unescaped command line.
const newman = createRequire(import.meta.url)('newman');

const ROOT = path.join(import.meta.dirname, '..', '..');
const SOURCE = path.join(ROOT, 'postman', 'TnT-ErrorCodes-52.postman_collection.json');

const args = process.argv.slice(2);
const outFile = path.resolve(args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'error-codes-subset.json');
const wanted = new Set(args.filter((a) => a.startsWith('TC-')));
if (!wanted.size) throw new Error('Name at least one TC-S1-### case');

const collection = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const items = collection.item;
const isSetup = (item) => /setup/i.test(item.name) && !/^TC-S1-/.test(item.name.trim());

const picked = [];
for (let i = 0; i < items.length; i += 1) {
  const id = (items[i].name.match(/^(TC-S1-\d+)/) || [])[1];
  if (!wanted.has(id)) continue;
  const chain = [];
  for (let j = i - 1; j >= 0 && isSetup(items[j]); j -= 1) chain.unshift(items[j]);
  picked.push(...chain, items[i]);
}

const subset = { ...collection, item: picked };
const tmp = path.join(path.dirname(outFile), `.subset-${Date.now()}.postman_collection.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(tmp, JSON.stringify(subset));

const secrets = [
  process.env.MANUFACTURER_API_TOKEN,
  process.env.DISTRIBUTOR_API_TOKEN,
  process.env.FACILITY_API_TOKEN,
].filter(Boolean);

try {
  await new Promise((resolve, reject) => {
    newman.run(
      {
        collection: subset,
        envVar: [
          { key: 'base_url', value: process.env.API_BASE_URL },
          { key: 'mfg_token', value: process.env.MANUFACTURER_API_TOKEN ?? '' },
          { key: 'fac_token', value: process.env.FACILITY_API_TOKEN ?? '' },
        ],
        reporters: ['cli', 'json'],
        reporter: { json: { export: outFile } },
        timeoutRequest: 60000,
      },
      // A failed assertion is an expected outcome here, not a run failure.
      (err) => (err ? reject(err) : resolve())
    );
  });
} finally {
  fs.rmSync(tmp, { force: true });
}

// Redact every occurrence of a key, wherever Newman put it.
let text = fs.readFileSync(outFile, 'utf8');
for (const secret of secrets) text = text.split(secret).join('***REDACTED***');
fs.writeFileSync(outFile, text);

const leaked = secrets.some((s) => fs.readFileSync(outFile, 'utf8').includes(s));
console.log(`\n${picked.length} requests -> ${path.relative(process.cwd(), outFile)}  (keys redacted: ${!leaked})`);
if (leaked) process.exit(2);
