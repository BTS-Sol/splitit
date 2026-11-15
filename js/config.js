// Where the data lives. Any Etherpad 1.8.x server with public pads works.
export const PAD_BASE_URL = 'https://edupad.ch';
export const PAD_PREFIX = 'splitit-';

// edupad.ch deletes pads that were not edited for 183 days.
export const PAD_RETENTION_DAYS = 183;

// Written at the top of every pad so that humans opening it know what it is.
export const PAD_HEADER =
  'SplitIt – verschlüsselte Daten einer Reise. Bitte hier nichts bearbeiten,\n' +
  'sonst gehen Einträge verloren. Jede Zeile unten ist ein verschlüsselter Eintrag.\n';
