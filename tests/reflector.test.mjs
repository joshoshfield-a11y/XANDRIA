import { test } from 'node:test';
import assert from 'node:assert';
import { measure } from '../core/reflector.mjs';

test('Reflector: Score should be 0 for empty payload', () => {
  const m = measure({});
  assert.strictEqual(m.score, 0);
});

test('Reflector: Score should increase with intent', () => {
  const m = measure({ intent: 'test' });
  assert.strictEqual(m.score, 1);
});

test('Reflector: Score should max with files', () => {
  const m = measure({ intent: 'test', generatedFiles: ['index.html'] });
  assert.strictEqual(m.score, 2);
});
