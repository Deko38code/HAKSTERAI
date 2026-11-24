/* The name the TUI prints for our pinned model.
 *
 * Owner (2026-11-24): "name it HAKSTERAI-FLASH". This is a display label only:
 * the wire model id, the relay and the provider are untouched, so no config or
 * cost moves. These pin both halves — the name shown, and the id still intact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PRIMARY_MODEL, MODEL_DISPLAY_NAME, displayModel, labelForModel } from '../../src/models/ladder.js';

test('the pinned model prints as HAKSTERAI-FLASH', () => {
  assert.equal(MODEL_DISPLAY_NAME, 'HAKSTERAI-FLASH');
  assert.equal(displayModel(PRIMARY_MODEL), 'HAKSTERAI-FLASH');
  assert.equal(labelForModel(PRIMARY_MODEL), 'HAKSTERAI-FLASH');
});

test('an empty model also names the pinned one', () => {
  assert.equal(displayModel(''), 'HAKSTERAI-FLASH');
  assert.equal(labelForModel(''), 'HAKSTERAI-FLASH');
});

test('any other model id prints as-is', () => {
  assert.equal(displayModel('glm-5.2:cloud'), 'glm-5.2:cloud');
});

test('the wire model id is never renamed', () => {
  assert.equal(PRIMARY_MODEL, 'deepseek-v4.1-flash:cloud');
  // The display helper must not rewrite the id it is handed.
  assert.equal(displayModel(PRIMARY_MODEL) === PRIMARY_MODEL, false);
});
