// Does the integration API honour an eventID wrapped in <baseExtension> (EPCIS 1.2 XML)?
// Partner docs (Technical Guides): top-level <eventID> or <baseExtension><eventID> is accepted;
// either placement drives idempotency; a reused eventID is rejected with DUPLICATE_EVENT_ID.
//
// Every XML sample is taken live from <env>/partners/docs and sent four times per partner,
// each with fresh serials/SSCCs/timestamps so payload dedupe cannot mask eventID dedupe:
//   A       docs sample as-is (top-level eventID)            -> control
//   B       same, eventID wrapped in <baseExtension>          -> the only change under test
//   B-reID  fresh payload, B's eventID again in baseExtension -> expect DUPLICATE_EVENT_ID
//   X-reID  fresh payload, B's eventID at top level           -> expect DUPLICATE_EVENT_ID
// Normal events go to their owning partner; special events are sent by every partner.
// Run: node --env-file=.env scripts/regression/probe-base-extension.mjs --env=staging
//      (--env=demo uses API_BASE_URL + *_API_TOKEN; staging uses TRACKIQ_BASE_URL + TRACKIQ_*_API_TOKEN)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.chdir(path.join(ROOT, 'dashboard'));
const runner = createRequire(import.meta.url)('../../dashboard/lib/postmanRunner.js');

const ENV = (process.argv.find((a) => a.startsWith('--env=')) || '--env=demo').slice(6);
const STAGING = ENV === 'staging';
const BASE = (STAGING ? process.env.TRACKIQ_BASE_URL : process.env.API_BASE_URL).replace(/\/+$/, '');
const key = (role) => process.env[`${STAGING ? 'TRACKIQ_' : ''}${role.toUpperCase()}_API_TOKEN`];
const ROUTE = {
  manufacturer: '/api/integration/manufacturer/events',
  distributor: '/api/integration/supplier/events',
  facility: '/api/integration/facility/events',
  dispense: '/api/integration/facility/events/dispense',
};
const day = new Date().toISOString().slice(0, 10);
const OUT = path.join(ROOT, `reports/regression/${day}/base-extension-${ENV}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Docs sample titles (after "EPCIS 1.2 XML – ").
const NORMAL = [
  ['manufacturer', 'manufacturer', ['Commissioning', 'Packing', 'SSCC-to-SSCC Packing', 'Shipping']],
  ['distributor', 'distributor', ['Distributor Receiving', 'Unpack', 'Distributor Packing', 'Distributor Shipping']],
  ['facility', 'facility', ['Facility Receiving', 'Facility Unpack']],
  ['facility', 'dispense', ['All-serialized Dispense (without quantityList)', 'Mixed Dispense (serialized + extra class-level quantity)']],
];
const SPECIAL = ['Regulator Approval', 'Return Shipping', 'Return Receiving', 'Recall Initiation', 'Damaged', 'Stolen',
  'Lost', 'Expired', 'Destruction Completion', 'Export', 'Stock Adjustment'];
const CASES = [
  ...NORMAL.flatMap(([role, route, events]) => events.map((event) => ({ kind: 'Normal', role, route, event }))),
  ...['manufacturer', 'distributor', 'facility'].flatMap((role) => SPECIAL.map((event) => ({ kind: 'Special', role, route: role, event }))),
];

async function docsSamples() {
  const html = await (await fetch(`${BASE}/partners/docs`)).text();
  for (const chunk of new Set(html.match(/\/_next\/static\/chunks\/[^"]+\.js/g))) {
    const src = await (await fetch(`${BASE}${chunk}`)).text();
    if (!src.includes('language:"xml",title:"EPCIS 1.2 XML')) continue;
    const vars = {};
    for (const m of src.matchAll(/([A-Za-z_$][\w$]{0,3})=(`|")((?:<\?xml|<epcis:EPCISDocument)[\s\S]*?)\2[,;]/g)) {
      vars[m[1]] = m[2] === '"' ? JSON.parse(`"${m[3]}"`) : m[3];
    }
    const samples = {};
    for (const m of src.matchAll(/code:([A-Za-z_$][\w$]{0,3}),language:"xml",title:"EPCIS 1\.2 XML – ([^"]+)"/g)) {
      samples[m[2]] = vars[m[1]];
    }
    return samples;
  }
  throw new Error(`XML samples not found in ${BASE}/partners/docs bundle`);
}

const fresh = (raw) => runner.freshenBusinessData(runner.freshenEventIds(raw));
const idOf = (xml) => xml.match(/<eventID>\s*([^<\s]+)\s*<\/eventID>/)[1];
const setId = (xml, id) => xml.replace(/(<eventID>)\s*[^<\s]+\s*(<\/eventID>)/, `$1${id}$2`);
// The only change under test: wrap the event's <eventID> in <baseExtension>, in place.
const wrap = (xml) => xml.replace(/^([ \t]*)(<eventID>[^<]*<\/eventID>)/m,
  (_, ind, tag) => `${ind}<baseExtension>\n${ind}  ${tag}\n${ind}</baseExtension>`);

async function post(route, role, body) {
  // Retry only network drops (ECONNRESET etc.), never an HTTP answer. A retried send is flagged:
  // if the dropped attempt did reach the server, the retry can legitimately come back 409.
  let res;
  let retried = false;
  for (let attempt = 1; !res; attempt += 1) {
    try {
      res = await fetch(`${BASE}${ROUTE[route]}`, {
        method: 'POST', headers: { 'Content-Type': 'application/xml', 'X-API-Key': key(role) }, body,
      });
    } catch (err) {
      if (attempt === 3) throw err;
      retried = true;
      await sleep(3000);
    }
  }
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return {
    status: res.status,
    code: json.code || json.error?.code || '',
    message: json.message || json.error?.message || '',
    // The dispense endpoint answers with a single event_id; the event routes with event_ids[].
    eventIds: json.event_ids || (json.event_id ? [json.event_id] : []),
    sandbox: json._sandbox === true,
    retried,
    warnings: (json.warnings || []).map((w) => w.code).sort(),
    raw: text.slice(0, 2000),
  };
}

function verdict({ A, B, 'B-reID': BR, 'X-reID': XR }) {
  if (A.status !== B.status || A.code !== B.code || A.warnings.join() !== B.warnings.join()) return 'FAIL';
  if (B.status >= 300) return B.code === 'PARTNER_TYPE_BIZSTEP_MISMATCH' ? 'N/A (role)' : `N/A (sample rejected)`;
  return B.idEchoed && BR.code === 'DUPLICATE_EVENT_ID' && XR.code === 'DUPLICATE_EVENT_ID' ? 'PASS' : 'FAIL';
}

const samples = await docsSamples();
fs.mkdirSync(path.join(OUT, 'bodies'), { recursive: true });
const results = [];

for (const c of CASES) {
  const raw = samples[c.event];
  if (!raw) { results.push({ ...c, missing: true }); console.log(`${c.event}: no docs sample`); continue; }
  const b = wrap(fresh(raw));
  const bId = idOf(b);
  const sends = [['A', fresh(raw)], ['B', b], ['B-reID', setId(wrap(fresh(raw)), bId)], ['X-reID', setId(fresh(raw), bId)]];
  const row = { ...c, bId, sends: {} };
  for (const [variant, body] of sends) {
    const r = await post(c.route, c.role, body);
    r.sentId = idOf(body);
    r.epcs = [...new Set(body.match(/urn:epc:(?:id:(?:sgtin|sscc)|class:lgtin):[0-9A-Za-z.]+/g) || [])];
    r.idEchoed = r.eventIds.includes(r.sentId);
    row.sends[variant] = r;
    fs.writeFileSync(path.join(OUT, 'bodies', `${c.role}-${c.event.replace(/\W+/g, '-')}-${variant}.xml`), body);
    console.log(`${c.role.padEnd(12)} ${c.event.slice(0, 26).padEnd(26)} ${variant.padEnd(6)} ${r.status} ${r.code.padEnd(29)} echoed=${r.idEchoed ? 'Y' : 'N'} warn=[${r.warnings.join(',')}]`);
    await sleep(1000);
  }
  row.verdict = verdict(row.sends);
  results.push(row);
}

fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));

// Jira (wiki markup) tables + a flat CSV of every eventID and EPC sent.
const done = results.filter((r) => !r.missing);
const count = (v) => done.filter((r) => r.verdict.startsWith(v)).length;
const st = (s) => `${s.status}${s.code ? ` ${s.code}` : ''}`;
const flag = (v) => (v === 'PASS' ? '(/)' : v === 'FAIL' ? '(x)' : '(!)');
const jira = `h2. EPCIS 1.2 XML: eventID inside <baseExtension>, all partners. Overall result: ${count('FAIL') ? 'FAIL' : 'PASS'}

*Environment:* ${BASE} (${ENV}), XML samples from Partner Docs > Technical Guides, run ${new Date().toISOString()}
*Only change:* {{<eventID>}} wrapped in {{<baseExtension>...</baseExtension>}}

h3. Numbers
* *${done.length}* partner/event cases, *${done.length * 4}* requests
* *${count('PASS')}* PASS, *${count('FAIL')}* FAIL, *${count('N/A (role)')}* not allowed for the partner type (403 in both placements), *${count('N/A (sample')}* sample rejected identically in both placements

h3. Variants
||Variant||Body||Expected||
| A | Docs sample as-is (top-level eventID), fresh serials | Control |
| B | Same, eventID wrapped in baseExtension | Same outcome as A, eventID echoed |
| B-reID | Fresh payload, B's eventID again inside baseExtension | 409 DUPLICATE_EVENT_ID |
| X-reID | Fresh payload, B's eventID as a top-level eventID | 409 DUPLICATE_EVENT_ID |

h3. Results
||Type||Partner||Event||A top-level||B baseExtension||B eventID echoed||B-reID||X-reID||Verdict||
${done.map((r) => `| ${r.kind} | ${r.role} | ${r.event} | ${st(r.sends.A)} | ${st(r.sends.B)} | ${r.sends.B.idEchoed ? 'Yes' : 'No'} | ${st(r.sends['B-reID'])} | ${st(r.sends['X-reID'])} | ${flag(r.verdict)} ${r.verdict} |`).join('\n')}

h3. Findings
FINDINGS

h3. Event IDs and EPCs (all ${done.length * 4} requests)
||Partner||Event||Variant||eventID||EPCs||HTTP||
${done.flatMap((r) => Object.entries(r.sends).map(([v, s]) => `| ${r.role} | ${r.event} | ${v} | {{${s.sentId}}} | ${s.epcs.map((e) => `{{${e}}}`).join('\\\\ ')} | ${st(s)} |`)).join('\n')}
`;
fs.writeFileSync(path.join(OUT, 'jira-comment.txt'), jira);
fs.writeFileSync(path.join(OUT, 'event-ids.csv'), ['partner,type,event,variant,eventID,http,code,echoed,epcs,warnings',
  ...done.flatMap((r) => Object.entries(r.sends).map(([v, s]) =>
    [r.role, r.kind, r.event, v, s.sentId, s.status, s.code, s.idEchoed, s.epcs.join(' '), s.warnings.join(' ')].map((x) => `"${x}"`).join(',')))].join('\n'));
console.log(`\n${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('N/A (role)')} role-blocked, ${count('N/A (sample')} sample-rejected`);
console.log(`results -> ${path.relative(ROOT, OUT)}`);
