import { randomBytes } from 'node:crypto';

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** n random letters and digits (about 5.95 bits each), like the Go API's randomID. */
export function randomID(n: number): string {
  const b = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ID_ALPHABET[b[i] % ID_ALPHABET.length];
  return s;
}

/** A random id for a staff account. */
export const newStaffID = () => 'stf_' + randomID(12);

/** Cuts s to at most n characters (runes). */
export function truncateRunes(s: string, n: number): string {
  const r = [...s];
  return r.length <= n ? s : r.slice(0, n).join('');
}

/** Escapes a string for use inside a regular expression (Go's regexp.QuoteMeta). */
export const quoteMeta = (s: string) => s.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&');
