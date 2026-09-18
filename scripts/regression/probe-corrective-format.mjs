// Does the platform check that correctiveEventIDs exist, in both formats? The original event is
// submitted first (so only the corrective reference is missing), then a declaration pointing at
// a UUID that has never been submitted anywhere.
// Run: node --env-file=.env scripts/regression/probe-corrective-format.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// PROJECT_ROOT is fixed at module load as cwd/.., so enter dashboard/ before requiring.
process.chdir(new URL('../../dashboard/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const runner = createRequire(import.meta.url)('../../dashboard/lib/postmanRunner.js');
const collection = runner.loadCollection();

const URL_M = `${process.env.API_BASE_URL}/api/integration/manufacturer/events`;
const KEY = process.env.MANUFACTURER_API_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (body, ct) => {
  const res = await fetch(URL_M, { method: 'POST', headers: { 'Content-Type': ct, 'X-API-Key': KEY }, body });
  const text = await res.text();
  let code = ''; try { code = JSON.parse(text).code || ''; } catch { /* */ }
  return `${res.status}${code ? ` ${code}` : ''}`;
};

for (const [variant, ct] of [['JSON-LD', 'application/ld+json'], ['XML', 'application/xml']]) {
  const raw = runner.findNode(collection.item, ['Special Events', 'Error Declaration', 'Incorrect Data - with corrective event (Manufacturer)', variant]).request.body.raw;
  const built = runner.freshenBusinessData(runner.freshenEventIds(raw));
  const ghost = `urn:uuid:${crypto.randomUUID()}`; // never submitted
  // Point the declaration at the ghost instead of its (never-created) corrective event.
  const correctiveRef = (built.match(/"correctiveEventIDs"\s*:\s*\[\s*"([^"]+)"/) || built.match(/<correctiveEventID>\s*([^<\s]+)/))[1];
  const declaration = built.split(correctiveRef).join(ghost);
  const original = await post(runner.withoutErrorDeclaration(declaration), ct);
  await sleep(6000);
  const decl = await post(declaration, ct);
  console.log(`${variant.padEnd(8)} original -> ${original.padEnd(6)}  declaration citing a non-existent corrective event -> ${decl}`);
}
