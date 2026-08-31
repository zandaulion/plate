// Interaction tracking, off unless the server says this account opted in.
//
// The derived report in /api/usage sees everything that left a row behind.
// This is for what did not: a sheet opened and abandoned, a search that came
// back empty, a scan that timed out, a button hunted for. None of that leaves
// a trace unless something writes one.
//
// Nothing is collected until `start()` is called with the flag the server
// returned, and the server discards batches from accounts it has not enabled
// regardless of what any client believes. Two independent checks, because the
// people who receive an invitation to this app are told it tracks nothing.
//
// No food names, no calories, no weights. Those already live in entries, and a
// usability log should not become a second copy of a person's diary.

let on = false;
let queue = [];
let session = null;
let flushTimer = null;

const now = () => new Date().toISOString();

export function start(enabled) {
  on = Boolean(enabled);
  if (!on) { queue = []; return; }
  session = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // Send on the way out as well as on a timer: an abandoned sheet is exactly
  // the event most likely to be followed by the tab closing.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', () => flush(true));
}

export function track(name, props) {
  if (!on) return;
  queue.push({ name, at: now(), session, props: props || undefined });
  if (queue.length >= 40) return flush();
  if (!flushTimer) flushTimer = setTimeout(() => flush(), 8000);
}

function flush(beacon = false) {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!on || !queue.length) return;

  const batch = queue;
  queue = [];
  const body = JSON.stringify({ events: batch });

  // sendBeacon survives the page going away, which fetch does not.
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }));
    return;
  }
  fetch('/api/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true
  }).catch(() => { /* losing a usability event must never disturb the app */ });
}

/**
 * Times a screen and reports how long it was open on close. Duration is the
 * point: a review sheet held for two minutes and then abandoned says something
 * a tap count cannot.
 */
export function screen(name) {
  if (!on) return () => {};
  const opened = Date.now();
  track('screen_open', { screen: name });
  let closed = false;
  return (extra) => {
    if (closed) return;
    closed = true;
    track('screen_close', { screen: name, seconds: (Date.now() - opened) / 1000, ...(extra || {}) });
  };
}
