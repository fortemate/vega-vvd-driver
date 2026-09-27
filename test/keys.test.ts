import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_CODES, KeyError, parseKey, parseKeys } from '../src/keys.ts';

test('remote names map to the evdev codes the VVD accepts', () => {
  assert.deepEqual(parseKey('ok'), [{ name: 'ok', code: 96, half: 'press' }]);
  assert.equal(parseKey('back')[0].code, 158);
  assert.equal(parseKey('UP')[0].code, 103);
  // OK is KEY_KPENTER, what the VVD's own remote sends.
  assert.equal(parseKey('select')[0].code, KEY_CODES.KEY_KPENTER);
});

test('KEY_* names and raw codes are accepted', () => {
  assert.equal(parseKey('KEY_BACK')[0].code, 158);
  assert.equal(parseKey('key_menu')[0].code, 139);
  assert.equal(parseKey('208')[0].code, 208);
});

test('a key can be held, released or repeated', () => {
  assert.equal(parseKey('ok:down')[0].half, 'down');
  assert.equal(parseKey('ok:up')[0].half, 'up');
  const three = parseKey('down*3');
  assert.equal(three.length, 3);
  assert.ok(three.every((step) => step.code === 108 && step.half === 'press'));
  assert.equal(parseKey('left:down*2').length, 2);
});

test('keys are parsed in order', () => {
  assert.deepEqual(
    parseKeys(['down', 'ok']).map((step) => step.code),
    [108, 96],
  );
});

test('unknown or malformed keys are refused before anything is sent', () => {
  assert.throws(() => parseKey('nope'), KeyError);
  assert.throws(() => parseKey('ok:sideways'), KeyError);
  assert.throws(() => parseKey('down*0'), KeyError);
  assert.throws(() => parseKey('down*101'), KeyError);
  assert.throws(() => parseKey('0'), KeyError);
});
