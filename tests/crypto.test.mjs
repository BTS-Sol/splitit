import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptLine, deriveTrip, encryptLine, isTripId, parseTripId, randomId } from '../js/crypto.js';

test('randomId has the requested length and alphabet', () => {
  for (let i = 0; i < 50; i++) assert.ok(isTripId(randomId(16)));
  assert.equal(randomId(20).length, 20);
});

test('parseTripId accepts codes and links', () => {
  const id = 'abcdefgh12345678';
  assert.equal(parseTripId(id), id);
  assert.equal(parseTripId(` ${id.toUpperCase()} `), id);
  assert.equal(parseTripId(`https://x.github.io/splitit/#/t/${id}`), id);
  assert.equal(parseTripId(`https://x.github.io/splitit/#/t/${id}/salden`), id);
  assert.equal(parseTripId(`https://x.github.io/splitit/?t=${id}`), id);
  assert.equal(parseTripId('https://x.github.io/splitit/#/t/short'), null);
  assert.equal(parseTripId(`${id}9`), null);
});

test('pad id and key are derived deterministically and independently', async () => {
  const a = await deriveTrip('abcdefgh12345678');
  const b = await deriveTrip('abcdefgh12345678');
  const c = await deriveTrip('abcdefgh12345679');
  assert.equal(a.padId, b.padId);
  assert.notEqual(a.padId, c.padId);
  assert.match(a.padId, /^splitit-[0-9a-f]{24}$/);
  assert.ok(!a.padId.includes('abcdefgh12345678'));

  const line = await encryptLine(a.key, { hello: 'Wörld' });
  assert.ok(line.startsWith('ST1.'));
  assert.ok(!line.includes('\n'));
  assert.deepEqual(await decryptLine(b.key, line), { hello: 'Wörld' });
  assert.equal(await decryptLine(c.key, line), null);
  assert.equal(await decryptLine(a.key, 'Willkommen auf eduPad!'), null);
  assert.equal(await decryptLine(a.key, 'ST1.garbage'), null);
});
