// Single validation rule for the partner API base URL, shared by the client form
// (blur validation) and the /api/run + /api/health routes (authoritative check).
// Deliberately has no node-only imports so it can be bundled into a client component -
// keep it that way, or run.tsx stops building.

// The two partner environments this suite targets. Offered as autocomplete suggestions
// on the Base URL field: API keys are environment-scoped, and a key from the wrong host
// fails with a 401 that reads like a bad token, so making the choice explicit matters.
/** @type {{ url: string, label: string }[]} */
const KNOWN_ENVIRONMENTS = [
  { url: 'https://tnt-demo.apeiro-digital.com', label: 'tnt-demo' },
  { url: 'https://trackiq.apeiro-digital.com', label: 'trackiq' },
];

// Returns { ok: true, value } with trailing slashes stripped so URL joins stay clean,
// or { ok: false, error } with a message written for the person filling in the field.
// The literal `ok` types make this a discriminated union, so TS narrows it at the call site.
/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'Base URL is required.' };
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'Enter a full URL, for example https://tnt-demo.apeiro-digital.com' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Base URL must start with http:// or https://' };
  }
  return { ok: true, value: (parsed.origin + parsed.pathname).replace(/\/+$/, '') };
}

module.exports = { KNOWN_ENVIRONMENTS, normalizeBaseUrl };
