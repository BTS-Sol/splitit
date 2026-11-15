# SplitIt – Reisekosten fair teilen

Statische Website (läuft auf GitHub Pages), mit der eine Gruppe die Kosten einer Reise aufteilt.
Kein Server, keine Anmeldung: Die Daten liegen verschlüsselt in einem Pad auf [edupad.ch](https://edupad.ch).

## Funktionen

- **Reise anlegen**: Name, Währung, eigener Name und die Mitreisenden. Dabei wird eine zufällige,
  16-stellige ID erzeugt (`a–z0–9`, ≈ 82 Bit). Der Link lautet `https://<user>.github.io/splitit/#/t/<id>`.
- **Beitreten per Link**: Beim ersten Öffnen fragt die Seite „Wer bist du?“. Die Auswahl merkt sich
  der Browser **pro Reise** (localStorage). Wer nicht auf der Liste steht, kann sich selbst hinzufügen.
- **Ausgaben** erfassen, bearbeiten und löschen, aufgeteilt *gleich*, nach *Anteilen* (z. B. 2:1)
  oder mit *festen Beträgen*. Gerechnet wird in Rappen/Cent, die Summe geht immer exakt auf.
- **Salden und Ausgleich**: Wer bekommt wie viel zurück, und ein Vorschlag mit höchstens n−1 Zahlungen.
  „Erledigt“ trägt die Ausgleichszahlung ein.
- **Live-Sync** zwischen allen Geräten, **Offline-Modus** (Änderungen werden gespeichert und später
  hochgeladen), **Verlauf**, **Backup** als JSON, helles und dunkles Design, für Handys optimiert.

## Veröffentlichen auf GitHub Pages

1. Im Repository unter **Settings → Pages → Build and deployment** als Source *Deploy from a branch*
   wählen, dazu den Branch (z. B. `main`) und den Ordner `/ (root)`.
2. Nach ein bis zwei Minuten ist die Seite unter `https://<user>.github.io/splitit/` erreichbar.

Ein Build-Schritt ist nicht nötig, es gibt keine Abhängigkeiten.

## Lokal starten und testen

```bash
python3 -m http.server 8080   # dann http://localhost:8080 öffnen (file:// geht wegen ES-Modulen nicht)
npm test                      # Unit-Tests, Node ≥ 20, ohne Abhängigkeiten
```

Die Tests (`tests/`) decken das Etherpad-Changeset-Format, die Verschlüsselung, die Geldrechnung
und die Synchronisation ab. Für die Synchronisation simuliert `tests/fake-etherpad.mjs` einen
Etherpad-Server: Offline-Warteschlange, Wiederherstellung und Backups.

## Wie die Speicherung funktioniert

edupad.ch ist ein [Etherpad](https://etherpad.org) (zurzeit Version 1.8 mit socket.io 2). Die Seite
verbindet sich per WebSocket genau wie der Etherpad-Editor selbst (`js/padclient.js`):

```
→ CLIENT_READY {padId, token}           ← CLIENT_VARS {Text, Revision}
→ USER_CHANGES {baseRev, changeset}     ← ACCEPT_COMMIT {newRev}
                                        ← NEW_CHANGES  (Änderungen der anderen, live)
```

Ein API-Schlüssel ist dafür nicht nötig, und edupad lässt Verbindungen von fremden Domains zu
(getestet). Der Client funktioniert auch mit Etherpad 2.x (socket.io 4), falls edupad aktualisiert wird.

**Pad und Schlüssel** werden aus der Reise-ID abgeleitet (`js/crypto.js`):

```
padId = "splitit-" + SHA-256("splitit/pad/" + id)  (erste 24 Hex-Zeichen) → edupad.ch/p/splitit-…
key   = SHA-256("splitit/key/" + id)               → AES-256-GCM
```

Das Pad heißt also bewusst *nicht* `edupad.ch/p/<id>`. Sonst stünde der Schlüssel in der Pad-Adresse,
und die Verschlüsselung wäre wirkungslos. So kann nur lesen, wer den Reise-Link hat.

**Datenformat**: Jede Änderung ist eine verschlüsselte Zeile, die ans Ende des Pads angehängt wird
(append-only Log). Ganz oben steht ein Hinweis für Menschen, die das Pad öffnen:

```
SplitIt – verschlüsselte Daten einer Reise. Bitte hier nichts bearbeiten, …
ST1.0md0NpBkDrEmN79TXOh_8uk5PYQC3eOsB9UqYBeMzK2BFfZHlJXaGURBCLJ0yix9…
ST1.V0OFrko6ceMVbVw0_ZqDJwwJeOS2_5Ggxbfe9I8F3RHy8lAvo9-nK3JTZJ3xCfsR…
```

Entschlüsselt ist jede Zeile ein Ereignis `{v, id, ts, by, type, …}` (`js/model.js`):

| type          | Inhalt                                                          |
| ------------- | --------------------------------------------------------------- |
| `trip`        | `name`, `currency` (Anlegen/Umbenennen)                         |
| `member`      | `mid`, `name`, `removed` (Hinzufügen/Umbenennen/Entfernen)      |
| `expense`     | `eid`, `kind` (`expense`/`transfer`), `title`, `amount` (Cent), `paidBy`, `date`, `split` (`equal`/`shares`/`exact`), `shares` |
| `expense_del` | `eid` (Löschen ist endgültig)                                   |

Der Zustand entsteht, indem alle Zeilen der Reihe nach angewendet werden; bei derselben Ausgabe gilt
der spätere Eintrag. Weil nur angehängt wird, führt Etherpad gleichzeitige Änderungen mehrerer Personen
ohne Konflikt zusammen. Unbekannte oder kaputte Zeilen werden ignoriert.

**Im Browser** (localStorage, pro Reise): gewählte Person, eine Kopie aller Einträge (für den sofortigen
Start und für die Wiederherstellung) sowie die Warteschlange noch nicht hochgeladener Änderungen.

## Grenzen und Hinweise

- **edupad löscht Pads nach 183 Tagen ohne Bearbeitung.** Öffnet danach jemand die Reise, dessen Browser
  sie kennt, lädt SplitIt die lokale Kopie automatisch wieder hoch, und der Link bleibt gleich.
  Zusätzlich gibt es unter *Gruppe → Daten & Backup* ein JSON-Backup zum Einspielen.
- **Wer den Link hat, kann alles sehen und ändern.** Es gibt keine Konten, und die Personenauswahl
  beruht auf Vertrauen. Deshalb nur Vornamen verwenden und den Link nur in der Gruppe teilen.
- Die Verschlüsselung schützt die Daten vor allen, die nur das Pad sehen (z. B. edupad oder jemand
  mit der Pad-Adresse), nicht vor Personen mit dem Reise-Link. Für dieses Projekt ist das so gewollt.
- SplitIt nutzt das interne Protokoll von Etherpad. Ändert edupad Grundlegendes (z. B. Login-Pflicht),
  muss `js/padclient.js` angepasst werden. Server und Präfix stehen in `js/config.js`; jeder andere
  öffentliche Etherpad-Server funktioniert genauso.
- Eine Währung pro Reise. Ein Wechsel ändert nur die Anzeige, es wird nichts umgerechnet.

## Dateien

```
index.html          Grundgerüst
css/style.css       Design (hell/dunkel, mobil)
js/app.js           Oberfläche, Routing (#/, #/neu, #/t/<id>[/salden|/gruppe])
js/store.js         Reise-Daten: Sync, Warteschlange, Cache, Wiederherstellung
js/padclient.js     Etherpad-Client (socket.io über WebSocket)
js/changeset.js     Etherpad-Changeset-Format (erzeugen/anwenden)
js/crypto.js        IDs, Ableitung Pad/Schlüssel, AES-GCM
js/model.js         Ereignisse → Zustand, Salden, Ausgleich, Beträge parsen
js/storage.js       localStorage-Helfer, „Deine Reisen“
js/config.js        Pad-Server (edupad.ch), Präfix, Kopfzeile
tests/              node --test
```
