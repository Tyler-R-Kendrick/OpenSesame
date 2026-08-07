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
  "code",
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
  "*.code",
  "*.code_verifier",
] as const;

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
      censor: "[Redacted]",
    },
  };

  if (options.destination) {
    return pino(opts, options.destination);
  }
  return pino(opts);
}

export type { Logger };
