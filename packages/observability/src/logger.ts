import { REDACTED, scrubValue } from "@opensesame/log-scrub";
import { overlapCast } from "@opensesame/os-domain";
import {
  type Bindings,
  type ChildLoggerOptions,
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
 * (ADR 0156). The rules are `spec/log-scrub/log-scrub.json`, the same file the
 * Host's log pipeline reads.
 *
 * Pino's `redact.paths` wildcard only matches one level, so `*.token` misses
 * `ctx.session.access_token`; this deep walk is what actually holds.
 */
export function redactDeep<T>(value: T): T {
  return scrubValue(value);
}

/**
 * `child({ ... })` bindings are serialised once, when the child is made, and
 * pino resets the `formatters.bindings` hook on every child, so neither that
 * hook, `hooks.logMethod` nor `formatters.log` ever sees them: a `url` with a
 * `?token=` or a bound `client_secret` would be written raw. Descendants
 * inherit `child` and `setBindings` through the prototype chain, so replacing
 * both on the root covers every logger made from it.
 */
function scrubChildBindings(logger: Logger): Logger {
  const makeChild: Logger["child"] = logger.child;
  const setBindings: Logger["setBindings"] = logger.setBindings;
  Object.defineProperties(logger, {
    child: {
      configurable: true,
      writable: true,
      value(this: Logger, bindings: Bindings, options?: ChildLoggerOptions) {
        return Reflect.apply(makeChild, this, [scrubValue(bindings), options]);
      },
    },
    setBindings: {
      configurable: true,
      writable: true,
      value(this: Logger, bindings: Bindings) {
        Reflect.apply(setBindings, this, [scrubValue(bindings)]);
      },
    },
  });
  return logger;
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
      // Belt and braces: the merged object of each call once more. Child
      // bindings never reach this formatter; see `scrubChildBindings`.
      log: (obj) => overlapCast(scrubValue(obj)),
    },
  };

  if (options.destination) {
    return scrubChildBindings(pino(opts, options.destination));
  }
  // With OPENSESAME_LOG_FILE set, lines are sealed into that file and never
  // written to stdout (ADR 0156); a file that cannot be opened throws.
  const sealedFile = process.env.OPENSESAME_LOG_FILE;
  if (sealedFile) {
    return scrubChildBindings(
      pino(
        opts,
        createSealedLogDestination(
          sealedFile,
          process.env.OPENSESAME_LOG_KEY_FILE,
        ),
      ),
    );
  }
  return scrubChildBindings(pino(opts));
}

export type { Logger };
