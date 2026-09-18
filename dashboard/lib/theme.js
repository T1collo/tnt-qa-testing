// Shared by the client ThemeProvider and the blocking pre-paint script in app/layout.js.
// Deliberately a plain module with no "use client": importing a value out of a client
// module into a server component yields a client reference, not the string itself, which
// silently compiled the pre-paint script down to localStorage.getItem(undefined).
const THEME_STORAGE_KEY = 'tnt-qa-theme';

module.exports = { THEME_STORAGE_KEY };
