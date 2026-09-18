// Pretty-prints an EPCIS document the way it is written by hand for a POST body: lists of
// identifiers and small objects stay on one line, everything else is indented.
//   "epcList": ["urn:epc:id:sgtin:...", "urn:epc:id:sgtin:..."],
//   "readPoint": { "id": "urn:epc:id:sgln:0614141.00001.0" },
// The result is ordinary JSON - it parses to exactly the same document.
const isPrimitive = (v) => v === null || typeof v !== 'object';

function inline(value) {
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  const parts = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

function canInline(value) {
  if (Array.isArray(value)) return value.every(isPrimitive);
  const entries = Object.entries(value);
  return entries.length <= 3 && entries.every(([, v]) => isPrimitive(v)) && inline(value).length <= 90;
}

function format(value, indent = '') {
  if (isPrimitive(value)) return JSON.stringify(value);
  if (canInline(value)) return inline(value);
  const next = `${indent}  `;
  if (Array.isArray(value)) {
    return `[\n${value.map((v) => `${next}${format(v, next)}`).join(',\n')}\n${indent}]`;
  }
  const body = Object.entries(value)
    .map(([k, v]) => `${next}${JSON.stringify(k)}: ${format(v, next)}`)
    .join(',\n');
  return `{\n${body}\n${indent}}`;
}

function formatEpcis(document) {
  return `${format(document)}\n`;
}

module.exports = { formatEpcis };
