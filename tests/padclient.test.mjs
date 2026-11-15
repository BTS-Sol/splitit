import test from 'node:test';
import assert from 'node:assert/strict';
import { PadClient } from '../js/padclient.js';
import { FakeEtherpad } from './fake-etherpad.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const protocol of [3, 4]) {
  test(`talks to Etherpad with socket.io protocol ${protocol}`, async () => {
    const srv = new FakeEtherpad({ protocol, pingInterval: 30 });
    const a = new PadClient({ baseUrl: 'https://pad.example', padId: 'p1', WebSocketImpl: srv.WebSocket });
    const b = new PadClient({ baseUrl: 'https://pad.example', padId: 'p1', WebSocketImpl: srv.WebSocket });
    a.start();
    b.start();
    await a.replaceAll('HEADER\n');
    assert.equal(a.text, 'HEADER\n');
    await a.append('one\n');
    await wait(150); // several heartbeat rounds
    await b.append('two\n');
    await wait(20);
    assert.equal(srv.pad('p1').text, 'HEADER\none\ntwo\n');
    assert.equal(a.text, srv.pad('p1').text, 'live updates from the other client');
    assert.equal(a.status, 'online');
    if (protocol === 4) assert.ok(srv.pingsAnswered >= 2, 'answers server pings');
    a.stop();
    b.stop();
  });
}

test('reconnects and reloads the text after the connection drops', async () => {
  const srv = new FakeEtherpad();
  const c = new PadClient({ baseUrl: 'https://pad.example', padId: 'p2', WebSocketImpl: srv.WebSocket });
  const statuses = [];
  c.on('status', (s) => statuses.push(s));
  c.start();
  await c.append('a\n');
  srv.disconnectAll();
  await wait(5);
  assert.equal(c.ready, false);
  const sent = c.append('b\n').catch((e) => e);
  await wait(1300); // first retry after ~1 s
  assert.equal(c.ready, true);
  assert.ok(statuses.includes('offline'));
  // A queued change is rejected on disconnect (the store keeps its own outbox).
  assert.ok((await sent) instanceof Error || srv.pad('p2').text.endsWith('b\n'));
  c.stop();
});
