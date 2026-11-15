import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSplice, applyToText, unpack } from '../js/changeset.js';

test('append after the final newline', () => {
  const old = 'abc\ndef\n';
  const cs = makeSplice(old, old.length, 0, 'X\nY\n', '*0');
  assert.equal(cs, 'Z:8>4|2=8*0|2+4$X\nY\n');
  assert.equal(applyToText(old, cs), 'abc\ndef\nX\nY\n');
});

test('replace everything but the final newline', () => {
  const old = 'Willkommen!\n\nText\n';
  const ins = 'HEADER\nL1';
  const cs = makeSplice(old, 0, old.length - 1, ins, '*0');
  assert.equal(cs, 'Z:i<8|2-d-4*0|1+7*0+2$HEADER\nL1');
  assert.equal(applyToText(old, cs), 'HEADER\nL1\n');
});

test('keep/delete segments without trailing newline are split', () => {
  const old = 'ab\ncd\nef';
  const cs = makeSplice(old, 4, 3, 'Z');
  assert.equal(applyToText(old, cs), 'ab\ncZf');
  const { oldLen, newLen } = unpack(cs);
  assert.deepEqual([oldLen, newLen], [8, 6]);
});

test('applies changesets from other clients (with attributes)', () => {
  const text = 'line one\nline two\n';
  // insert "new " at the start of line two, attributed to author *1
  const cs = 'Z:i>4|1=9*1+4$new ';
  assert.equal(applyToText(text, cs), 'line one\nnew line two\n');
});

test('rejects changesets for the wrong text length', () => {
  assert.throws(() => applyToText('abc\n', 'Z:5>1=5+1$x'));
});

test('large numbers use base36', () => {
  const old = `${'x'.repeat(100)}\n`;
  const cs = makeSplice(old, old.length, 0, 'y\n');
  assert.match(cs, /^Z:2t>2\|1=2t\|1\+2\$y\n$/);
});
