// Event log -> trip state, plus the money maths.
//
// Every line in the pad is one event:
//   {v:1, id, ts, by, type, ...payload}
// Events are applied in pad order; for the same entity the later event wins.
//
//   trip         {name?, currency?}                    create / rename
//   member       {mid, name?, removed?}                add / rename / remove
//   expense      {eid, kind, title, amount, paidBy, date, split, shares}
//                kind:  "expense" | "transfer"
//                split: "equal" | "shares" | "exact"
//                shares: {mid: weight}  (exact: {mid: cents})
//   expense_del  {eid}                                 deletion is final
//
// All amounts are integer cents.

export const CURRENCIES = ['EUR', 'CHF', 'USD', 'GBP', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF'];
const MAX_AMOUNT = 100_000_000_00;

const isStr = (s, max = 200) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const isCents = (n) => Number.isInteger(n) && n > 0 && n <= MAX_AMOUNT;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function validShares(split, shares, amount) {
  if (!shares || typeof shares !== 'object' || Array.isArray(shares)) return false;
  const vals = Object.values(shares);
  if (!vals.length || vals.length > 200) return false;
  if (split === 'exact') {
    return vals.every((v) => Number.isInteger(v) && v >= 0) && vals.reduce((a, b) => a + b, 0) === amount;
  }
  return vals.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) && vals.some((v) => v > 0);
}

export function foldEvents(events) {
  const state = {
    exists: false,
    trip: { name: 'Reise', currency: 'EUR', createdAt: null, createdBy: null },
    members: new Map(),
    expenses: new Map(),
    deleted: new Set(),
    log: [],
    lastChange: null,
  };
  const seen = new Set();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || seen.has(ev.id)) continue;
    seen.add(ev.id);
    if (applyEvent(state, ev)) {
      state.log.push(ev);
      if (Number.isFinite(ev.ts)) state.lastChange = Math.max(state.lastChange || 0, ev.ts);
    }
  }
  return state;
}

function applyEvent(state, ev) {
  switch (ev.type) {
    case 'trip': {
      if (!state.exists) {
        state.exists = true;
        state.trip.createdAt = ev.ts || null;
        state.trip.createdBy = ev.by || null;
      }
      if (isStr(ev.name, 100)) state.trip.name = ev.name.trim();
      if (CURRENCIES.includes(ev.currency)) state.trip.currency = ev.currency;
      return true;
    }
    case 'member': {
      if (!isStr(ev.mid, 40)) return false;
      const prev = state.members.get(ev.mid);
      if (!prev && !isStr(ev.name, 60)) return false;
      state.members.set(ev.mid, {
        id: ev.mid,
        name: isStr(ev.name, 60) ? ev.name.trim() : prev.name,
        removed: ev.removed === true ? true : ev.removed === false ? false : prev?.removed || false,
        createdAt: prev?.createdAt ?? ev.ts ?? null,
      });
      return true;
    }
    case 'expense': {
      const kind = ev.kind === 'transfer' ? 'transfer' : 'expense';
      const split = ['equal', 'shares', 'exact'].includes(ev.split) ? ev.split : null;
      if (
        !isStr(ev.eid, 40) ||
        state.deleted.has(ev.eid) ||
        !isCents(ev.amount) ||
        !isStr(ev.paidBy, 40) ||
        !split ||
        !validShares(split, ev.shares, ev.amount)
      ) {
        return false;
      }
      const prev = state.expenses.get(ev.eid);
      state.expenses.set(ev.eid, {
        id: ev.eid,
        kind,
        title: isStr(ev.title, 100) ? ev.title.trim() : kind === 'transfer' ? 'Ausgleich' : 'Ausgabe',
        amount: ev.amount,
        paidBy: ev.paidBy,
        date: isDate(ev.date) ? ev.date : new Date(ev.ts || 0).toISOString().slice(0, 10),
        split,
        shares: { ...ev.shares },
        createdAt: prev?.createdAt ?? ev.ts ?? null,
        createdBy: prev?.createdBy ?? ev.by ?? null,
        updatedAt: ev.ts ?? null,
        updatedBy: ev.by ?? null,
      });
      return true;
    }
    case 'expense_del': {
      if (!isStr(ev.eid, 40)) return false;
      state.deleted.add(ev.eid);
      state.expenses.delete(ev.eid);
      return true;
    }
    default:
      return false;
  }
}

/**
 * Splits `amount` cents according to integer weights so that the parts add up
 * exactly (largest remainder method, ties broken by member id – so every
 * client gets the same result).
 */
export function allocate(amount, weights) {
  const entries = Object.entries(weights)
    .filter(([, w]) => w > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const result = {};
  if (!total) return result;
  let rest = amount;
  const fractions = entries.map(([mid, w], index) => {
    const exact = (amount * w) / total;
    const floor = Math.floor(exact + 1e-9);
    result[mid] = floor;
    rest -= floor;
    return { mid, frac: exact - floor, index };
  });
  fractions.sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; rest > 0; i = (i + 1) % fractions.length, rest--) result[fractions[i].mid]++;
  return result;
}

/** {mid: cents} that each person owes for this expense. */
export function sharesOf(expense) {
  if (expense.split === 'exact') {
    return Object.fromEntries(Object.entries(expense.shares).filter(([, v]) => v > 0));
  }
  return allocate(expense.amount, expense.shares);
}

/** Positive balance = gets money back, negative = owes money. */
export function computeBalances(state) {
  const bal = new Map();
  for (const mid of state.members.keys()) bal.set(mid, 0);
  const add = (mid, v) => bal.set(mid, (bal.get(mid) || 0) + v);
  for (const exp of state.expenses.values()) {
    add(exp.paidBy, exp.amount);
    for (const [mid, cents] of Object.entries(sharesOf(exp))) add(mid, -cents);
  }
  return bal;
}

/** Per person: what they paid and what they consumed (transfers excluded). */
export function computeStats(state) {
  const paid = new Map();
  const consumed = new Map();
  let total = 0;
  for (const exp of state.expenses.values()) {
    if (exp.kind === 'transfer') continue;
    total += exp.amount;
    paid.set(exp.paidBy, (paid.get(exp.paidBy) || 0) + exp.amount);
    for (const [mid, cents] of Object.entries(sharesOf(exp))) {
      consumed.set(mid, (consumed.get(mid) || 0) + cents);
    }
  }
  return { total, paid, consumed };
}

/** Greedy settlement: at most n-1 transfers that bring everyone to zero. */
export function settle(balances) {
  const byAmount = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
  const creditors = [...balances].filter(([, v]) => v > 0).sort(byAmount);
  const debtors = [...balances].filter(([, v]) => v < 0).map(([m, v]) => [m, -v]).sort(byAmount);
  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i][1], creditors[j][1]);
    transfers.push({ from: debtors[i][0], to: creditors[j][0], amount });
    debtors[i][1] -= amount;
    creditors[j][1] -= amount;
    if (!debtors[i][1]) i++;
    if (!creditors[j][1]) j++;
  }
  return transfers;
}

/** True if the member is referenced by any expense (then it can't be removed). */
export function isInvolved(state, mid) {
  for (const exp of state.expenses.values()) {
    if (exp.paidBy === mid || (exp.shares[mid] || 0) > 0) return true;
  }
  return false;
}

/** "12,50", "12.5", "1'234.50", "1.234,5" -> cents (or null). */
export function parseAmount(input) {
  const s = String(input ?? '').trim().replace(/[\s'’]/g, '');
  if (!s) return null;
  const lastSep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  let int = s;
  let frac = '';
  if (lastSep >= 0 && s.length - lastSep - 1 <= 2) {
    int = s.slice(0, lastSep);
    frac = s.slice(lastSep + 1);
  }
  int = int.replace(/[.,]/g, '');
  if (!/^\d*$/.test(int) || !/^\d*$/.test(frac) || (!int && !frac)) return null;
  const cents = parseInt(int || '0', 10) * 100 + parseInt(`${frac}00`.slice(0, 2), 10);
  return Number.isSafeInteger(cents) ? cents : null;
}
