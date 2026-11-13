/**
 * Converts an outbound payload into its wire form: `Date` → ISO 8601 string,
 * `undefined` properties dropped (as JSON would).
 */
export function toWire(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toWire);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = toWire(v);
    return out;
  }
  return value;
}

/**
 * Converts the date-time fields at `paths` of a freshly decoded payload into `Date`s (in place).
 * `*` in a path addresses every element of an array. Unparseable strings are left untouched.
 */
export function reviveDates<T>(payload: T, paths: readonly (readonly string[])[] = []): T {
  for (const path of paths) revive(payload, path, 0);
  return payload;
}

function revive(node: unknown, path: readonly string[], depth: number): void {
  if (node === null || typeof node !== 'object') return;
  const key = path[depth]!;
  const children: [object, string | number][] =
    key === '*' ? (Array.isArray(node) ? node.map((_, i) => [node, i]) : []) : [[node, key]];

  for (const [parent, k] of children) {
    const value = (parent as Record<string | number, unknown>)[k];
    if (depth < path.length - 1) {
      revive(value, path, depth + 1);
    } else if (typeof value === 'string') {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) (parent as Record<string | number, unknown>)[k] = date;
    }
  }
}
