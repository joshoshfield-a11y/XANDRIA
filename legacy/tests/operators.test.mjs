import { test } from 'node:test';
import assert from 'node:assert';
import { applyOperators } from '../core/operators.mjs';

test('Operators: Should detect Intent', (t) => {
  const hits = applyOperators('Create a web app with Intent', { intent: 'test', root: '.' });
  assert.ok(hits.includes(3), 'OP-03 Intent should be detected');
});

test('Operators: Should detect explicit OP-ID', (t) => {
  const hits = applyOperators('Build this with OP-72', { intent: 'test', root: '.' });
  assert.ok(hits.includes(72), 'OP-72 Seal should be detected by ID');
});

test('Operators: Should detect name match', (t) => {
  const hits = applyOperators('Secure this with Lock', { intent: 'test', root: '.' });
  assert.ok(hits.includes(51), 'OP-51 Lock should be detected by Name');
});
