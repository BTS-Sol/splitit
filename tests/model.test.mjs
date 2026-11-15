import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocate,
  computeBalances,
  computeStats,
  foldEvents,
  parseAmount,
  settle,
  sharesOf,
} from '../js/model.js';

let n = 0;
const ev = (type, payload) => ({ v: 1, id: `e${++n}`, ts: 1000 + n, by: 'a', type, ...payload });

const base = () => [
  ev('trip', { name: 'Arosa', currency: 'CHF' }),
  ev('member', { mid: 'a', name: 'Anna' }),
  ev('member', { mid: 'b', name: 'Ben' }),
  ev('member', { mid: 'c', name: 'Cleo' }),
];

test('allocate splits cents exactly and deterministically', () => {
  assert.deepEqual(allocate(1000, { a: 1, b: 1, c: 1 }), { a: 334, b: 333, c: 333 });
  assert.deepEqual(allocate(1000, { c: 1, b: 1, a: 1 }), { a: 334, b: 333, c: 333 });
  assert.deepEqual(allocate(1001, { a: 2, b: 1 }), { a: 667, b: 334 });
  assert.deepEqual(allocate(500, { a: 1, b: 0 }), { a: 500 });
  const parts = allocate(9999, { a: 1.5, b: 2.5, c: 3 });
  assert.equal(Object.values(parts).reduce((x, y) => x + y), 9999);
});

test('fold: trip, members, rename, last write wins', () => {
  const s = foldEvents([
    ...base(),
    ev('member', { mid: 'b', name: 'Benjamin' }),
    ev('trip', { name: 'Arosa 2026' }),
  ]);
  assert.equal(s.exists, true);
  assert.equal(s.trip.name, 'Arosa 2026');
  assert.equal(s.trip.currency, 'CHF');
  assert.deepEqual([...s.members.values()].map((m) => m.name), ['Anna', 'Benjamin', 'Cleo']);
});

test('fold: duplicates are ignored, invalid events skipped', () => {
  const dup = ev('expense', { eid: 'x', title: 'Pizza', amount: 3000, paidBy: 'a', split: 'equal', shares: { a: 1, b: 1, c: 1 } });
  const s = foldEvents([
    ...base(),
    dup,
    { ...dup, amount: 1 }, // same event id -> ignored
    ev('expense', { eid: 'y', title: 'Bad', amount: -5, paidBy: 'a', split: 'equal', shares: { a: 1 } }),
    ev('expense', { eid: 'z', title: 'Bad', amount: 100, paidBy: 'a', split: 'exact', shares: { a: 50 } }),
    ev('unknown', {}),
    null,
  ]);
  assert.equal(s.expenses.size, 1);
  assert.equal(s.expenses.get('x').amount, 3000);
});

test('balances and settlement', () => {
  const s = foldEvents([
    ...base(),
    ev('expense', { eid: 'x', title: 'Hütte', amount: 30000, paidBy: 'a', split: 'equal', shares: { a: 1, b: 1, c: 1 } }),
    ev('expense', { eid: 'y', title: 'Essen', amount: 6000, paidBy: 'b', split: 'shares', shares: { a: 1, b: 2, c: 0 } }),
    ev('expense', { eid: 'z', title: 'Bier', amount: 1500, paidBy: 'c', split: 'exact', shares: { b: 1000, c: 500 } }),
  ]);
  const bal = computeBalances(s);
  // a: +30000 -10000 -2000 = 18000 ; b: +6000 -10000 -4000 -1000 = -9000 ; c: +1500 -10000 -500 = -9000
  assert.deepEqual(Object.fromEntries(bal), { a: 18000, b: -9000, c: -9000 });
  const transfers = settle(bal);
  assert.deepEqual(transfers, [
    { from: 'b', to: 'a', amount: 9000 },
    { from: 'c', to: 'a', amount: 9000 },
  ]);
  const stats = computeStats(s);
  assert.equal(stats.total, 37500);
  assert.equal(stats.consumed.get('b'), 15000);
});

test('transfers settle debts and deletion is final', () => {
  const events = [
    ...base(),
    ev('expense', { eid: 'x', title: 'Taxi', amount: 900, paidBy: 'a', split: 'equal', shares: { a: 1, b: 1, c: 1 } }),
    ev('expense', { eid: 't', kind: 'transfer', title: 'Ausgleich', amount: 300, paidBy: 'b', split: 'exact', shares: { a: 300 } }),
  ];
  let bal = computeBalances(foldEvents(events));
  assert.deepEqual(Object.fromEntries(bal), { a: 300, b: 0, c: -300 });

  events.push(ev('expense_del', { eid: 'x' }));
  events.push(ev('expense', { eid: 'x', title: 'Taxi', amount: 900, paidBy: 'a', split: 'equal', shares: { a: 1 } }));
  const s = foldEvents(events);
  assert.equal(s.expenses.has('x'), false);
  bal = computeBalances(s);
  assert.deepEqual(Object.fromEntries(bal), { a: -300, b: 300, c: 0 });
  assert.equal(computeStats(s).total, 0);
});

test('sharesOf for every split mode', () => {
  assert.deepEqual(sharesOf({ split: 'equal', amount: 100, shares: { a: 1, b: 1 } }), { a: 50, b: 50 });
  assert.deepEqual(sharesOf({ split: 'exact', amount: 100, shares: { a: 70, b: 30, c: 0 } }), { a: 70, b: 30 });
});

test('settle produces at most n-1 transfers that zero everything', () => {
  const bal = new Map([['a', 5000], ['b', -1234], ['c', -2766], ['d', 1000], ['e', -2000]]);
  const t = settle(bal);
  assert.ok(t.length <= 4);
  const after = new Map(bal);
  for (const { from, to, amount } of t) {
    after.set(from, after.get(from) + amount);
    after.set(to, after.get(to) - amount);
  }
  assert.ok([...after.values()].every((v) => v === 0));
});

test('parseAmount', () => {
  assert.equal(parseAmount('12,50'), 1250);
  assert.equal(parseAmount('12.5'), 1250);
  assert.equal(parseAmount('12'), 1200);
  assert.equal(parseAmount("1'234.50"), 123450);
  assert.equal(parseAmount('1.234,56'), 123456);
  assert.equal(parseAmount('1.234'), 123400);
  assert.equal(parseAmount(',5'), 50);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('-5'), null);
});
