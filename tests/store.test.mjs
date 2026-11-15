import test from 'node:test';
import assert from 'node:assert/strict';
import { TripStore, createTrip } from '../js/store.js';
import { memoryStorage } from '../js/storage.js';
import { PAD_HEADER } from '../js/config.js';
import { FakeEtherpad } from './fake-etherpad.mjs';

async function until(cond, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const browser = (srv, storage = memoryStorage()) => ({
  storage,
  sessionStorage: memoryStorage(),
  WebSocketImpl: srv.WebSocket,
});

const eventLines = (text) => text.split('\n').filter((l) => l.startsWith('ST1.'));

const pizza = (paidBy) => ({
  type: 'expense',
  eid: 'x1',
  kind: 'expense',
  title: 'Pizza',
  amount: 3000,
  paidBy,
  date: '2026-11-15',
  split: 'equal',
  shares: { [paidBy]: 1 },
});

test('create a trip, join from a second browser, see live updates', async () => {
  const srv = new FakeEtherpad();
  const a = await createTrip({ name: 'Arosa', currency: 'CHF', names: ['Anna', 'Ben'] }, browser(srv));
  assert.ok(a.me, 'creator is "me"');
  a.connect();
  await until(() => a.sync.loaded && a.sync.pending === 0);

  const { text } = srv.pad(a.padId);
  assert.ok(text.startsWith(PAD_HEADER), 'welcome text replaced by header');
  assert.equal(eventLines(text).length, 3);
  assert.ok(!text.includes('Anna') && !text.includes('Arosa'), 'content is encrypted');

  const b = await TripStore.open(a.tripId, browser(srv));
  b.connect();
  await until(() => b.state.exists);
  assert.deepEqual([...b.state.members.values()].map((m) => m.name), ['Anna', 'Ben']);
  assert.equal(b.me, null, 'joining browser has to pick a person');
  const ben = [...b.state.members.keys()][1];
  b.setMe(ben);
  b.dispatch(pizza(ben));
  await until(() => a.state.expenses.has('x1'));
  assert.equal(a.state.expenses.get('x1').title, 'Pizza');
  assert.equal(a.state.log.at(-1).by, ben);
  a.close();
  b.close();
});

test('offline changes are kept and sent after a reload', async () => {
  const srv = new FakeEtherpad();
  const storage = memoryStorage();
  const a = await createTrip({ name: 'Arosa', currency: 'EUR', names: ['Anna'] }, browser(srv, storage));
  a.connect();
  await until(() => a.sync.loaded && a.sync.pending === 0);

  srv.online = false;
  srv.disconnectAll();
  await until(() => a.sync.status === 'offline');
  a.dispatch({ type: 'trip', name: 'Arosa 2027' });
  assert.equal(a.state.trip.name, 'Arosa 2027', 'applied locally right away');
  assert.equal(a.sync.pending, 1);
  a.close();

  srv.online = true;
  const reloaded = await TripStore.open(a.tripId, browser(srv, storage));
  assert.equal(reloaded.state.trip.name, 'Arosa 2027', 'outbox survives a reload');
  reloaded.connect();
  await until(() => reloaded.sync.loaded && reloaded.sync.pending === 0);
  assert.equal(eventLines(srv.pad(a.padId).text).length, 3);
  reloaded.close();
});

test('a pad deleted on the server is restored from the browser cache', async () => {
  const srv = new FakeEtherpad();
  const storage = memoryStorage();
  const a = await createTrip({ name: 'Arosa', currency: 'EUR', names: ['Anna', 'Ben'] }, browser(srv, storage));
  a.connect();
  a.dispatch(pizza(a.me));
  await until(() => a.sync.loaded && a.sync.pending === 0);
  a.close();

  srv.deletePad(a.padId); // e.g. after 183 days without edits

  const again = await TripStore.open(a.tripId, browser(srv, storage));
  again.connect();
  await until(() => again.restoredFromCache && again.sync.pending === 0);
  assert.ok(srv.pad(a.padId).text.startsWith(PAD_HEADER));
  assert.equal(eventLines(srv.pad(a.padId).text).length, 4);
  again.close();

  const fresh = await TripStore.open(a.tripId, browser(srv));
  fresh.connect();
  await until(() => fresh.state.expenses.has('x1'));
  fresh.close();
});

test('a backup restores a lost trip under the same link', async () => {
  const srv = new FakeEtherpad();
  const a = await createTrip({ name: 'Arosa', currency: 'EUR', names: ['Anna'] }, browser(srv));
  a.connect();
  a.dispatch(pizza(a.me));
  await until(() => a.sync.loaded && a.sync.pending === 0);
  const backup = JSON.parse(JSON.stringify(a.exportBackup()));
  a.close();
  srv.deletePad(a.padId);

  const b = await TripStore.open(backup.tripId, browser(srv));
  b.connect();
  await until(() => b.sync.loaded);
  assert.equal(b.state.exists, false);
  assert.equal(b.importEvents(backup.events), 3);
  assert.equal(b.importEvents(backup.events), 0, 'importing twice adds nothing');
  await until(() => b.sync.pending === 0);
  assert.equal(b.state.trip.name, 'Arosa');
  assert.equal(eventLines(srv.pad(a.padId).text).length, 3);
  b.close();
});

test('lines written by humans are ignored', async () => {
  const srv = new FakeEtherpad();
  const a = await createTrip({ name: 'Arosa', currency: 'EUR', names: ['Anna'] }, browser(srv));
  a.connect();
  await until(() => a.sync.loaded && a.sync.pending === 0);
  a.close();
  const pad = srv.pad(a.padId);
  pad.text += 'Hallo, was ist das hier?\nST1.kaputt\n';
  pad.rev++;
  const b = await TripStore.open(a.tripId, browser(srv));
  b.connect();
  await until(() => b.sync.loaded);
  assert.equal(b.state.exists, true);
  assert.equal(b.state.members.size, 1);
  b.close();
});

// ---------------------------------------------------------------- pad chain

const expense = (i, paidBy) => ({
  type: 'expense',
  eid: `e${i}`,
  kind: 'expense',
  title: `Ausgabe Nummer ${i} mit etwas längerem Titel`,
  amount: 1000 + i,
  paidBy,
  date: '2026-11-15',
  split: 'equal',
  shares: { [paidBy]: 1 },
});

const chained = (srv, storage) => ({ ...browser(srv, storage), padMaxChars: 3000 });
const padsOf = (srv, padId) => [...srv.pads.keys()].filter((k) => k === padId || k.startsWith(`${padId}-`));

test('a full pad continues in "<pad>-2", "<pad>-3", …', async () => {
  const srv = new FakeEtherpad();
  const storage = memoryStorage();
  const a = await createTrip({ name: 'Lange Reise', currency: 'EUR', names: ['Anna', 'Ben'] }, chained(srv, storage));
  a.connect();
  for (let i = 0; i < 40; i++) a.dispatch(expense(i, a.me));
  await until(() => a.sync.loaded && a.sync.pending === 0, 5000);

  const ids = padsOf(srv, a.padId);
  assert.ok(ids.length >= 4, `expected several pads, got ${ids.length}`);
  assert.deepEqual(ids, [a.padId, ...ids.slice(1).map((_, i) => `${a.padId}-${i + 2}`)]);
  ids.forEach((id, i) => {
    const { text } = srv.pad(id);
    assert.ok(text.startsWith(i ? 'SplitIt – verschlüsselte Daten einer Reise, Teil' : PAD_HEADER));
    assert.ok(text.length <= 3000 + 200, `pad ${i + 1} has ${text.length} chars`);
    const last = i === ids.length - 1;
    assert.equal(text.includes(`SplitIt-Fortsetzung: https://edupad.ch/p/${a.padId}-${i + 2}`), !last);
  });
  assert.equal(a.state.expenses.size, 40);
  a.close();

  // A new browser walks along the chain.
  const b = await TripStore.open(a.tripId, chained(srv));
  b.connect();
  await until(() => b.sync.loaded, 5000);
  assert.equal(b.state.expenses.size, 40);
  assert.equal(b.sync.pads, ids.length);
  // … and writes into the last pad.
  b.setMe(a.storage.get(`me:${a.tripId}`) || [...b.state.members.keys()][0]);
  b.dispatch(expense(99, b.me));
  await until(() => b.sync.pending === 0);
  assert.ok(srv.pad(ids.at(-1)).text.split('\n').length > 3 || padsOf(srv, a.padId).length > ids.length);
  b.close();

  // The first browser starts from its cache and sees the new entry.
  const again = await TripStore.open(a.tripId, chained(srv, storage));
  assert.equal(again.parts.length, ids.length, 'all pads known from the cache');
  again.connect();
  await until(() => again.sync.loaded && again.state.expenses.has('e99'), 5000);
  again.close();
});

test('a deleted part of the chain is restored, old parts are kept alive', async () => {
  const srv = new FakeEtherpad();
  const storage = memoryStorage();
  const a = await createTrip({ name: 'Lange Reise', currency: 'EUR', names: ['Anna'] }, chained(srv, storage));
  a.connect();
  for (let i = 0; i < 25; i++) a.dispatch(expense(i, a.me));
  await until(() => a.sync.loaded && a.sync.pending === 0, 5000);
  a.close();
  const ids = padsOf(srv, a.padId);
  assert.ok(ids.length >= 3);
  const firstText = srv.pad(ids[0]).text;

  // edupad deleted the first (full) pad, and the second one is 100 days old.
  srv.deletePad(ids[0]);
  srv.pad(ids[1]).time = Date.now() - 100 * 864e5;
  const revBefore = srv.pad(ids[1]).rev;

  const again = await TripStore.open(a.tripId, chained(srv, storage));
  again.connect();
  await until(() => again.sync.loaded && again.sync.pending === 0 && srv.pad(ids[1]).rev > revBefore, 5000);
  assert.ok(again.restoredFromCache > 0);
  const restored = srv.pad(ids[0]).text;
  assert.equal(eventLines(restored).length, eventLines(firstText).length);
  assert.ok(restored.includes(`SplitIt-Fortsetzung: https://edupad.ch/p/${a.padId}-2`));
  assert.ok(srv.pad(ids[1]).text.trimEnd().endsWith(`${a.padId}-3`), 'keep-alive line appended');
  again.close();

  const fresh = await TripStore.open(a.tripId, chained(srv));
  fresh.connect();
  await until(() => fresh.sync.loaded, 5000);
  assert.equal(fresh.state.expenses.size, 25);
  fresh.close();
});
