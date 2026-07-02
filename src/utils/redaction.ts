const secretKeyPattern = /(authorization|token|secret|key|password)/i;

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      secretKeyPattern.test(key) ? "[redacted]" : redactSecrets(entry)
    ])
  ) as T;
}
