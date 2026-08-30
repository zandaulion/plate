import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse, RESPONSE_SCHEMA, PROMPT } from './prompt.js';

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
