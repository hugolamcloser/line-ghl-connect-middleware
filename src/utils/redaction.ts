const secretKeyPattern = /(authorization|token|secret|key|password)/i;
const sensitiveTextPatterns = [
  /("(?:access_token|refresh_token|client_secret|code|authorization)"\s*:\s*")[^"]*"/gi,
  /((?:access_token|refresh_token|client_secret|code|authorization)=)[^&\s]+/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi
];

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

export function redactSensitiveText(value: string): string {
  return sensitiveTextPatterns.reduce((redacted, pattern) => redacted.replace(pattern, "$1[redacted]"), value);
}
