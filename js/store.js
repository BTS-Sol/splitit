// TripStore: one trip = one pad. Keeps the decrypted event log, an outbox
// of local changes that are not on the pad yet (persisted, so nothing gets
// lost offline) and a local cache for instant start-up.

import { PadClient, newAuthorToken } from './padclient.js';
import { deriveTrip, encryptLine, decryptLine, randomId, isTripId, LINE_PREFIX } from './crypto.js';
import { foldEvents } from './model.js';
import { local, session } from './storage.js';
import { PAD_BASE_URL, PAD_PREFIX, PAD_HEADER } from './config.js';

// Etherpad 1.8 drops socket messages larger than ~10 kB.
const MAX_BATCH_CHARS = 6000;

export class TripStore {
  static async open(tripId, opts = {}) {
    if (!isTripId(tripId)) throw new Error('Ungültige Reise-ID');
    const { padId, key } = await deriveTrip(tripId, PAD_PREFIX);
    return new TripStore(tripId, padId, key, opts);
  }

  constructor(tripId, padId, key, opts = {}) {
    this.tripId = tripId;
    this.padId = padId;
    this.key = key;
    this.storage = opts.storage || local;
    this.sessionStorage = opts.sessionStorage || session;
    this.WebSocketImpl = opts.WebSocketImpl;
    this.padBaseUrl = opts.padBaseUrl || PAD_BASE_URL;
    this.padUrl = `${this.padBaseUrl}/p/${padId}`;

    const cache = this.storage.get(`cache:${tripId}`, null);
    this.serverEvents = Array.isArray(cache?.events) ? cache.events : [];
    this.cachedAt = cache?.savedAt || null;
    const outbox = this.storage.get(`outbox:${tripId}`, []);
    this.outbox = Array.isArray(outbox) ? outbox : [];

    this.serverLoaded = false; // pad content received in this session
    this.serverRev = -1;
    this.client = null;
    this.listeners = new Set();
    this.lineCache = new Map(); // encrypted line -> event (or null)
    this.encCache = new Map(); // event id -> encrypted line
    this.committed = new Set(); // event ids accepted by the server
    this.flushing = false;
    this.ingestSeq = 0;
    this._recompute();
  }

  // ------------------------------------------------------------------ public

  get me() {
    const mid = this.storage.get(`me:${this.tripId}`, null);
    const m = mid && this.state.members.get(mid);
    return m && !m.removed ? mid : null;
  }

  setMe(mid) {
    if (mid) this.storage.set(`me:${this.tripId}`, mid);
    else this.storage.remove(`me:${this.tripId}`);
    this._emit();
  }

  get sync() {
    return {
      status: this.client ? this.client.status : 'idle',
      error: this.client ? this.client.error : null,
      pending: this.outbox.length,
      loaded: this.serverLoaded,
    };
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  connect() {
    if (this.client) return;
    let token = this.sessionStorage.get('token');
    if (!token) {
      token = newAuthorToken();
      this.sessionStorage.set('token', token);
    }
    const client = new PadClient({
      baseUrl: this.padBaseUrl,
      padId: this.padId,
      token,
      WebSocketImpl: this.WebSocketImpl,
      log: (...a) => console.debug('[pad]', ...a),
    });
    client.on('token', (t) => this.sessionStorage.set('token', t));
    client.on('status', () => this._emit());
    client.on('text', ({ text, rev }) => this._ingest(text, rev));
    this.client = client;
    client.start();
  }

  close() {
    if (this.client) this.client.stop();
    this.client = null;
    this.listeners.clear();
  }

  /** Records new events locally and syncs them to the pad. */
  dispatch(...payloads) {
    const by = this.me;
    const events = payloads.map((p) => ({ v: 1, id: randomId(12), ts: Date.now(), by, ...p }));
    this.outbox.push(...events);
    this._saveOutbox();
    this._recompute();
    this._flush();
    return events;
  }

  /** Re-adds events from a backup that are missing on the pad. */
  importEvents(events) {
    const known = new Set([...this.serverEvents, ...this.outbox].map((e) => e.id));
    const fresh = events.filter(
      (e) => e && typeof e.id === 'string' && typeof e.type === 'string' && !known.has(e.id),
    );
    if (!fresh.length) return 0;
    this.outbox.push(...fresh);
    this._saveOutbox();
    this._recompute();
    this._flush();
    return fresh.length;
  }

  exportBackup() {
    return {
      app: 'splitit',
      format: 1,
      tripId: this.tripId,
      name: this.state.trip.name,
      exportedAt: new Date().toISOString(),
      events: [...this.serverEvents, ...this.outbox],
    };
  }

  // ---------------------------------------------------------------- internal

  _emit() {
    for (const fn of this.listeners) {
      try {
        fn(this);
      } catch (e) {
        console.error(e);
      }
    }
  }

  _recompute() {
    this.state = foldEvents([...this.serverEvents, ...this.outbox]);
    this._emit();
  }

  _saveOutbox() {
    this.storage.set(`outbox:${this.tripId}`, this.outbox);
  }

  async _ingest(text, rev) {
    const seq = ++this.ingestSeq;
    const lines = text.split('\n').filter((l) => l.startsWith(LINE_PREFIX));
    const unknown = [...new Set(lines.filter((l) => !this.lineCache.has(l)))];
    if (unknown.length) {
      const decoded = await Promise.all(unknown.map((l) => decryptLine(this.key, l)));
      unknown.forEach((l, i) => this.lineCache.set(l, decoded[i]));
    }
    if (seq !== this.ingestSeq) return; // a newer text arrived meanwhile
    const events = lines.map((l) => this.lineCache.get(l)).filter(Boolean);
    if (!events.length && !this.serverLoaded && this.serverEvents.length) {
      // The pad is empty although this browser knows the trip: it was deleted
      // on edupad (e.g. after 183 days without edits). Restore it from here.
      // Lines are only ever appended, so the cached log is complete.
      const cached = this.serverEvents;
      this.serverEvents = [];
      this.serverRev = rev;
      this.serverLoaded = true;
      this.restoredFromCache = cached.length;
      this.importEvents(cached);
      return;
    }
    this.serverEvents = events;
    this.serverRev = rev;
    this.serverLoaded = true;
    const known = new Set(events.map((e) => e.id));
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((e) => !known.has(e.id));
    if (this.outbox.length !== before) this._saveOutbox();
    for (const id of this.committed) if (known.has(id)) this.committed.delete(id);
    this.storage.set(`cache:${this.tripId}`, { events, savedAt: Date.now() });
    this._recompute();
    this._flush();
  }

  async _flush() {
    const c = this.client;
    if (this.flushing || !c || !c.ready || c.readonly) return;
    this.flushing = true;
    try {
      // Only write on top of a text we have fully read, so we never send
      // an event twice.
      while (c.ready && this.serverRev === c.rev) {
        const known = new Set(this.serverEvents.map((e) => e.id));
        const todo = this.outbox.filter((e) => !known.has(e.id) && !this.committed.has(e.id));
        if (!todo.length) break;
        const batch = [];
        let size = 0;
        for (const ev of todo) {
          let line = this.encCache.get(ev.id);
          if (!line) {
            line = await encryptLine(this.key, ev);
            this.encCache.set(ev.id, line);
            this.lineCache.set(line, ev);
          }
          if (batch.length && size + line.length + 1 > MAX_BATCH_CHARS) break;
          batch.push(ev.id);
          size += line.length + 1;
        }
        const text = `${batch.map((id) => this.encCache.get(id)).join('\n')}\n`;
        // A brand-new pad (revision 0) only holds edupad's welcome text.
        if (c.rev === 0 && !this.serverEvents.length) await c.replaceAll(PAD_HEADER + text);
        else await c.append(text);
        batch.forEach((id) => this.committed.add(id));
      }
    } catch {
      // Connection dropped – the outbox is retried after reconnecting.
    } finally {
      this.flushing = false;
    }
  }
}

/** Creates a new trip; the first name is the creator (and becomes "me"). */
export async function createTrip({ name, currency, names }, opts) {
  const store = await TripStore.open(randomId(16), opts);
  const members = names.map((n) => ({ type: 'member', mid: randomId(8), name: n }));
  store.storage.set(`me:${store.tripId}`, members[0].mid);
  store.dispatch({ type: 'trip', name, currency, by: members[0].mid }, ...members.map((m) => ({ ...m, by: members[0].mid })));
  return store;
}
