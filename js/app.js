import { TripStore, createTrip } from './store.js';
import { isTripId, parseTripId, randomId } from './crypto.js';
import {
  CURRENCIES,
  allocate,
  computeBalances,
  computeStats,
  isInvolved,
  parseAmount,
  settle,
  sharesOf,
} from './model.js';
import { local, recentTrips } from './storage.js';
import { PAD_RETENTION_DAYS } from './config.js';

const $app = document.getElementById('app');
const $sync = document.getElementById('sync');

let route = { view: 'home' };
let current = null; // { tripId, store, unsub, touchedName }
let routeSeq = 0;
let renderQueued = false;

// ============================================================== helpers

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const formatters = new Map();
function money(cents, currency, { sign = false } = {}) {
  if (!formatters.has(currency)) {
    formatters.set(
      currency,
      new Intl.NumberFormat(currency === 'CHF' ? 'de-CH' : 'de-DE', { style: 'currency', currency }),
    );
  }
  const s = formatters.get(currency).format(Math.abs(cents) / 100);
  if (cents < 0) return `−${s}`;
  return sign && cents > 0 ? `+${s}` : s;
}

const centsToInput = (c) => (c / 100).toFixed(2).replace('.', ',');

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function fmtDay(iso) {
  const d = new Date(`${iso}T12:00:00`);
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return new Intl.DateTimeFormat('de-DE', opts).format(d);
}

function fmtDate(ts) {
  return new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }).format(ts);
}

function fmtRelative(ts) {
  if (!ts) return '';
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  if (min < 24 * 60) return `vor ${Math.round(min / 60)} Std.`;
  return new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ts);
}

function hue(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return esc((parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase());
}

const avatar = (m, cls = '') =>
  `<span class="avatar ${cls}" style="--hue:${hue(m?.id)}" aria-hidden="true">${initials(m?.name)}</span>`;

const tripLink = (id) => `${location.origin}${location.pathname}#/t/${id}`;

function nameOf(state, mid, me) {
  if (mid && mid === me) return 'Du';
  return state.members.get(mid)?.name || 'Unbekannt';
}

function nameTaken(state, name, exceptMid = null) {
  const n = name.trim().toLowerCase();
  return [...state.members.values()].some((m) => !m.removed && m.id !== exceptMid && m.name.toLowerCase() === n);
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Link kopiert');
}

function download(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================== dialogs

function openDialog(html, className = '') {
  const dlg = document.createElement('dialog');
  dlg.className = `dialog ${className}`;
  dlg.innerHTML = `<div class="dialog-body">${html}</div>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  // Hide a previous validation error as soon as the user corrects something.
  dlg.addEventListener('input', () => dlg.querySelectorAll('.error').forEach((el) => (el.hidden = true)));
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
    if (e.target.closest('[data-close]')) dlg.close();
  });
  dlg.showModal();
  return dlg;
}

function promptDialog({ title, label, value = '', placeholder = 'Vorname', confirm = 'Speichern', validate }) {
  return new Promise((resolve) => {
    const dlg = openDialog(`
      <form class="form">
        <h2>${esc(title)}</h2>
        <label>${esc(label)}
          <input name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="60" required autocomplete="off">
        </label>
        <p class="error" hidden></p>
        <div class="actions">
          <button type="button" class="btn ghost" data-close>Abbrechen</button>
          <button class="btn primary">${esc(confirm)}</button>
        </div>
      </form>`);
    let result = null;
    const form = dlg.querySelector('form');
    const input = form.elements.v;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      const err = v ? validate?.(v) : 'Bitte etwas eingeben.';
      if (err) {
        Object.assign(form.querySelector('.error'), { textContent: err, hidden: false });
        return;
      }
      result = v;
      dlg.close();
    });
    dlg.addEventListener('close', () => resolve(result));
    input.focus();
    input.select();
  });
}

function confirmDialog({ title, text, confirm = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    const dlg = openDialog(`
      <div class="form">
        <h2>${esc(title)}</h2>
        ${text ? `<p>${esc(text)}</p>` : ''}
        <div class="actions">
          <button type="button" class="btn ghost" data-close>Abbrechen</button>
          <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(confirm)}</button>
        </div>
      </div>`);
    dlg.querySelector('[data-ok]').addEventListener('click', () => {
      ok = true;
      dlg.close();
    });
    dlg.addEventListener('close', () => resolve(ok));
  });
}

function shareDialog(store, { created = false } = {}) {
  const link = tripLink(store.tripId);
  const dlg = openDialog(`
    <div class="form">
      <h2>${created ? 'Reise angelegt 🎉' : 'Mitreisende einladen'}</h2>
      <p>Schick diesen Link in eure Gruppe. Wer ihn öffnet, wählt seinen Namen aus und ist dabei – ohne Anmeldung.</p>
      <div class="copy-row">
        <input readonly value="${esc(link)}" aria-label="Einladungslink">
        <button type="button" class="btn" data-copy>Kopieren</button>
      </div>
      ${navigator.share ? '<button type="button" class="btn" data-share>Teilen …</button>' : ''}
      <p class="muted small">Jeder mit dem Link kann die Reise sehen und bearbeiten – teile ihn nur mit deiner Gruppe.
        <span class="sync-label" data-sync-label></span></p>
      <div class="actions"><button type="button" class="btn primary" data-close>Fertig</button></div>
    </div>`);
  dlg.querySelector('[data-copy]').addEventListener('click', () => copyText(link));
  dlg.querySelector('[data-share]')?.addEventListener('click', () => {
    navigator.share({ title: store.state.trip.name, text: `Unsere Reisekasse „${store.state.trip.name}“ auf SplitIt:`, url: link }).catch(() => {});
  });
  dlg.querySelector('input').addEventListener('focus', (e) => e.target.select());
  renderSync();
}

function tripDialog(store) {
  const { trip } = store.state;
  const dlg = openDialog(`
    <form class="form">
      <h2>Reise bearbeiten</h2>
      <label>Name der Reise <input name="name" value="${esc(trip.name)}" maxlength="100" required></label>
      <label>Währung
        <select name="currency">${CURRENCIES.map((c) => `<option ${c === trip.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <span class="hint">Ändert nur die Anzeige, Beträge werden nicht umgerechnet.</span>
      </label>
      <div class="actions">
        <button type="button" class="btn ghost" data-close>Abbrechen</button>
        <button class="btn primary">Speichern</button>
      </div>
    </form>`);
  const form = dlg.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    const currency = form.elements.currency.value;
    if (!name) return;
    if (name !== trip.name || currency !== trip.currency) store.dispatch({ type: 'trip', name, currency });
    dlg.close();
  });
}

// ---------------------------------------------------------- expense editor

function expenseDialog(store, eid = null) {
  const s = store.state;
  const exp = eid ? s.expenses.get(eid) : null;
  if (eid && !exp) return;
  if (exp?.kind === 'transfer') return transferDialog(store, exp);
  const cur = s.trip.currency;
  const me = store.me;
  const people = [...s.members.values()].filter(
    (m) => !m.removed || (exp && (exp.paidBy === m.id || (exp.shares[m.id] || 0) > 0)),
  );
  const draft = {
    split: exp?.split || 'equal',
    included: new Set(exp ? Object.keys(exp.shares).filter((k) => exp.shares[k] > 0) : people.map((m) => m.id)),
    weights: exp?.split === 'shares' ? { ...exp.shares } : {},
    exact:
      exp?.split === 'exact'
        ? Object.fromEntries(Object.entries(exp.shares).map(([k, v]) => [k, centsToInput(v)]))
        : {},
  };

  const dlg = openDialog(
    `
    <form class="form" novalidate>
      <h2>${exp ? 'Ausgabe bearbeiten' : 'Neue Ausgabe'}</h2>
      <label>Wofür?
        <input name="title" maxlength="100" required placeholder="z. B. Pizza, Tanken, Unterkunft" value="${esc(exp?.title || '')}" autocomplete="off">
      </label>
      <div class="row">
        <label>Betrag (${esc(cur)})
          <input name="amount" inputmode="decimal" required placeholder="0,00" value="${exp ? centsToInput(exp.amount) : ''}" autocomplete="off">
        </label>
        <label>Datum <input type="date" name="date" required value="${esc(exp?.date || today())}"></label>
      </div>
      <label>Bezahlt von
        <select name="paidBy">${people
          .map((m) => `<option value="${m.id}" ${m.id === (exp?.paidBy || me) ? 'selected' : ''}>${esc(m.name)}${m.id === me ? ' (du)' : ''}</option>`)
          .join('')}</select>
      </label>
      <fieldset>
        <legend>Aufteilen</legend>
        <div class="seg" role="radiogroup">
          ${[
            ['equal', 'Gleich'],
            ['shares', 'Anteile'],
            ['exact', 'Beträge'],
          ]
            .map(
              ([v, l]) => `<label><input type="radio" name="split" value="${v}" ${draft.split === v ? 'checked' : ''}><span>${l}</span></label>`,
            )
            .join('')}
        </div>
        <ul class="split-list"></ul>
        <p class="split-hint muted small"></p>
      </fieldset>
      <p class="error" hidden></p>
      <div class="actions">
        ${exp ? '<button type="button" class="btn danger ghost" data-delete>Löschen</button><span class="spacer"></span>' : ''}
        <button type="button" class="btn ghost" data-close>Abbrechen</button>
        <button class="btn primary">Speichern</button>
      </div>
    </form>`,
    'sheet',
  );

  const form = dlg.querySelector('form');
  const list = form.querySelector('.split-list');
  const hint = form.querySelector('.split-hint');
  const errorEl = form.querySelector('.error');
  const amountOf = () => parseAmount(form.elements.amount.value);

  const weightsFor = (mode) => {
    if (mode === 'equal') return Object.fromEntries([...draft.included].map((m) => [m, 1]));
    if (mode === 'shares') return Object.fromEntries(people.map((m) => [m.id, draft.weights[m.id] ?? 0]));
    return Object.fromEntries(people.map((m) => [m.id, parseAmount(draft.exact[m.id]) || 0]));
  };

  function row(m) {
    const name = `${avatar(m, 'sm')}<span class="name">${esc(m.name)}${m.id === me ? ' <span class="muted">(du)</span>' : ''}</span>`;
    if (draft.split === 'equal') {
      return `<li><label class="check"><input type="checkbox" data-mid="${m.id}" ${draft.included.has(m.id) ? 'checked' : ''}>${name}</label><span class="share" data-share="${m.id}"></span></li>`;
    }
    if (draft.split === 'shares') {
      return `<li><span class="check">${name}</span><input class="num" type="number" min="0" step="1" inputmode="decimal" data-mid="${m.id}" value="${draft.weights[m.id] ?? 0}" aria-label="Anteile ${esc(m.name)}"><span class="share" data-share="${m.id}"></span></li>`;
    }
    return `<li><span class="check">${name}</span><input class="num money" inputmode="decimal" placeholder="0,00" data-mid="${m.id}" value="${esc(draft.exact[m.id] ?? '')}" aria-label="Betrag ${esc(m.name)}"></li>`;
  }

  function renderSplit() {
    if (draft.split === 'shares') {
      for (const m of people) draft.weights[m.id] ??= draft.included.has(m.id) ? 1 : 0;
    }
    list.innerHTML = people.map(row).join('');
    if (draft.split === 'equal') {
      list.insertAdjacentHTML(
        'beforeend',
        '<li class="quick"><button type="button" class="link" data-all>Alle</button><button type="button" class="link" data-none>Keiner</button></li>',
      );
    }
    updatePreview();
  }

  function updatePreview() {
    const amount = amountOf() || 0;
    if (draft.split === 'exact') {
      const sum = people.reduce((acc, m) => acc + (parseAmount(draft.exact[m.id]) || 0), 0);
      const diff = amount - sum;
      hint.textContent =
        diff === 0
          ? amount
            ? '✓ Beträge passen.'
            : ''
          : diff > 0
            ? `Noch ${money(diff, cur)} zu verteilen.`
            : `${money(-diff, cur)} zu viel verteilt.`;
      hint.classList.toggle('warn', diff !== 0);
      return;
    }
    const shares = allocate(amount, weightsFor(draft.split));
    for (const el of list.querySelectorAll('[data-share]')) {
      const v = shares[el.dataset.share];
      el.textContent = v ? money(v, cur) : '–';
    }
    const n = Object.keys(shares).length || Object.values(weightsFor(draft.split)).filter((w) => w > 0).length;
    hint.textContent = n ? `${n} ${n === 1 ? 'Person' : 'Personen'} beteiligt.` : 'Niemand ausgewählt.';
    hint.classList.toggle('warn', !n);
  }

  list.addEventListener('input', (e) => {
    const mid = e.target.dataset.mid;
    if (!mid) return;
    if (draft.split === 'equal') {
      if (e.target.checked) draft.included.add(mid);
      else draft.included.delete(mid);
    } else if (draft.split === 'shares') {
      const w = parseFloat(String(e.target.value).replace(',', '.'));
      draft.weights[mid] = Number.isFinite(w) && w >= 0 ? w : 0;
    } else {
      draft.exact[mid] = e.target.value;
    }
    updatePreview();
  });
  list.addEventListener('click', (e) => {
    if (e.target.closest('[data-all]')) people.forEach((m) => draft.included.add(m.id));
    else if (e.target.closest('[data-none]')) draft.included.clear();
    else return;
    renderSplit();
  });
  form.elements.amount.addEventListener('input', updatePreview);
  form.querySelector('.seg').addEventListener('change', (e) => {
    const next = e.target.value;
    const prev = draft.split;
    const prevWeights = weightsFor(prev);
    // Carry the selection over to the new mode.
    draft.included = new Set(Object.keys(prevWeights).filter((k) => prevWeights[k] > 0));
    if (next === 'shares' && prev !== 'shares') {
      draft.weights = Object.fromEntries(people.map((m) => [m.id, draft.included.has(m.id) ? 1 : 0]));
    }
    if (next === 'exact' && prev !== 'exact') {
      const amount = amountOf();
      const alloc = amount ? allocate(amount, prevWeights) : {};
      draft.exact = Object.fromEntries(people.map((m) => [m.id, alloc[m.id] ? centsToInput(alloc[m.id]) : '']));
    }
    draft.split = next;
    renderSplit();
  });

  form.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (await confirmDialog({ title: 'Ausgabe löschen?', text: `„${exp.title}“ wird für alle gelöscht.`, confirm: 'Löschen', danger: true })) {
      store.dispatch({ type: 'expense_del', eid: exp.id });
      dlg.close();
      toast('Ausgabe gelöscht');
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fail = (msg) => Object.assign(errorEl, { textContent: msg, hidden: false });
    const title = form.elements.title.value.trim();
    const amount = amountOf();
    const date = form.elements.date.value || today();
    if (!title) return fail('Bitte angeben, wofür das Geld war.');
    if (!amount || amount <= 0) return fail('Bitte einen gültigen Betrag eingeben.');
    let shares;
    if (draft.split === 'exact') {
      const bad = people.find((m) => draft.exact[m.id]?.trim() && parseAmount(draft.exact[m.id]) == null);
      if (bad) return fail(`Ungültiger Betrag bei ${bad.name}.`);
      shares = Object.fromEntries(
        people.map((m) => [m.id, parseAmount(draft.exact[m.id]) || 0]).filter(([, c]) => c > 0),
      );
      const sum = Object.values(shares).reduce((a, b) => a + b, 0);
      if (sum !== amount) return fail(`Die Beträge ergeben ${money(sum, cur)}, nicht ${money(amount, cur)}.`);
    } else {
      shares = Object.fromEntries(Object.entries(weightsFor(draft.split)).filter(([, w]) => w > 0));
    }
    if (!Object.keys(shares).length) return fail('Bitte mindestens eine Person auswählen.');
    store.dispatch({
      type: 'expense',
      eid: exp?.id || randomId(10),
      kind: 'expense',
      title,
      amount,
      paidBy: form.elements.paidBy.value,
      date,
      split: draft.split,
      shares,
    });
    dlg.close();
    toast(exp ? 'Ausgabe gespeichert' : 'Ausgabe hinzugefügt');
  });

  renderSplit();
  if (!exp) form.elements.title.focus();
}

function transferDialog(store, exp = null, preset = {}) {
  const s = store.state;
  const cur = s.trip.currency;
  const me = store.me;
  const from = exp?.paidBy || preset.from || me;
  const to = exp ? Object.keys(exp.shares)[0] : preset.to;
  const amount = exp?.amount || preset.amount;
  const people = [...s.members.values()].filter((m) => !m.removed || m.id === from || m.id === to);
  const options = (sel) =>
    people.map((m) => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}${m.id === me ? ' (du)' : ''}</option>`).join('');

  const dlg = openDialog(
    `
    <form class="form" novalidate>
      <h2>${exp ? 'Zahlung bearbeiten' : 'Zahlung erfassen'}</h2>
      <p class="muted small">Für Geld, das jemand direkt einer anderen Person gegeben hat – z. B. zum Ausgleichen.</p>
      <div class="row">
        <label>Von <select name="from">${options(from)}</select></label>
        <label>An <select name="to">${to ? '' : '<option value="">– wählen –</option>'}${options(to)}</select></label>
      </div>
      <div class="row">
        <label>Betrag (${esc(cur)}) <input name="amount" inputmode="decimal" required placeholder="0,00" value="${amount ? centsToInput(amount) : ''}" autocomplete="off"></label>
        <label>Datum <input type="date" name="date" value="${esc(exp?.date || today())}"></label>
      </div>
      <label>Notiz <input name="title" maxlength="100" placeholder="Ausgleich" value="${esc(exp?.title && exp.title !== 'Ausgleich' ? exp.title : '')}" autocomplete="off"></label>
      <p class="error" hidden></p>
      <div class="actions">
        ${exp ? '<button type="button" class="btn danger ghost" data-delete>Löschen</button><span class="spacer"></span>' : ''}
        <button type="button" class="btn ghost" data-close>Abbrechen</button>
        <button class="btn primary">Speichern</button>
      </div>
    </form>`,
    'sheet',
  );
  const form = dlg.querySelector('form');
  form.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (await confirmDialog({ title: 'Zahlung löschen?', confirm: 'Löschen', danger: true })) {
      store.dispatch({ type: 'expense_del', eid: exp.id });
      dlg.close();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fail = (msg) => Object.assign(form.querySelector('.error'), { textContent: msg, hidden: false });
    const f = form.elements.from.value;
    const t = form.elements.to.value;
    const cents = parseAmount(form.elements.amount.value);
    if (!t) return fail('Bitte auswählen, wer das Geld bekommen hat.');
    if (f === t) return fail('Von und An müssen verschiedene Personen sein.');
    if (!cents || cents <= 0) return fail('Bitte einen gültigen Betrag eingeben.');
    store.dispatch({
      type: 'expense',
      eid: exp?.id || randomId(10),
      kind: 'transfer',
      title: form.elements.title.value.trim() || 'Ausgleich',
      amount: cents,
      paidBy: f,
      date: form.elements.date.value || today(),
      split: 'exact',
      shares: { [t]: cents },
    });
    dlg.close();
    toast('Zahlung gespeichert');
  });
}

// ============================================================== views

function viewHome() {
  const trips = recentTrips.list();
  return `
    <section class="hero">
      <h1>Reisekosten fair teilen</h1>
      <p>Reise anlegen, Link in die Gruppe schicken, Ausgaben eintragen – SplitIt rechnet aus, wer wem wie viel schuldet. Ohne Anmeldung, ohne App.</p>
      <a class="btn primary big" href="#/neu">Neue Reise anlegen</a>
    </section>
    ${
      trips.length
        ? `<section class="card">
            <h2>Deine Reisen</h2>
            <ul class="trip-list">${trips
              .map(
                (t) => `<li>
                  <a href="#/t/${esc(t.id)}">${avatar({ id: t.id, name: t.name || 'R' })}
                    <span class="main"><strong>${esc(t.name || 'Reise')}</strong><span class="sub">zuletzt geöffnet ${fmtRelative(t.lastOpened)}</span></span>
                  </a>
                  <button class="icon-btn" data-action="forget-trip" data-id="${esc(t.id)}" title="Aus diesem Browser entfernen" aria-label="${esc(t.name || 'Reise')} aus diesem Browser entfernen">×</button>
                </li>`,
              )
              .join('')}</ul>
          </section>`
        : ''
    }
    <section class="card">
      <h2>Reise beitreten</h2>
      <form data-form="join" class="inline-form">
        <input name="link" placeholder="Einladungslink oder 16-stelliger Code" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Einladungslink oder Code">
        <button class="btn">Öffnen</button>
      </form>
      <p class="error" hidden></p>
    </section>
    <section class="card info">
      <h2>So funktioniert's</h2>
      <ol>
        <li>Du legst eine Reise an und trägst die Mitreisenden ein.</li>
        <li>Du teilst den Link. Wer ihn öffnet, wählt seinen Namen – fertig.</li>
        <li>Alle tragen Ausgaben ein, SplitIt zeigt, wer wem wie viel schuldet.</li>
      </ol>
      <p class="muted small">Die Daten liegen verschlüsselt auf <a href="https://edupad.ch" target="_blank" rel="noopener">edupad.ch</a>, der Schlüssel steckt im Link.
        Bitte nur Vornamen verwenden: Wer den Link hat, sieht alles.
        <label class="link">Backup einspielen<input type="file" accept=".json,application/json" data-action="restore-file" hidden></label></p>
    </section>`;
}

function viewNew() {
  return `
    <form data-form="create" class="card form" novalidate>
      <h1>Neue Reise</h1>
      <label>Name der Reise <input name="name" maxlength="100" required placeholder="z. B. Skiweekend Arosa" autocomplete="off"></label>
      <label>Währung
        <select name="currency">${CURRENCIES.map((c) => `<option>${c}</option>`).join('')}</select>
      </label>
      <label>Dein Name <input name="me" maxlength="60" required placeholder="Vorname" autocomplete="given-name"></label>
      <fieldset>
        <legend>Mitreisende</legend>
        <div class="others">
          ${'<input name="other" maxlength="60" placeholder="Vorname" autocomplete="off" aria-label="Vorname">'.repeat(3)}
        </div>
        <button type="button" class="link" data-action="add-field">+ weitere Person</button>
        <p class="hint">Leere Felder werden ignoriert. Weitere Personen kannst du später ergänzen.</p>
      </fieldset>
      <p class="error" hidden></p>
      <div class="actions">
        <a class="btn ghost" href="#/">Abbrechen</a>
        <button class="btn primary">Reise anlegen</button>
      </div>
    </form>`;
}

function viewLoading(store) {
  const { status, error } = store ? store.sync : {};
  if (status === 'error') {
    return `<section class="card center"><h1>Fehler</h1><p>${esc(error)}</p><a class="btn" href="#/">Zur Startseite</a></section>`;
  }
  const offline = status === 'offline';
  return `<div class="loading"><div class="spinner"></div><p>${offline ? 'Keine Verbindung zu edupad.ch – neuer Versuch läuft …' : 'Reise wird geladen …'}</p></div>`;
}

function viewNotFound() {
  return `
    <section class="card center">
      <h1>Reise nicht gefunden</h1>
      <p>Unter diesem Link liegen keine Daten. Entweder ist der Link unvollständig, oder die Reise wurde auf edupad.ch gelöscht, weil sie über ${PAD_RETENTION_DAYS} Tage nicht bearbeitet wurde.</p>
      <p class="muted">Wer die Reise schon einmal in seinem Browser geöffnet hat, stellt sie beim nächsten Öffnen automatisch wieder her. Oder du spielst ein Backup ein – der Link bleibt gleich.</p>
      <div class="actions center">
        <label class="btn">Backup einspielen<input type="file" accept=".json,application/json" data-action="restore-file" hidden></label>
        <a class="btn ghost" href="#/">Zur Startseite</a>
      </div>
    </section>`;
}

function viewWhoAmI(store) {
  const s = store.state;
  const active = [...s.members.values()].filter((m) => !m.removed);
  return `
    <section class="card center whoami">
      <p class="eyebrow">${esc(s.trip.name)}</p>
      <h1>Wer bist du?</h1>
      <p class="muted">Wähle deinen Namen. Dieser Browser merkt sich das für diese Reise.</p>
      <div class="who-grid">
        ${active.map((m) => `<button class="who" data-action="pick-me" data-mid="${m.id}">${avatar(m)}<span>${esc(m.name)}</span></button>`).join('')}
      </div>
      <button class="btn ghost" data-action="add-me">Ich stehe nicht auf der Liste</button>
    </section>`;
}

function viewTripHeader(store) {
  const s = store.state;
  const me = s.members.get(store.me);
  const id = store.tripId;
  const tab = route.tab;
  const tabLink = (t, label) =>
    `<a href="#/t/${id}${t === 'ausgaben' ? '' : `/${t}`}" class="${tab === t ? 'active' : ''}" ${tab === t ? 'aria-current="page"' : ''}>${label}</a>`;
  return `
    ${
      store.restoredFromCache && !store.restoreNoticeSeen
        ? `<div class="banner">Die Daten waren auf edupad.ch nicht mehr vorhanden und wurden aus deinem Browser wiederhergestellt.
            <button class="link" data-action="dismiss-restore">OK</button></div>`
        : ''
    }
    <section class="trip-head">
      <div class="trip-title">
        <h1>${esc(s.trip.name)}</h1>
        <button class="chip" data-action="switch-me" title="Person wechseln">${avatar(me, 'xs')}Du bist ${esc(me.name)} <span aria-hidden="true">⇄</span></button>
      </div>
      <button class="btn" data-action="share">Einladen</button>
    </section>
    <nav class="tabs">
      ${tabLink('ausgaben', 'Ausgaben')}${tabLink('salden', 'Salden')}${tabLink('gruppe', 'Gruppe')}
    </nav>`;
}

function viewExpenses(store) {
  const s = store.state;
  const me = store.me;
  const cur = s.trip.currency;
  const balance = computeBalances(s).get(me) || 0;
  const stats = computeStats(s);
  const items = [...s.expenses.values()].sort(
    (a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0),
  );
  const activeCount = [...s.members.values()].filter((m) => !m.removed).length;

  let lastDay = null;
  const rows = items
    .map((e) => {
      const head = e.date !== lastDay ? `<li class="day">${fmtDay(e.date)}</li>` : '';
      lastDay = e.date;
      const payer = s.members.get(e.paidBy);
      if (e.kind === 'transfer') {
        const to = Object.keys(e.shares)[0];
        return `${head}<li><button class="item transfer" data-action="edit-expense" data-eid="${e.id}">
          <span class="avatar icon" aria-hidden="true">⇄</span>
          <span class="main"><span class="title">${esc(nameOf(s, e.paidBy, me))} → ${esc(nameOf(s, to, me))}</span>
          <span class="sub">${esc(e.title)}</span></span>
          <span class="amt">${money(e.amount, cur)}</span></button></li>`;
      }
      const shares = sharesOf(e);
      const n = Object.keys(shares).length;
      const mine = shares[me] || 0;
      return `${head}<li><button class="item" data-action="edit-expense" data-eid="${e.id}">
        ${avatar(payer)}
        <span class="main"><span class="title">${esc(e.title)}</span>
        <span class="sub">${e.paidBy === me ? 'Du hast' : `${esc(payer?.name || 'Unbekannt')} hat`} bezahlt · ${n === activeCount ? 'alle' : `${n} ${n === 1 ? 'Person' : 'Personen'}`}</span></span>
        <span class="amt">${money(e.amount, cur)}<span class="sub">${mine ? `dein Anteil ${money(mine, cur)}` : 'nicht beteiligt'}</span></span>
      </button></li>`;
    })
    .join('');

  return `
    <section class="summary">
      <div><span class="label">Gesamt</span><strong>${money(stats.total, cur)}</strong></div>
      <div><span class="label">Dein Anteil</span><strong>${money(stats.consumed.get(me) || 0, cur)}</strong></div>
      <a href="#/t/${store.tripId}/salden"><span class="label">Dein Saldo</span><strong class="${balance > 0 ? 'pos' : balance < 0 ? 'neg' : ''}">${money(balance, cur, { sign: true })}</strong></a>
    </section>
    ${
      items.length
        ? `<ul class="list">${rows}</ul>`
        : `<div class="empty"><p><strong>Noch keine Ausgaben.</strong></p><p class="muted">Tippe auf „+ Ausgabe“, um die erste einzutragen.</p></div>`
    }
    <button class="fab" data-action="new-expense"><span aria-hidden="true">+</span> Ausgabe</button>`;
}

function viewBalances(store) {
  const s = store.state;
  const me = store.me;
  const cur = s.trip.currency;
  const bal = computeBalances(s);
  const stats = computeStats(s);
  const people = [...s.members.values()].filter((m) => !m.removed || bal.get(m.id));
  const max = Math.max(1, ...[...bal.values()].map(Math.abs));
  const transfers = settle(bal);

  const balRows = people
    .sort((a, b) => (bal.get(b.id) || 0) - (bal.get(a.id) || 0))
    .map((m) => {
      const b = bal.get(m.id) || 0;
      const pct = (Math.abs(b) / max) * 50;
      return `<li class="bal-row ${m.id === me ? 'me' : ''}">
        ${avatar(m, 'sm')}<span class="name">${esc(m.name)}${m.id === me ? ' <span class="muted">(du)</span>' : ''}</span>
        <span class="bar" aria-hidden="true"><span class="fill ${b >= 0 ? 'pos' : 'neg'}" style="width:${pct}%"></span></span>
        <span class="amt ${b > 0 ? 'pos' : b < 0 ? 'neg' : ''}">${money(b, cur, { sign: true })}</span>
      </li>`;
    })
    .join('');

  const transferRows = transfers
    .map(
      (t) => `<li class="${t.from === me || t.to === me ? 'me' : ''}">
        <span class="main"><strong>${esc(nameOf(s, t.from, me))}</strong> ${t.from === me ? 'zahlst' : 'zahlt'} <strong>${esc(t.to === me ? 'dir' : nameOf(s, t.to, me))}</strong></span>
        <span class="amt">${money(t.amount, cur)}</span>
        <button class="btn sm" data-action="settle" data-from="${t.from}" data-to="${t.to}" data-amount="${t.amount}">Erledigt</button>
      </li>`,
    )
    .join('');

  const statRows = people
    .map(
      (m) => `<tr><td>${esc(m.name)}</td><td>${money(stats.paid.get(m.id) || 0, cur)}</td><td>${money(stats.consumed.get(m.id) || 0, cur)}</td></tr>`,
    )
    .join('');

  return `
    <section class="card">
      <h2>Salden</h2>
      <p class="muted small">Plus = bekommt Geld zurück, Minus = schuldet der Gruppe Geld.</p>
      <ul class="balances">${balRows}</ul>
    </section>
    <section class="card">
      <h2>So gleicht ihr aus</h2>
      ${transfers.length ? `<ul class="transfers">${transferRows}</ul>` : '<p class="empty-inline">Alles ausgeglichen 🎉</p>'}
      <button class="btn ghost" data-action="new-transfer">Andere Zahlung erfassen</button>
    </section>
    <section class="card">
      <h2>Wer hat was?</h2>
      <table class="stats">
        <thead><tr><th>Person</th><th>bezahlt</th><th>Anteil</th></tr></thead>
        <tbody>${statRows}</tbody>
        <tfoot><tr><td>Gesamt</td><td>${money(stats.total, cur)}</td><td>${money(stats.total, cur)}</td></tr></tfoot>
      </table>
    </section>`;
}

function describeLog(state, me) {
  const names = new Map();
  const titles = new Map();
  const who = (mid) => (mid === me ? 'Du' : state.members.get(mid)?.name || 'Jemand');
  let tripSeen = false;
  const out = [];
  for (const ev of state.log) {
    let text = null;
    if (ev.type === 'trip') {
      text = tripSeen ? 'hat die Reise bearbeitet' : 'hat die Reise angelegt';
      tripSeen = true;
    } else if (ev.type === 'member') {
      const old = names.get(ev.mid);
      if (ev.removed) text = `hat ${esc(old)} entfernt`;
      else if (!old) text = ev.by === ev.mid ? 'ist beigetreten' : `hat ${esc(ev.name)} hinzugefügt`;
      else if (ev.name && ev.name !== old) text = `hat ${esc(old)} in ${esc(ev.name)} umbenannt`;
      if (ev.name) names.set(ev.mid, ev.name);
    } else if (ev.type === 'expense') {
      const isNew = !titles.has(ev.eid);
      const label = ev.kind === 'transfer' ? 'eine Zahlung' : `„${esc(ev.title)}“`;
      text = `hat ${label} ${isNew ? 'hinzugefügt' : 'geändert'}`;
      titles.set(ev.eid, ev.title);
    } else if (ev.type === 'expense_del') {
      text = `hat „${esc(titles.get(ev.eid) || 'eine Ausgabe')}“ gelöscht`;
    }
    if (text) out.push(`<li><strong>${esc(who(ev.by))}</strong> ${text}<span class="sub">${fmtRelative(ev.ts)}</span></li>`);
  }
  return out.reverse().slice(0, 30).join('');
}

function viewGroup(store) {
  const s = store.state;
  const me = store.me;
  const cur = s.trip.currency;
  const bal = computeBalances(s);
  const link = tripLink(store.tripId);
  const active = [...s.members.values()].filter((m) => !m.removed);
  const last = s.lastChange;
  const deletion = last ? last + PAD_RETENTION_DAYS * 864e5 : null;

  return `
    <section class="card">
      <h2>Mitreisende</h2>
      <ul class="members">
        ${active
          .map((m) => {
            const b = bal.get(m.id) || 0;
            return `<li>${avatar(m, 'sm')}
              <span class="name">${esc(m.name)}${m.id === me ? ' <span class="muted">(du)</span>' : ''}</span>
              <span class="amt small ${b > 0 ? 'pos' : b < 0 ? 'neg' : ''}">${money(b, cur, { sign: true })}</span>
              <button class="icon-btn" data-action="rename-member" data-mid="${m.id}" title="Umbenennen" aria-label="${esc(m.name)} umbenennen">✎</button>
              ${
                m.id !== me && !isInvolved(s, m.id)
                  ? `<button class="icon-btn" data-action="remove-member" data-mid="${m.id}" title="Entfernen" aria-label="${esc(m.name)} entfernen">×</button>`
                  : '<span class="icon-btn placeholder"></span>'
              }
            </li>`;
          })
          .join('')}
      </ul>
      <button class="btn ghost" data-action="add-member">+ Person hinzufügen</button>
    </section>
    <section class="card">
      <h2>Einladen</h2>
      <p class="muted small">Jeder mit diesem Link kann die Reise sehen und bearbeiten.</p>
      <div class="copy-row">
        <input readonly value="${esc(link)}" aria-label="Einladungslink" data-select>
        <button class="btn" data-action="copy-link">Kopieren</button>
      </div>
    </section>
    <section class="card">
      <h2>Reise</h2>
      <dl class="facts">
        <dt>Name</dt><dd>${esc(s.trip.name)}</dd>
        <dt>Währung</dt><dd>${esc(cur)}</dd>
        <dt>Code</dt><dd><code>${esc(store.tripId)}</code></dd>
      </dl>
      <div class="actions left">
        <button class="btn" data-action="edit-trip">Bearbeiten</button>
        <button class="btn ghost" data-action="switch-me">Person wechseln</button>
      </div>
    </section>
    <section class="card">
      <h2>Daten &amp; Backup</h2>
      <p class="small">Gespeichert auf edupad.ch${
        store.sync.pads > 1 ? ` in ${store.sync.pads} Pads (ein volles Pad verweist auf das nächste)` : ''
      }, verschlüsselt mit einem Schlüssel aus dem Link.
        edupad löscht Pads, die ${PAD_RETENTION_DAYS} Tage nicht bearbeitet wurden${
          deletion ? ` – bei dieser Reise frühestens am <strong>${fmtDate(deletion)}</strong>` : ''
        }. Jeder Browser, der die Reise geöffnet hat, behält eine Kopie und stellt sie dann automatisch wieder her.</p>
      <div class="actions left">
        <button class="btn" data-action="download-backup">Backup herunterladen</button>
        <label class="btn ghost">Backup einspielen<input type="file" accept=".json,application/json" data-action="restore-file" hidden></label>
        <a class="btn ghost" href="${esc(store.padUrl)}" target="_blank" rel="noopener">Rohdaten auf edupad ↗</a>
      </div>
      <button class="link danger" data-action="forget-trip" data-id="${store.tripId}">Reise aus diesem Browser entfernen</button>
    </section>
    <section class="card">
      <h2>Verlauf</h2>
      <ul class="log">${describeLog(s, me) || '<li class="muted">Noch nichts passiert.</li>'}</ul>
    </section>`;
}

function viewTrip() {
  if (!current) return viewLoading(null);
  const { store } = current;
  const s = store.state;
  if (!s.exists) return store.sync.loaded ? viewNotFound() : viewLoading(store);
  if (!store.me) return viewWhoAmI(store);
  const body =
    route.tab === 'salden' ? viewBalances(store) : route.tab === 'gruppe' ? viewGroup(store) : viewExpenses(store);
  return viewTripHeader(store) + body;
}

// ============================================================== rendering

const SYNC_TEXT = {
  idle: ['', ''],
  connecting: ['Verbinde …', 'busy'],
  online: ['Gespeichert', 'ok'],
  readonly: ['Nur lesen', 'warn'],
  offline: ['Offline', 'off'],
  error: ['Fehler', 'err'],
};

function renderSync() {
  const store = current?.store;
  let text = '';
  let cls = '';
  let title = '';
  if (store && route.view === 'trip') {
    const { status, pending, error } = store.sync;
    [text, cls] = SYNC_TEXT[status] || ['', ''];
    if (status === 'online' && pending) [text, cls] = ['Speichert …', 'busy'];
    if (status === 'offline' && pending) text = `Offline · ${pending} ausstehend`;
    title =
      status === 'error'
        ? error
        : status === 'offline'
          ? 'Keine Verbindung zu edupad.ch. Deine Änderungen werden gespeichert, sobald du wieder online bist.'
          : 'Synchronisation mit edupad.ch';
  }
  $sync.hidden = !text;
  $sync.className = `sync ${cls}`;
  $sync.textContent = text;
  $sync.title = title || '';
  for (const el of document.querySelectorAll('[data-sync-label]')) {
    el.textContent = !store ? '' : store.sync.pending ? 'Wird gespeichert …' : store.sync.loaded ? 'Gespeichert ✓' : '';
  }
}

function render() {
  renderQueued = false;
  let html;
  if (route.view === 'new') html = viewNew();
  else if (route.view === 'trip') html = viewTrip();
  else html = viewHome();
  $app.innerHTML = html;
  const tripName = current?.store.state.exists ? current.store.state.trip.name : null;
  document.title = tripName ? `${tripName} · SplitIt` : 'SplitIt – Reisekosten teilen';
  renderSync();
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

// ============================================================== routing

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'neu') return { view: 'new' };
  if (parts[0] === 't' && parts[1]) {
    return { view: 'trip', tripId: parts[1].toLowerCase(), tab: ['salden', 'gruppe'].includes(parts[2]) ? parts[2] : 'ausgaben' };
  }
  return { view: 'home' };
}

function attachStore(store) {
  current = { tripId: store.tripId, store, touchedName: null };
  current.unsub = store.subscribe(() => {
    const { exists, trip } = store.state;
    if (exists && current?.store === store && current.touchedName !== trip.name) {
      current.touchedName = trip.name;
      recentTrips.touch(store.tripId, trip.name);
    }
    if (route.view === 'trip') scheduleRender();
  });
  store.connect();
}

function closeTrip() {
  if (!current) return;
  current.unsub();
  current.store.close();
  current = null;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
}

async function onRoute() {
  const seq = ++routeSeq;
  const prev = route;
  route = parseRoute();
  if (route.view === 'trip' && !isTripId(route.tripId)) {
    const id = parseTripId(location.hash);
    if (id) return location.replace(`#/t/${id}`);
  }
  if (current && (route.view !== 'trip' || current.tripId !== route.tripId)) closeTrip();
  if (route.view === 'trip' && !current) {
    if (!isTripId(route.tripId)) {
      $app.innerHTML = viewNotFound();
      return;
    }
    render();
    const store = await TripStore.open(route.tripId);
    if (seq !== routeSeq) return;
    attachStore(store);
  }
  render();
  if (prev.view !== route.view || prev.tripId !== route.tripId || prev.tab !== route.tab) window.scrollTo(0, 0);
}

// ============================================================== actions

async function restoreBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    data = null;
  }
  if (!data || data.app !== 'splitit' || !isTripId(data.tripId) || !Array.isArray(data.events)) {
    toast('Das ist keine gültige SplitIt-Backup-Datei.');
    return;
  }
  if (current?.tripId !== data.tripId) {
    closeTrip();
    attachStore(await TripStore.open(data.tripId));
  }
  const n = current.store.importEvents(data.events);
  location.hash = `#/t/${data.tripId}`;
  render();
  toast(n ? `${n} Einträge aus dem Backup übernommen` : 'Backup ist bereits vollständig enthalten');
}

async function forgetTrip(id) {
  const name = recentTrips.list().find((t) => t.id === id)?.name || current?.store.state.trip.name || 'Reise';
  const pending = (local.get(`outbox:${id}`, []) || []).length;
  const ok = await confirmDialog({
    title: `„${name}“ aus diesem Browser entfernen?`,
    text: pending
      ? `Achtung: ${pending} Änderung(en) sind noch nicht auf edupad gespeichert und gehen verloren.`
      : 'Die Reise bleibt für die anderen erhalten. Über den Link kannst du jederzeit wieder beitreten.',
    confirm: 'Entfernen',
    danger: true,
  });
  if (!ok) return;
  if (current?.tripId === id) closeTrip();
  for (const k of ['cache', 'outbox', 'me']) local.remove(`${k}:${id}`);
  recentTrips.remove(id);
  if (location.hash === '' || location.hash === '#/') render();
  else location.hash = '#/';
}

const actions = {
  'pick-me': (el) => current.store.setMe(el.dataset.mid),
  'switch-me': () => current.store.setMe(null),
  'add-me': async () => {
    const { store } = current;
    const name = await promptDialog({
      title: 'Wie heißt du?',
      label: 'Vorname',
      confirm: 'Beitreten',
      validate: (v) => (nameTaken(store.state, v) ? 'Den Namen gibt es schon – wähle ihn in der Liste aus.' : null),
    });
    if (!name) return;
    const mid = randomId(8);
    store.dispatch({ type: 'member', mid, name, by: mid });
    store.setMe(mid);
  },
  share: () => shareDialog(current.store),
  'new-expense': () => expenseDialog(current.store),
  'edit-expense': (el) => expenseDialog(current.store, el.dataset.eid),
  'new-transfer': () => transferDialog(current.store),
  settle: (el) =>
    transferDialog(current.store, null, { from: el.dataset.from, to: el.dataset.to, amount: Number(el.dataset.amount) }),
  'add-member': async () => {
    const { store } = current;
    const name = await promptDialog({
      title: 'Person hinzufügen',
      label: 'Vorname',
      confirm: 'Hinzufügen',
      validate: (v) => (nameTaken(store.state, v) ? 'Diesen Namen gibt es schon.' : null),
    });
    if (name) store.dispatch({ type: 'member', mid: randomId(8), name });
  },
  'rename-member': async (el) => {
    const { store } = current;
    const m = store.state.members.get(el.dataset.mid);
    const name = await promptDialog({
      title: 'Umbenennen',
      label: 'Vorname',
      value: m.name,
      validate: (v) => (nameTaken(store.state, v, m.id) ? 'Diesen Namen gibt es schon.' : null),
    });
    if (name && name !== m.name) store.dispatch({ type: 'member', mid: m.id, name });
  },
  'remove-member': async (el) => {
    const { store } = current;
    const m = store.state.members.get(el.dataset.mid);
    if (await confirmDialog({ title: `${m.name} entfernen?`, confirm: 'Entfernen', danger: true })) {
      store.dispatch({ type: 'member', mid: m.id, removed: true });
    }
  },
  'edit-trip': () => tripDialog(current.store),
  'copy-link': () => copyText(tripLink(current.tripId)),
  'download-backup': () => {
    const { store } = current;
    const slug = store.state.trip.name.toLowerCase().replace(/[^a-z0-9äöü]+/g, '-').replace(/^-|-$/g, '');
    download(`splitit-${slug || 'reise'}-${today()}.json`, store.exportBackup());
  },
  'forget-trip': (el) => forgetTrip(el.dataset.id),
  'dismiss-restore': () => {
    current.store.restoreNoticeSeen = true;
    render();
  },
  'add-field': () => {
    const box = $app.querySelector('.others');
    box.insertAdjacentHTML('beforeend', '<input name="other" maxlength="60" placeholder="Vorname" autocomplete="off" aria-label="Vorname">');
    box.lastElementChild.focus();
  },
};

async function onCreate(form) {
  const fail = (msg) => Object.assign(form.querySelector('.error'), { textContent: msg, hidden: false });
  const name = form.elements.name.value.trim();
  const me = form.elements.me.value.trim();
  const others = [...form.querySelectorAll('input[name=other]')].map((i) => i.value.trim()).filter(Boolean);
  if (!name) return fail('Bitte gib der Reise einen Namen.');
  if (!me) return fail('Bitte gib deinen Namen ein.');
  const names = [me, ...others];
  const lower = names.map((n) => n.toLowerCase());
  const dup = names.find((n, i) => lower.indexOf(n.toLowerCase()) !== i);
  if (dup) return fail(`„${dup}“ steht doppelt in der Liste.`);
  form.querySelector('button.primary').disabled = true;
  try {
    const store = await createTrip({ name, currency: form.elements.currency.value, names });
    closeTrip();
    attachStore(store);
    recentTrips.touch(store.tripId, name);
    location.hash = `#/t/${store.tripId}`;
    shareDialog(store, { created: true });
  } catch (e) {
    console.error(e);
    form.querySelector('button.primary').disabled = false;
    fail('Die Reise konnte nicht angelegt werden. Unterstützt dein Browser Web Crypto?');
  }
}

function onJoin(form) {
  const id = parseTripId(form.elements.link.value);
  const err = form.parentElement.querySelector('.error');
  if (!id) {
    Object.assign(err, { textContent: 'Das sieht nicht nach einem SplitIt-Link oder Code aus.', hidden: false });
    return;
  }
  location.hash = `#/t/${id}`;
}

// ============================================================== wiring

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !$app.contains(el) || el.matches('input[type=file]')) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el, e);
  }
});

$app.addEventListener('change', (e) => {
  if (e.target.matches('input[type=file][data-action=restore-file]') && e.target.files[0]) {
    restoreBackup(e.target.files[0]);
  }
});

$app.addEventListener('input', (e) => {
  const err = e.target.closest('form')?.parentElement?.querySelector('.error');
  if (err) err.hidden = true;
});

$app.addEventListener('focusin', (e) => {
  if (e.target.matches('[data-select]')) e.target.select();
});

$app.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  if (form.dataset.form === 'create') onCreate(form);
  if (form.dataset.form === 'join') onJoin(form);
});

$app.addEventListener('keydown', (e) => {
  // Enter in the last "Mitreisende" field adds another field instead of submitting.
  if (e.key !== 'Enter' || !e.target.matches('input[name=other]')) return;
  const inputs = [...$app.querySelectorAll('input[name=other]')];
  if (e.target === inputs.at(-1) && e.target.value.trim()) {
    e.preventDefault();
    actions['add-field']();
  }
});

window.addEventListener('hashchange', onRoute);
window.addEventListener('online', () => current?.store.reconnectNow());
// Don't wait for the ping timeout to notice that the network is gone.
window.addEventListener('offline', () => current?.store.dropConnections());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') current?.store.reconnectNow();
});

// Support ?t=<id> links as well.
const queryId = new URLSearchParams(location.search).get('t');
if (isTripId(queryId) && !location.hash) {
  history.replaceState(null, '', `${location.pathname}#/t/${queryId}`);
}
onRoute();
