// Where the data lives. Any public Etherpad server (1.8 or 2.x) works.
export const PAD_BASE_URL = 'https://edupad.ch';
export const PAD_PREFIX = 'splitit-';

// edupad.ch deletes pads that were not edited for 183 days.
export const PAD_RETENTION_DAYS = 183;

// Etherpad itself has no length limit (tested on edupad up to 2 MB), but big
// pads load slower and the database behind it may have limits we can't see.
// A pad that would grow beyond this gets a continuation line and the trip
// continues in "<pad>-2", "<pad>-3", … (500 kB ≈ 1500 entries).
export const PAD_MAX_CHARS = 500_000;

// Full pads are never edited again. When one is older than this, the next
// visitor appends a line to it, so edupad doesn't delete it.
export const PAD_KEEPALIVE_DAYS = 60;

// The continuation line at the end of a full pad: prefix + URL of the next pad.
export const CONTINUE_PREFIX = 'SplitIt-Fortsetzung: ';

// Written at the top of every pad so that humans opening it know what it is.
export function padHeader(n = 1) {
  return (
    `SplitIt – verschlüsselte Daten einer Reise${n > 1 ? `, Teil ${n}` : ''}. Bitte hier nichts bearbeiten,\n` +
    'sonst gehen Einträge verloren. Jede Zeile unten ist ein verschlüsselter Eintrag.\n'
  );
}

export const PAD_HEADER = padHeader(1);
