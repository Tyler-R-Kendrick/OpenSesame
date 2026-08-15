const SECRET_NEEDLES = [
  "password",
  "secret",
  "token",
  "authorization",
  "refresh_token",
  "access_token",
  "client_secret",
  "cookie",
];

export function assertNoSecretFields(
  value: unknown,
  redact: (v: unknown) => unknown,
): void {
  const redacted = redact(value);
  walk(redacted, (key, child) => {
    if (SECRET_NEEDLES.some((n) => key.toLowerCase().includes(n))) {
      if (
        typeof child === "string" &&
        child !== "[REDACTED]" &&
        child.length > 0
      ) {
        throw new Error(`secret field ${key} survived redaction`);
      }
    }
  });
}

export function assertMalformedDenied(ok: boolean, reason: string): void {
  if (ok) {
    throw new Error(reason);
  }
}

function walk(
  value: unknown,
  visit: (key: string, child: unknown) => void,
): void {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      visit(k, v);
      walk(v, visit);
    }
  }
}
