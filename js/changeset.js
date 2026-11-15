// Minimal implementation of Etherpad's changeset format – just enough to
// append/replace text and to follow changes made by other clients.
//
//   Z:<oldLen><'>'|'<'><lenDiff><ops>$<charBank>      (all numbers base36)
//
// Ops: "=n" keep, "-n" delete, "+n" insert (taken from the char bank).
// An op that spans newlines is prefixed with "|<lines>" and must end with a
// newline; attributes are prefixed as "*<num>".

const b36 = (n) => n.toString(36);

function opsForText(opcode, text, attribs = '') {
  if (!text) return '';
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return `${attribs}${opcode}${b36(text.length)}`;
  const lines = (text.slice(0, lastNl + 1).match(/\n/g) || []).length;
  let ops = `${attribs}|${b36(lines)}${opcode}${b36(lastNl + 1)}`;
  const rest = text.length - lastNl - 1;
  if (rest > 0) ops += `${attribs}${opcode}${b36(rest)}`;
  return ops;
}

/**
 * Builds a canonical changeset that replaces `ndel` chars at `start` of
 * `oldText` with `ins`. `attribs` is e.g. "*0" (index into the sent apool).
 */
export function makeSplice(oldText, start, ndel, ins, attribs = '') {
  if (ndel === 0 && ins === '') throw new Error('Empty changeset');
  const diff = ins.length - ndel;
  const header = `Z:${b36(oldText.length)}${diff >= 0 ? '>' : '<'}${b36(Math.abs(diff))}`;
  const ops =
    opsForText('=', oldText.slice(0, start)) +
    opsForText('-', oldText.slice(start, start + ndel)) +
    opsForText('+', ins, attribs);
  return `${header}${ops}$${ins}`;
}

export function unpack(cs) {
  const m = /^Z:([0-9a-z]+)([><])([0-9a-z]+)/.exec(cs);
  if (!m) throw new Error(`Not a changeset: ${String(cs).slice(0, 40)}`);
  const oldLen = parseInt(m[1], 36);
  const delta = parseInt(m[3], 36);
  const rest = cs.slice(m[0].length);
  const dollar = rest.indexOf('$');
  return {
    oldLen,
    newLen: m[2] === '>' ? oldLen + delta : oldLen - delta,
    ops: dollar < 0 ? rest : rest.slice(0, dollar),
    charBank: dollar < 0 ? '' : rest.slice(dollar + 1),
  };
}

/** Applies a changeset to plain text (attributes are ignored). */
export function applyToText(text, cs) {
  const { oldLen, newLen, ops, charBank } = unpack(cs);
  if (text.length !== oldLen) {
    throw new Error(`Changeset expects length ${oldLen}, text has ${text.length}`);
  }
  const re = /((?:\*[0-9a-z]+)*)(?:\|([0-9a-z]+))?([-+=])([0-9a-z]+)|(.)/g;
  const out = [];
  let pos = 0;
  let bank = 0;
  let m;
  while ((m = re.exec(ops))) {
    if (m[5] !== undefined) throw new Error(`Invalid op character "${m[5]}"`);
    const n = parseInt(m[4], 36);
    if (m[3] === '=') {
      out.push(text.slice(pos, pos + n));
      pos += n;
    } else if (m[3] === '-') {
      pos += n;
    } else {
      out.push(charBank.slice(bank, bank + n));
      bank += n;
    }
  }
  if (pos > text.length) throw new Error('Changeset runs past end of text');
  out.push(text.slice(pos));
  const result = out.join('');
  if (result.length !== newLen) throw new Error('Changeset length mismatch');
  return result;
}
