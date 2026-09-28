/**
 * Desktop GUI process.
 *
 * The persistent Electron host lives in `backend.ts`; this process owns only the window and
 * proxies its allowlisted renderer calls to that host.
 */
if (process.argv.includes('--daemon-host') || process.argv.includes('--background')) {
  // Electron selects one package main entry. The persistent host is a separate compiled entry,
  // so this explicit launch flag is the one unavoidable runtime selection point.
  require('./desktop-backend.js');
} else {
  require('./daemon-client.js');
}
