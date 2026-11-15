// TripStore: one trip = a chain of pads ("<pad>", "<pad>-2", "<pad>-3", …).
// New entries go to the last pad; when it would grow beyond PAD_MAX_CHARS
// it gets a continuation line and the next pad takes over. The store keeps
// the decrypted event log, an outbox of local changes that are not on a pad
// yet (persisted, so nothing gets lost offline) and a local cache for instant
// start-up and for restoring pads that edupad deleted.

import { PadClient, newAuthorToken } from './padclient.js';
import { deriveTrip, encryptLine, decryptLine, randomId, isTripId, LINE_PREFIX } from './crypto.js';
import { foldEvents } from './model.js';
import { local, session } from './storage.js';
import {
  PAD_BASE_URL,
  PAD_PREFIX,
  PAD_MAX_CHARS,
  PAD_KEEPALIVE_DAYS,
  CONTINUE_PREFIX,
  padHeader,
} from './config.js';

// Etherpad 1.8 drops socket messages larger than ~10 kB.
const MAX_BATCH_CHARS = 6000;
const DAY = 864e5;

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
    this.padMaxChars = opts.padMaxChars || PAD_MAX_CHARS;
    this.batchChars = Math.min(MAX_BATCH_CHARS, Math.floor(this.padMaxChars / 4));

    const cache = this.storage.get(`cache:${tripId}`, null);
    const cachedParts = Array.isArray(cache?.parts)
      ? cache.parts
      : Array.isArray(cache?.events) // cache format of the single-pad version
        ? [{ events: cache.events, closed: false }]
        : [];
    this.parts = cachedParts.map((p, i) => this._newPart(i + 1, p));
    if (!this.parts.length) this.parts.push(this._newPart(1));
    const outbox = this.storage.get(`outbox:${tripId}`, []);
    this.outbox = Array.isArray(outbox) ? outbox : [];

    this.connected = false;
    this.listeners = new Set();
    this.lineCache = new Map(); // encrypted line -> event (or null)
    this.encCache = new Map(); // event id -> encrypted line
    this.committed = new Set(); // event ids accepted by the server
    this.flushing = false;
    this.restoredFromCache = 0;
    this._recompute();
  }

  // ------------------------------------------------------------------ public

  get padUrl() {
    return `${this.padBaseUrl}/p/${this.padId}`;
  }

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
    const clients = this.parts.map((p) => p.client).filter(Boolean);
    const worst = ['error', 'offline', 'connecting'].find((s) => clients.some((c) => c.status === s));
    const active = this.parts.at(-1).client;
    const restoring = this.parts.reduce((n, p) => n + (p.restore ? p.restore.events.length : 0), 0);
    return {
      status: worst || (active ? active.status : 'idle'),
      error: clients.find((c) => c.error)?.error || null,
      pending: this.outbox.length + restoring,
      loaded: this.parts.every((p) => p.loaded) && !this.parts.at(-1).closed,
      pads: this.parts.length,
    };
  }

  /** Server events of all pads, in chain order. */
  get serverEvents() {
    return this.parts.flatMap((p) => (p.restore ? [...p.events, ...p.restore.events] : p.events));
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  connect() {
    if (this.connected) return;
    this.connected = true;
    this.token = this.sessionStorage.get('token');
    if (!this.token) {
      this.token = newAuthorToken();
      this.sessionStorage.set('token', this.token);
    }
    // All pads known from the cache are opened at once; further ones are
    // discovered through their continuation lines.
    for (const part of [...this.parts]) this._openPart(part);
  }

  close() {
    this.connected = false;
    for (const part of this.parts) {
      if (part.client) part.client.stop();
      part.client = null;
    }
    this.listeners.clear();
  }

  reconnectNow() {
    for (const part of this.parts) part.client?.reconnectNow();
  }

  /** The browser went offline: drop the sockets instead of waiting for timeouts. */
  dropConnections() {
    for (const part of this.parts) part.client?.ws?.close();
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

  /** Re-adds events from a backup that are missing on the pads. */
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

  // ------------------------------------------------------------------ parts

  _newPart(n, cached = {}) {
    const events = Array.isArray(cached.events) ? cached.events : [];
    return {
      n,
      padId: n === 1 ? this.padId : `${this.padId}-${n}`,
      events,
      closed: !!cached.closed,
      cached: { events, closed: !!cached.closed },
      loaded: false,
      rev: -1,
      client: null,
      ingestSeq: 0,
      restore: null,
      keepalive: false,
    };
  }

  _openPart(part) {
    if (part.client || !this.connected) return;
    const client = new PadClient({
      baseUrl: this.padBaseUrl,
      padId: part.padId,
      token: this.token,
      WebSocketImpl: this.WebSocketImpl,
      log: (...a) => console.debug(`[pad ${part.n}]`, ...a),
    });
    client.on('token', (t) => this.sessionStorage.set('token', t));
    client.on('status', () => this._emit());
    client.on('text', ({ text, rev }) => this._ingest(part, text, rev));
    part.client = client;
    client.start();
  }

  _ensureNextPart(part) {
    if (this.parts[part.n]) return;
    const next = this._newPart(part.n + 1);
    this.parts.push(next);
    this._openPart(next);
  }

  _continueLine(part) {
    return `${CONTINUE_PREFIX}${this.padBaseUrl}/p/${this.padId}-${part.n + 1}\n`;
  }

  _canWrite(part) {
    const c = part.client;
    return !!c && c.ready && !c.readonly && part.loaded && part.rev === c.rev;
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

  _saveCache() {
    const parts = this.parts.map((p) => ({
      events: p.restore ? [...p.events, ...p.restore.events] : p.events,
      closed: p.closed || !!p.restore?.close,
    }));
    this.storage.set(`cache:${this.tripId}`, { v: 2, parts, savedAt: Date.now() });
  }

  async _ingest(part, text, rev) {
    const seq = ++part.ingestSeq;
    const lines = text.split('\n');
    const encrypted = lines.filter((l) => l.startsWith(LINE_PREFIX));
    const unknown = [...new Set(encrypted.filter((l) => !this.lineCache.has(l)))];
    if (unknown.length) {
      const decoded = await Promise.all(unknown.map((l) => decryptLine(this.key, l)));
      unknown.forEach((l, i) => this.lineCache.set(l, decoded[i]));
    }
    if (seq !== part.ingestSeq || !part.client) return; // newer text arrived / closed
    const events = encrypted.map((l) => this.lineCache.get(l)).filter(Boolean);
    const ids = new Set(events.map((e) => e.id));
    const firstLoad = !part.loaded;
    part.events = events;
    part.closed = lines.some((l) => l.startsWith(CONTINUE_PREFIX));
    part.rev = rev;
    part.loaded = true;

    if (firstLoad) {
      // Lines are only ever appended. Events this browser saw in this pad
      // before but that are gone now mean the pad was deleted (edupad does
      // that after 183 days without edits) – write them back.
      const missing = part.cached.events.filter((e) => !ids.has(e.id));
      if (missing.length) {
        part.restore = { events: missing, close: part.cached.closed };
        this.restoredFromCache += missing.length;
      }
      // Full pads are never edited again. Touch them now and then so edupad
      // does not delete them while the trip goes on in the next pad.
      const { lastEdit, serverTime } = part.client;
      if (part.closed && lastEdit && (serverTime || Date.now()) - lastEdit > PAD_KEEPALIVE_DAYS * DAY) {
        part.keepalive = true;
      }
    }
    if (part.restore) {
      part.restore.events = part.restore.events.filter((e) => !ids.has(e.id));
      if (part.closed) part.restore.close = false;
      if (!part.restore.events.length && !part.restore.close) part.restore = null;
    }
    if (part.closed) this._ensureNextPart(part);

    const known = new Set(this.serverEvents.map((e) => e.id));
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((e) => !known.has(e.id));
    if (this.outbox.length !== before) this._saveOutbox();
    for (const id of this.committed) if (known.has(id)) this.committed.delete(id);
    this._saveCache();
    this._recompute();
    this._flush();
  }

  async _encrypt(ev) {
    let line = this.encCache.get(ev.id);
    if (!line) {
      line = await encryptLine(this.key, ev);
      this.encCache.set(ev.id, line);
      this.lineCache.set(line, ev);
    }
    return line;
  }

  async _batch(events) {
    const ids = [];
    let size = 0;
    for (const ev of events) {
      const line = await this._encrypt(ev);
      if (ids.length && size + line.length + 1 > this.batchChars) break;
      ids.push(ev.id);
      size += line.length + 1;
    }
    return { ids, text: `${ids.map((id) => this.encCache.get(id)).join('\n')}\n` };
  }

  /** Writes `text` to a pad; a brand-new pad only holds edupad's welcome text. */
  async _write(part, text) {
    const c = part.client;
    if (c.rev === 0 && !part.events.length) await c.replaceAll(padHeader(part.n) + text);
    else await c.append(text);
  }

  async _flush() {
    if (this.flushing || !this.connected) return;
    this.flushing = true;
    try {
      // 1. Put back what a deleted pad lost, and keep full pads alive.
      for (const part of this.parts) {
        while (part.restore?.events.length && this._canWrite(part)) {
          const { ids, text } = await this._batch(part.restore.events);
          await this._write(part, text);
          if (part.restore) part.restore.events = part.restore.events.filter((e) => !ids.includes(e.id));
        }
        if (part.restore && !part.restore.events.length && this._canWrite(part)) {
          if (part.restore.close && !part.closed) await part.client.append(this._continueLine(part));
          part.restore = null;
        }
        if (part.keepalive && this._canWrite(part)) {
          part.keepalive = false;
          await part.client.append(this._continueLine(part));
        }
      }
      // 2. New entries go to the last pad. Only write on top of a text we
      //    have fully read, so we never send an event twice.
      for (;;) {
        const part = this.parts.at(-1);
        if (!this._canWrite(part) || part.restore) break;
        if (part.closed) {
          this._ensureNextPart(part);
          break;
        }
        const known = new Set(this.serverEvents.map((e) => e.id));
        const todo = this.outbox.filter((e) => !known.has(e.id) && !this.committed.has(e.id));
        if (!todo.length) break;
        const { ids, text } = await this._batch(todo);
        if (part.events.length && part.client.text.length + text.length > this.padMaxChars) {
          // This pad is full: point to the next one, which takes over.
          await part.client.append(this._continueLine(part));
          continue;
        }
        await this._write(part, text);
        ids.forEach((id) => this.committed.add(id));
      }
    } catch {
      // Connection dropped – retried after reconnecting.
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
  store.dispatch(
    { type: 'trip', name, currency, by: members[0].mid },
    ...members.map((m) => ({ ...m, by: members[0].mid })),
  );
  return store;
}
