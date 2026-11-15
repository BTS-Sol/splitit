// Tiny Etherpad client that talks to the pad server (here edupad.ch) the same
// way the Etherpad web editor does: socket.io over a plain WebSocket. It keeps
// an up-to-date copy of the pad text and can append lines or replace the
// whole text. Works with Etherpad 1.8 (socket.io 2, edupad.ch today) and
// Etherpad 2.x (socket.io 4) – the differences are only in the handshake and
// who sends the heartbeat pings.
//
// Etherpad protocol summary:
//   -> CLIENT_READY {padId, token}            <- CLIENT_VARS {text, rev, userId}
//   -> USER_CHANGES {baseRev, changeset}      <- ACCEPT_COMMIT {newRev}
//                                             <- NEW_CHANGES {newRev, changeset} (others)

import { makeSplice, applyToText } from './changeset.js';
import { randomId } from './crypto.js';

const COMMIT_TIMEOUT = 20000;
const CONNECT_TIMEOUT = 15000;
const MAX_BACKOFF = 30000;

export const newAuthorToken = () => `t.${randomId(20)}`;

export class PadClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl  e.g. "https://edupad.ch"
   * @param {string} opts.padId
   * @param {string} [opts.token]  Etherpad author token ("t.xxxx")
   * @param {string} [opts.authorName]  name shown in the pad's user list
   * @param {typeof WebSocket} [opts.WebSocketImpl]
   */
  constructor({ baseUrl, padId, token, authorName = 'SplitIt', WebSocketImpl, log }) {
    const base = baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    this.url = `${base}/socket.io/?EIO=4&transport=websocket&padId=${encodeURIComponent(padId)}`;
    this.padId = padId;
    this.token = token || newAuthorToken();
    this.authorName = authorName;
    this.WS = WebSocketImpl || globalThis.WebSocket;
    this.log = log || (() => {});
    this.listeners = new Map();

    this.ws = null;
    this.ready = false;
    this.text = null;
    this.rev = -1;
    this.userId = null;
    this.readonly = false;
    this.status = 'idle';
    this.error = null;
    this.queue = [];
    this.pending = null;
    this.retries = 0;
    this.stopped = true;
    this.timers = {};
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  _emit(event, ...args) {
    for (const fn of this.listeners.get(event) || []) {
      try {
        fn(...args);
      } catch (e) {
        console.error(e);
      }
    }
  }

  _setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this._emit('status', status, error);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    if (this.ws) this.ws.close();
    else this._setStatus('idle');
  }

  /** Reconnect right away (e.g. when the browser comes back online). */
  reconnectNow() {
    if (this.stopped || this.ws) return;
    this.retries = 0;
    this._connect();
  }

  /** Appends `text` (must end with "\n") as new lines at the end of the pad. */
  append(text) {
    return this._enqueue('append', text);
  }

  /** Replaces the whole pad content with `text` (must end with "\n"). */
  replaceAll(text) {
    return this._enqueue('replace', text);
  }

  _enqueue(kind, text) {
    if (!text.endsWith('\n')) return Promise.reject(new Error('Text must end with a newline'));
    return new Promise((resolve, reject) => {
      this.queue.push({ kind, text, resolve, reject });
      this._pump();
    });
  }

  // ---------------------------------------------------------------- transport

  _connect() {
    this._clearTimers();
    this.ready = false;
    this.serverPings = false;
    this._setStatus('connecting');
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch (e) {
      this.log('WebSocket failed', e);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws === ws) this._onPacket(String(ev.data));
    };
    ws.onclose = () => {
      if (this.ws === ws) this._onClose();
    };
    ws.onerror = () => {};
    this.timers.connect = setTimeout(() => this._resync('connect timeout', false), CONNECT_TIMEOUT);
  }

  _raw(data) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(data);
  }

  _send(msg) {
    this._raw(`42${JSON.stringify(['message', msg])}`);
  }

  _onPacket(data) {
    if (this.serverPings) this._armWatchdog();
    switch (data[0]) {
      case '0': {
        // engine.io "open". socket.io 2 then connects the default namespace
        // by itself ("40") and expects the client to ping. socket.io 3+ waits
        // for the client to send "40" and pings the client instead.
        const open = JSON.parse(data.slice(1));
        this.pingInterval = open.pingInterval || 25000;
        this.pingTimeout = open.pingTimeout || 20000;
        if ('maxPayload' in open) this._useServerPings();
        else this.timers.ns = setTimeout(() => this._useServerPings(), 1500);
        break;
      }
      case '2': // ping from the server (engine.io 4+)
        this._raw('3');
        break;
      case '3': // pong to our ping (engine.io 3)
        clearTimeout(this.timers.pong);
        break;
      case '1':
        this._resync('server closed', false);
        break;
      case '4': {
        const kind = data[1];
        if (kind === '0') {
          if (!this.serverPings) {
            clearTimeout(this.timers.ns);
            this._startClientPings();
          }
          this._sendClientReady();
        }
        else if (kind === '1') this._resync('namespace closed', false);
        else if (kind === '2') {
          const json = data.slice(data.indexOf('['));
          const [event, payload] = JSON.parse(json);
          if (event === 'message' && payload) this._onMessage(payload);
        }
        break;
      }
      default:
    }
  }

  _useServerPings() {
    this.serverPings = true;
    this._raw('40');
    this._armWatchdog();
  }

  _armWatchdog() {
    clearTimeout(this.timers.alive);
    this.timers.alive = setTimeout(
      () => this._resync('server silent', false),
      this.pingInterval + this.pingTimeout,
    );
  }

  _startClientPings() {
    clearInterval(this.timers.ping);
    this.timers.ping = setInterval(() => {
      this._raw('2');
      clearTimeout(this.timers.pong);
      this.timers.pong = setTimeout(() => this._resync('ping timeout', false), this.pingTimeout);
    }, this.pingInterval);
  }

  _sendClientReady() {
    this._send({
      component: 'pad',
      type: 'CLIENT_READY',
      padId: this.padId,
      token: this.token,
      userInfo: { colorId: null, name: this.authorName },
    });
  }

  _onClose() {
    this._clearTimers();
    this.ws = null;
    this.ready = false;
    // Back off on repeated failures, but not after a long healthy connection.
    if (this.connectedAt && Date.now() - this.connectedAt > 30000) this.retries = 0;
    this.connectedAt = null;
    const err = new Error('disconnected');
    if (this.pending) {
      this.pending.reject(err);
      this.pending = null;
    }
    for (const job of this.queue.splice(0)) job.reject(err);
    if (this.status === 'error') return;
    if (this.stopped) return this._setStatus('idle');
    // A deliberate resync is not worth flashing "offline" in the UI.
    this._setStatus(this.immediate ? 'connecting' : 'offline');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    const delay = this.immediate
      ? 50
      : Math.min(MAX_BACKOFF, 1000 * 2 ** this.retries) * (0.75 + Math.random() * 0.5);
    this.immediate = false;
    this.retries++;
    clearTimeout(this.timers.reconnect);
    this.timers.reconnect = setTimeout(() => {
      if (!this.stopped) this._connect();
    }, delay);
  }

  /** Drop the connection and fetch a fresh copy of the pad. */
  _resync(reason, immediate = true) {
    this.log('resync:', reason);
    this.immediate = immediate;
    if (this.ws) this.ws.close();
  }

  _fatal(message) {
    this.stopped = true;
    this._setStatus('error', message);
    if (this.ws) this.ws.close();
  }

  _clearTimers() {
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.pong);
    clearTimeout(this.timers.connect);
    clearTimeout(this.timers.reconnect);
    clearTimeout(this.timers.ns);
    clearTimeout(this.timers.alive);
    if (this.pending) clearTimeout(this.pending.timer);
  }

  // ----------------------------------------------------------------- protocol

  _onMessage(msg) {
    if (msg.disconnect) {
      this.log('server disconnect:', msg.disconnect);
      if (msg.disconnect === 'userdup') {
        // Same author token used in another tab – take a fresh one.
        this.token = newAuthorToken();
        this._emit('token', this.token);
      }
      if (msg.disconnect === 'deleted' || msg.disconnect === 'padDeleted') {
        this.immediate = true;
      }
      if (this.ws) this.ws.close();
      return;
    }
    if (msg.accessStatus) {
      this._fatal(`Kein Zugriff auf das Pad (${msg.accessStatus})`);
      return;
    }
    if (msg.type === 'CLIENT_VARS') {
      const cv = msg.data.collab_client_vars;
      clearTimeout(this.timers.connect);
      this.text = cv.initialAttributedText.text;
      this.rev = cv.rev;
      this.userId = msg.data.userId;
      this.readonly = !!msg.data.readonly;
      this.ready = true;
      this.connectedAt = Date.now();
      this._setStatus(this.readonly ? 'readonly' : 'online');
      this._emit('text', { text: this.text, rev: this.rev, reset: true });
      this._pump();
      return;
    }
    if (msg.type !== 'COLLABROOM' || !msg.data) return;
    const d = msg.data;
    if (d.type === 'NEW_CHANGES') {
      if (d.newRev !== this.rev + 1) return this._resync(`revision gap ${this.rev} -> ${d.newRev}`);
      try {
        this.text = applyToText(this.text, d.changeset);
      } catch (e) {
        return this._resync(`could not apply changes: ${e.message}`);
      }
      this.rev = d.newRev;
      if (this.pending) this.pending.concurrent = true;
      this._emit('text', { text: this.text, rev: this.rev, reset: false });
    } else if (d.type === 'ACCEPT_COMMIT') {
      const p = this.pending;
      if (!p) return this._resync('unexpected ACCEPT_COMMIT');
      this.pending = null;
      this.retries = 0;
      clearTimeout(p.timer);
      p.resolve(d.newRev);
      if (p.concurrent || d.newRev !== this.rev + 1) {
        // The server merged our change with someone else's; get the result.
        return this._resync('concurrent change');
      }
      this.text = applyToText(this.text, p.changeset);
      this.rev = d.newRev;
      this._emit('text', { text: this.text, rev: this.rev, reset: false });
      this._pump();
    }
  }

  _pump() {
    if (!this.ready || this.pending || this.readonly || !this.queue.length) return;
    const job = this.queue.shift();
    let changeset;
    try {
      changeset =
        job.kind === 'replace'
          ? // Keep Etherpad's final newline, replace everything before it.
            makeSplice(this.text, 0, this.text.length - 1, job.text.slice(0, -1), '*0')
          : // Insert the new lines after the final newline.
            makeSplice(this.text, this.text.length, 0, job.text, '*0');
    } catch (e) {
      job.reject(e);
      return this._pump();
    }
    this.pending = {
      ...job,
      changeset,
      concurrent: false,
      timer: setTimeout(() => this._resync('commit timeout'), COMMIT_TIMEOUT),
    };
    this._send({
      type: 'COLLABROOM',
      component: 'pad',
      data: {
        type: 'USER_CHANGES',
        baseRev: this.rev,
        changeset,
        apool: { numToAttrib: { 0: ['author', this.userId] }, nextNum: 1 },
      },
    });
  }
}
