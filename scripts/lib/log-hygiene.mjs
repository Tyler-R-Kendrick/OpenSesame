/**
 * The log-hygiene rules -- what `scripts/quality/log-hygiene-gate.mjs` enforces
 * (ADR 0155).
 *
 * Every log line passes through the shared scrubber only if it goes through the
 * logger that runs it. A call site that writes straight to the console, builds
 * its own pino instance or installs a tracing subscriber without the scrubbing
 * writer is a way around it, so each is counted, and the count only falls.
 *
 * Pure: it reads text and a recorded ledger and knows nothing about disk.
 */

/** A TypeScript file that is production code, not a test or a generated file. */
export function isProductionTypeScript(path) {
  if (!/\.(?:ts|tsx|mts)$/.test(path)) return false;
  if (
    /\.(?:test|spec|generated)\.|\/__tests__\/|\/test-support\/|\.d\.ts$/.test(
      path,
    )
  ) {
    return false;
  }
  if (/(?:^|\/)(?:node_modules|dist|\.output|\.wxt)\//.test(path)) return false;
  return /^(?:packages\/[^/]+\/src|apps\/[^/]+\/(?:src|entrypoints)|examples\/[^/]+\/src|tools\/[^/]+\/src)\//.test(
    path,
  );
}

/** A Rust file that is production code. */
export function isProductionRust(path) {
  if (!path.endsWith(".rs")) return false;
  if (/(?:^|\/)(?:tests|benches|fuzz)\/|_tests?\.rs$|\/tests\.rs$/.test(path))
    return false;
  return /^(?:crates\/[^/]+|apps\/[^/]+)\/src\//.test(path);
}

const CONSOLE_CALL = /\bconsole\.(?:log|info|warn|error|debug|trace)\(/g;
const RAW_PINO = /(?:^|[^.\w])pino\(/g;
const SUBSCRIBER =
  /tracing_subscriber::fmt\(\)[\s\S]*?\.(?:init|try_init|finish)\(\)/g;

const count = (text, pattern) => (text.match(pattern) ?? []).length;
/** The sanctioned last-resort print of a fatal error: scrubbed, then written. */
const SCRUBBED_ERROR = /\bconsole\.error\(\s*describeError\(/g;

/**
 * What one TypeScript file does that bypasses the shared logger.
 * @returns {{ console: number, pino: number }}
 */
export function typeScriptBypasses(path, text) {
  return {
    console: count(text, CONSOLE_CALL) - count(text, SCRUBBED_ERROR),
    // `packages/observability` is the one place a pino instance is built.
    pino: path.startsWith("packages/observability/")
      ? 0
      : count(text, RAW_PINO),
  };
}

/**
 * A tracing subscriber installed without the scrubbing writer. A test writer is
 * fine: it goes to the test harness, never to a collector or a file.
 * @returns {{ subscriber: number }}
 */
export function rustBypasses(text) {
  const bad = (text.match(SUBSCRIBER) ?? []).filter(
    (statement) => !/ScrubMakeWriter|with_test_writer/.test(statement),
  );
  return { subscriber: bad.length };
}

/**
 * Compare found counts with the ledger. A count above its entry fails, and so
 * does one below it until the ledger is tightened in the same commit.
 *
 * @param {Record<string, Record<string, number>>} found file -> kind -> count
 * @param {Record<string, Record<string, number>>} recorded
 */
export function compareHygiene(found, recorded) {
  const regressions = [];
  const improvements = [];
  const files = new Set([...Object.keys(found), ...Object.keys(recorded)]);
  for (const file of [...files].sort()) {
    const kinds = new Set([
      ...Object.keys(found[file] ?? {}),
      ...Object.keys(recorded[file] ?? {}),
    ]);
    for (const kind of [...kinds].sort()) {
      const now = found[file]?.[kind] ?? 0;
      const allowed = recorded[file]?.[kind] ?? 0;
      if (now > allowed) regressions.push({ file, kind, allowed, now });
      if (now < allowed) improvements.push({ file, kind, allowed, now });
    }
  }
  return { regressions, improvements };
}

/** Found counts with the zeroes dropped, ready to record. */
export function ledgerOf(found) {
  const out = {};
  for (const file of Object.keys(found).sort()) {
    const kinds = Object.fromEntries(
      Object.entries(found[file]).filter(([, n]) => n > 0),
    );
    if (Object.keys(kinds).length > 0) out[file] = kinds;
  }
  return out;
}
