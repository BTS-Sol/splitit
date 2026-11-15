// In-memory stand-in for an Etherpad server, speaking the same socket.io
// frames over a fake WebSocket: protocol 3 = Etherpad 1.8 / socket.io 2
// (edupad.ch today), protocol 4 = Etherpad 2.x / socket.io 4. Changes must be
// based on the latest revision (no operational transform) – enough for
// sequential tests of the client and the store.
import { applyToText } from '../js/changeset.js';

export class FakeEtherpad {
  constructor({
    defaultText = 'Willkommen auf eduPad!\n\nDieser Text ist Standard.\n',
    protocol = 3,
    pingInterval = 25000,
  } = {}) {
    this.defaultText = defaultText;
    this.protocol = protocol;
    this.pingInterval = pingInterval;
    this.pingsAnswered = 0;
    this.pads = new Map();
    this.sockets = new Set();
    this.authors = new Map();
    this.online = true;
    const server = this;
    this.WebSocket = class FakeSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        server.sockets.add(this);
        setTimeout(() => {
          if (!server.online) return this._close();
          this.readyState = 1;
          const open = { sid: 'fake', upgrades: [], pingInterval: server.pingInterval, pingTimeout: 20000 };
          if (server.protocol === 3) {
            this._recv(`0${JSON.stringify(open)}`);
            this._recv('40');
          } else {
            this._recv(`0${JSON.stringify({ ...open, maxPayload: 1e6 })}`);
            this.pinger = setInterval(() => this._recv('2'), server.pingInterval);
          }
        }, 1);
      }

      send(data) {
        if (this.readyState !== 1) return;
        setTimeout(() => server._handle(this, data), 1);
      }

      close() {
        this._close();
      }

      _close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        clearInterval(this.pinger);
        server.sockets.delete(this);
        setTimeout(() => this.onclose?.({}), 1);
      }

      _recv(data) {
        if (this.readyState === 1) this.onmessage?.({ data });
      }

      _emit(msg) {
        this._recv(`42${JSON.stringify(['message', msg])}`);
      }
    };
  }

  pad(id) {
    if (!this.pads.has(id)) this.pads.set(id, { text: this.defaultText, rev: 0 });
    return this.pads.get(id);
  }

  deletePad(id) {
    this.pads.delete(id);
  }

  disconnectAll() {
    for (const s of [...this.sockets]) s._close();
  }

  _handle(socket, data) {
    if (data === '2') {
      // engine.io 4 rejects pings from the client ("invalid heartbeat direction").
      if (this.protocol === 4) return socket._close();
      return socket._recv('3');
    }
    if (data === '3') {
      this.pingsAnswered++;
      return;
    }
    if (data === '40') {
      if (this.protocol === 4) socket._recv('40{"sid":"ns"}');
      return;
    }
    if (!data.startsWith('42')) return;
    const [, msg] = JSON.parse(data.slice(2));
    if (msg.type === 'CLIENT_READY') {
      socket.padId = msg.padId;
      if (!this.authors.has(msg.token)) this.authors.set(msg.token, `a.${this.authors.size + 1}`);
      socket.author = this.authors.get(msg.token);
      const pad = this.pad(msg.padId);
      socket._emit({
        type: 'CLIENT_VARS',
        data: {
          userId: socket.author,
          readonly: false,
          collab_client_vars: { initialAttributedText: { text: pad.text, attribs: '' }, rev: pad.rev },
        },
      });
    } else if (msg.type === 'COLLABROOM' && msg.data.type === 'USER_CHANGES') {
      const pad = this.pad(socket.padId);
      const { baseRev, changeset } = msg.data;
      try {
        if (baseRev !== pad.rev) throw new Error('stale baseRev');
        pad.text = applyToText(pad.text, changeset);
      } catch {
        socket._emit({ disconnect: 'badChangeset' });
        return;
      }
      pad.rev++;
      socket._emit({ type: 'COLLABROOM', data: { type: 'ACCEPT_COMMIT', newRev: pad.rev } });
      for (const other of this.sockets) {
        if (other !== socket && other.padId === socket.padId) {
          other._emit({ type: 'COLLABROOM', data: { type: 'NEW_CHANGES', newRev: pad.rev, changeset, apool: {} } });
        }
      }
    }
  }
}
