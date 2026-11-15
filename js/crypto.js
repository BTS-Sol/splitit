// IDs, key derivation and encryption of the lines stored in the pad.
//
// From the 16-character trip ID we derive two independent values:
//   padId = "splitit-" + SHA-256("splitit/pad/" + tripId)[0..24 hex]
//   key   = AES-256-GCM key from SHA-256("splitit/key/" + tripId)
// Somebody who only knows the pad URL therefore cannot read the content –
// you need the trip link. This is obfuscation for a public tool with first
// names only, not high security.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const LINE_PREFIX = 'ST1.';
const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomId(length = 16, alphabet = ALPHABET) {
  // Rejection sampling avoids modulo bias.
  const max = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < max) out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export const isTripId = (s) => typeof s === 'string' && /^[a-z0-9]{16}$/.test(s);

/** Accepts a bare ID or any link containing one and returns the ID (or null). */
export function parseTripId(input) {
  const s = String(input || '').trim().toLowerCase();
  if (isTripId(s)) return s;
  const m = /(?:#\/?t\/|[?&]t=)([a-z0-9]{16})(?![a-z0-9])/.exec(s);
  return m ? m[1] : null;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function toB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function deriveTrip(tripId, padPrefix = 'splitit-') {
  const padHash = await sha256(`splitit/pad/${tripId}`);
  const keyBytes = await sha256(`splitit/key/${tripId}`);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  return { padId: padPrefix + toHex(padHash).slice(0, 24), key };
}

export async function encryptLine(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))),
  );
  const buf = new Uint8Array(iv.length + ct.length);
  buf.set(iv);
  buf.set(ct, iv.length);
  return LINE_PREFIX + toB64url(buf);
}

/** Returns the decrypted object, or null for foreign/broken lines. */
export async function decryptLine(key, line) {
  if (!line.startsWith(LINE_PREFIX)) return null;
  try {
    const buf = fromB64url(line.slice(LINE_PREFIX.length).trim());
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf.slice(0, 12) },
      key,
      buf.slice(12),
    );
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}
