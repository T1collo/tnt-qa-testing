// Loads the parent qa-testing-suite repo's .env so the API base URL stays a single source
// of truth instead of duplicating it into a second .env file inside dashboard/. Only
// non-secret config (the base URL) is read this way - API tokens always come from the
// request body at run time, never from env/disk.
//
// The target is the tnt-demo environment. Partner API keys are environment-scoped: a
// tnt-demo JWT sent to trackiq is rejected with 401 "Invalid API key for this
// environment", so pointing this at the wrong host makes every pasted token look invalid.
const path = require('path');
const dotenv = require('dotenv');
const { PROJECT_ROOT } = require('./paths');
const { normalizeBaseUrl } = require('./baseUrl');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const DEFAULT_BASE_URL = 'https://tnt-demo.apeiro-digital.com';

// The default the Run form is prefilled with. A run can override it per request, so a
// malformed value in .env shouldn't hard-fail the app - fall back to the known default.
function getBaseUrl() {
  const raw = process.env.API_BASE_URL || process.env.BASE_URL || DEFAULT_BASE_URL;
  const normalized = normalizeBaseUrl(raw);
  return normalized.ok ? normalized.value : DEFAULT_BASE_URL;
}

module.exports = { getBaseUrl };
