/**
 * Formats dates like Go's time.Time JSON (RFC 3339 with trailing zeros of the fraction
 * trimmed, e.g. "2026-11-10T02:14:05.52Z"). Used by sendJSON for every response.
 */
export function goTime(d: Date): string {
  const iso = d.toISOString(); // 2026-11-10T02:14:05.520Z
  return iso.replace(/\.(\d*?)0*Z$/, (_m, frac: string) => (frac ? `.${frac}Z` : 'Z'));
}

/** JSON.stringify replacer that writes Date values with goTime. */
export function goJSONReplacer(this: any, key: string, value: unknown): unknown {
  const raw = this[key];
  if (raw instanceof Date) return goTime(raw);
  return value;
}

/** JSON text as the Go API wrote it (dates in Go format, trailing newline). */
export const goJSON = (body: unknown) => JSON.stringify(body, goJSONReplacer) + '\n';
