import { REDACTED, scrubValue } from "@opensesame/log-scrub";
import { overlapCast } from "@opensesame/os-domain";
import {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
  pino,
} from "pino";
import { createSealedLogDestination } from "./sealed-log.js";

/** Paths redacted from structured logs (tokens, codes, secrets). */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "access_token",
  "refresh_token",
  "id_token",
  "claimToken",
  "claim_token",
  "token",
  "userCode",
  "user_code",
  "verificationUriComplete",
  "verification_uri_complete",
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
  "*.verificationUriComplete",
  "*.verification_uri_complete",
  "*.deviceCode",
  "*.device_code",
  "*.client_secret",
  "*.password",
  "*.code_verifier",
] as const;

/**
 * A copy of `value` with every secret gone: sensitive keys censored at any
 * depth, every string scrubbed, errors flattened to scrubbed plain objects
 * (ADR 0155). The rules are `spec/log-scrub/log-scrub.json`, the same file the
 * Host's log pipeline reads.
 *
 * Pino's `redact.paths` wildcard only matches one level, so `*.token` misses
 * `ctx.session.access_token`; this deep walk is what actually holds.
 */
export function redactDeep<T>(value: T): T {
  return scrubValue(value);
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
      censor: REDACTED,
    },
    hooks: {
      // Every argument a call site passes: the merge object, the message
      // string and the interpolation values. A bearer in `log.error(msg)` or
      // in `err.message` has no key to censor, so it is scrubbed by shape.
      logMethod(args, method) {
        method.apply(this, overlapCast(args.map((arg) => scrubValue(arg))));
      },
    },
    formatters: {
      // Belt and braces: the merged object once more, after bindings.
      log: (obj) => overlapCast(scrubValue(obj)),
    },
  };

  if (options.destination) {
    return pino(opts, options.destination);
  }
  // With OPENSESAME_LOG_FILE set, lines are sealed into that file and never
  // written to stdout (ADR 0155); a file that cannot be opened throws.
  const sealedFile = process.env.OPENSESAME_LOG_FILE;
  if (sealedFile) {
    return pino(
      opts,
      createSealedLogDestination(
        sealedFile,
        process.env.OPENSESAME_LOG_KEY_FILE,
      ),
    );
  }
  return pino(opts);
}

export type { Logger };
