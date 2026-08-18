import { pino, type Logger, type LoggerOptions, type DestinationStream } from "pino";

/** Paths redacted from structured logs (tokens, codes, secrets). */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers[\"set-cookie\"]",
  "access_token",
  "refresh_token",
  "id_token",
  "claimToken",
  "claim_token",
  "token",
  "userCode",
  "user_code",
  "deviceCode",
  "device_code",
  "client_secret",
  "password",
  "code_verifier",
  "authorization",
  "cookie",
  "*.access_token",
  "*.refresh_token",
  "*.id_token",
  "*.claimToken",
  "*.claim_token",
  "*.token",
  "*.userCode",
  "*.user_code",
  "*.deviceCode",
  "*.device_code",
  "*.client_secret",
  "*.password",
  "*.code_verifier",
] as const;

/**
 * Sensitive key names, matched at any depth.
 *
 * Pino's `redact.paths` wildcard only matches one level, so `*.token` misses
 * `ctx.session.access_token`. This pattern backs a deep walk instead.
 */
export const SENSITIVE_KEY_PATTERN =
  /^(?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|claim[_-]?token|attempt[_-]?token|session[_-]?token|operator[_-]?token|bearer|token|user[_-]?code|device[_-]?code|client[_-]?secret|api[_-]?key|api[_-]?secret|secret|password|passphrase|pin|private[_-]?key|authorization[_-]?code|code[_-]?verifier|assertion|dpop|ciphertext)$/i;

const CENSOR = "[Redacted]";
/** Depth ceiling so a hostile/cyclic object cannot stall the logger. */
const MAX_REDACT_DEPTH = 12;

/** Recursively censor sensitive keys at any depth; cycle- and array-safe. */
export function redactDeep<T>(value: T): T {
  return walk(value, 0, new WeakSet<object>()) as T;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return CENSOR;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth + 1, seen));
  }
  // Non-plain objects (Error, Date, Buffer, …) are left to pino's serializers.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? CENSOR : walk(item, depth + 1, seen);
  }
  return out;
}

export interface CreateLoggerOptions {
  name?: string;
  level?: string;
  /** Extra redact paths beyond the default token/code allowlist. */
  redactPaths?: string[];
  /** Override destination (tests). */
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level =
    options.level ??
    process.env.OPENSESAME_LOG_LEVEL ??
    process.env.LOG_LEVEL ??
    "info";

  const opts: LoggerOptions = {
    name: options.name ?? "opensesame",
    level,
    redact: {
      paths: [...LOG_REDACT_PATHS, ...(options.redactPaths ?? [])],
      censor: CENSOR,
    },
    formatters: {
      // Deep pass catches sensitive keys below the one level `redact.paths` sees.
      log: (obj) => redactDeep(obj) as Record<string, unknown>,
    },
  };

  if (options.destination) {
    return pino(opts, options.destination);
  }
  return pino(opts);
}

export type { Logger };
