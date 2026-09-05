/**
 * Every translatable string in the app, gathered from where it is used.
 *
 * The English text is the key, so there is no separate en.json to drift out of
 * step -- this walks the sources instead and is the single answer to "what
 * needs translating". `npm run i18n:check` diffs it against ro.json.
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Source-level escapes, so the key matches the string the engine builds. */
const unescapeJs = (s) => s
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');

function fromHtml(src) {
  const out = [];
  for (const m of src.matchAll(/data-i18n(?:-placeholder|-label|-title)?="([^"]+)"/g)) {
    // The browser decodes these when the attribute is read through dataset,
    // so the key at runtime is the decoded text and this must match it.
    out.push(m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                 .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                 .replace(/&#(?:39|x27);/g, "'"));
  }
  return out;
}

/** First argument of t(...) / plural(...), when it is a plain literal. */
function fromJs(src) {
  const out = [];
  for (const m of src.matchAll(/\b(?:t|plural)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
    out.push(unescapeJs(m[2]));
  }
  return out;
}

/**
 * Bitey's lines and the sheet titles: arrays and tables translated on read, so
 * the literal never appears as an argument to t() for the scanner to find.
 */
function fromTables(src) {
  const out = [];
  for (const name of ['BITEY_CHEERS', 'BITEY_QUOTES']) {
    const m = new RegExp(name + '\\s*=\\s*\\[([\\s\\S]*?)\\n\\];').exec(src);
    if (!m) continue;
    for (const q of m[1].matchAll(/"((?:\\.|[^"])*)"/g)) out.push(unescapeJs(q[1]));
  }
  const titles = /SHEET_TITLES\s*=\s*\{([\s\S]*?)\n\};/.exec(src);
  if (titles) {
    for (const q of titles[1].matchAll(/'((?:\\.|[^'])*)'/g)) out.push(unescapeJs(q[1]));
  }
  return out;
}

/** `text:` in the recommendation engine is a template and doubles as the key. */
function fromRecommendations(src) {
  const out = [];
  for (const m of src.matchAll(/text:\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
    out.push(unescapeJs(m[2]));
  }
  return out;
}

/**
 * Keys that reach t() through a variable rather than as a literal argument.
 *
 * The gate's three modes live in a table and are translated where they are
 * read; the macro names and the recommendation suggestions come from data.
 * The scanner cannot see any of them, so they are declared instead of being
 * silently dropped.
 */
const INDIRECT = [
  'Invite code', 'Link code', 'Recovery code',
  'The code you were sent.',
  'The code you saved when you first signed in.',
  'Open Plate on a device you are already signed in on, and add this one from there.',
  'Protein', 'Carbs', 'Fat', 'Fiber',
  // The profile fields the maintenance estimate is missing, named in the
  // banner that asks for them.
  'weight', 'height', 'your birth year', 'how active you are',
  // Activity levels, offered in the profile select.
  'Desk job, little or no exercise', 'Light exercise, 1-3 days a week',
  'Moderate exercise, 3-5 days a week', 'Hard exercise, 6-7 days a week',
  'Physical job, or training twice a day',
  'none of it', 'a quarter', 'half', 'three quarters', 'all of it',
  'none', 'all',
  // Quick bites: named in core, rendered by label on the tile and by name in
  // the aria-label and the entry it creates.
  'Bite (~50 kcal)', 'Handful (~100 kcal)', 'Snack (~200 kcal)',
  'Bite', 'Handful', 'Snack'
];

export function allKeys() {
  const keys = [
    ...fromHtml(read('web/index.html')),
    ...fromJs(read('web/app.js')),
    ...fromTables(read('web/app.js')),
    ...fromRecommendations(read('core/recommendations.js')),
    ...INDIRECT
  ];
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const keys = allKeys();
  if (process.argv.includes('--check')) {
    const ro = JSON.parse(read('web/i18n/ro.json'));
    const missing = keys.filter((k) => !(k in ro));
    const orphan = Object.keys(ro).filter((k) => !keys.includes(k));
    if (missing.length) console.log(`missing ${missing.length}:\n` + missing.map((k) => '  ' + k).join('\n'));
    if (orphan.length) console.log(`orphaned ${orphan.length}:\n` + orphan.map((k) => '  ' + k).join('\n'));
    if (!missing.length && !orphan.length) console.log(`ro.json covers all ${keys.length} keys.`);
    process.exit(missing.length || orphan.length ? 1 : 0);
  }
  console.log(JSON.stringify(keys, null, 1));
}
