import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse, RESPONSE_SCHEMA, PROMPT, buildPrompt } from './prompt.js';

test('a good response passes through with its items', () => {
  const r = parseResponse({ is_food: true, items: [{ name: 'apple', grams: 180 }], note: '' });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
});

test('"not food" is distinguished from "found nothing"', () => {
  assert.equal(parseResponse({ is_food: false, items: [], note: 'A cat.' }).reason, 'not_food');
  assert.equal(parseResponse({ is_food: true, items: [], note: '' }).reason, 'nothing_found');
});

test('the note survives a failed reading, because it explains the failure', () => {
  const r = parseResponse({ is_food: false, items: [], note: 'This is a bicycle.' });
  assert.equal(r.note, 'This is a bicycle.');
});

test('junk in produces a refusal, not a throw', () => {
  for (const bad of [null, undefined, 'text', 42]) {
    assert.equal(parseResponse(bad).ok, false);
    assert.equal(parseResponse(bad).reason, 'unreadable');
  }
});

test('the schema requires the fields the estimate model depends on', () => {
  const item = RESPONSE_SCHEMA.properties.items.items;
  for (const field of ['name', 'grams', 'calories', 'protein_g', 'fat_g', 'carbs_g']) {
    assert.ok(item.required.includes(field), `${field} must be required`);
  }
});

test('the prompt asks for the whole portion, not a standard serving', () => {
  assert.match(PROMPT, /not per\s+100 g/i);
  assert.match(PROMPT, /cooking fat|dressing/i);
});

test('a correction is stated as fact, not offered as a suggestion', () => {
  const p = buildPrompt('it is vegetarian, not chicken');
  assert.match(p, /it is vegetarian, not chicken/);
  assert.match(p, /Treat this as fact/i);
  // A model told to "consider" an alternative will usually keep its own
  // answer, which is the failure this exists to prevent.
  assert.doesNotMatch(p, /consider whether|you may wish/i);
});

test('a correction asks for a fresh reading, not an adjustment', () => {
  // Swapping chicken for falafel changes the whole dish, not one line of it.
  assert.match(buildPrompt('falafel'), /work the nutrition out again/i);
});

test('no correction leaves the prompt exactly as it was', () => {
  assert.equal(buildPrompt(null), PROMPT);
  assert.equal(buildPrompt('   '), PROMPT);
});

test('an overlong correction is trimmed rather than sent whole', () => {
  // The cap is on the quoted correction, not on the prompt: the instruction
  // around it is fixed, so assert against the quoted text itself.
  const p = buildPrompt('x'.repeat(500));
  assert.ok(!p.includes('x'.repeat(201)), 'the quote is capped');
  assert.ok(p.includes('x'.repeat(200)), 'and capped at 200, not mangled');
});
