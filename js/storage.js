// Small JSON wrappers around localStorage / sessionStorage that never throw
// (private mode, blocked storage, Node tests …).

function wrap(getBackend) {
  const PREFIX = 'splitit:';
  return {
    get(key, fallback = null) {
      try {
        const raw = getBackend().getItem(PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        getBackend().setItem(PREFIX + key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        getBackend().removeItem(PREFIX + key);
      } catch {
        /* ignore */
      }
    },
  };
}

export const local = wrap(() => globalThis.localStorage);
export const session = wrap(() => globalThis.sessionStorage);

/** In-memory storage with the same interface (used by tests). */
export function memoryStorage() {
  const map = new Map();
  return {
    get: (k, f = null) => (map.has(k) ? JSON.parse(map.get(k)) : f),
    set: (k, v) => (map.set(k, JSON.stringify(v)), true),
    remove: (k) => map.delete(k),
  };
}

// ---- per-browser data ------------------------------------------------------

export const recentTrips = {
  list(storage = local) {
    const list = storage.get('trips', []);
    return Array.isArray(list) ? list.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0)) : [];
  },
  touch(id, name, storage = local) {
    const list = this.list(storage).filter((t) => t.id !== id);
    list.unshift({ id, name: name || null, lastOpened: Date.now() });
    storage.set('trips', list.slice(0, 50));
  },
  remove(id, storage = local) {
    storage.set(
      'trips',
      this.list(storage).filter((t) => t.id !== id),
    );
  },
};
