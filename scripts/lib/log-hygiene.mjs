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

const TS_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TS_DECLARATION = /\.d\.[mc]?ts$/;
const NOT_PRODUCTION =
  /\.(?:test|spec|generated)\.|\/(?:__tests__|__mocks__|tests?|test-support|fixtures?)\//;
const TS_ROOTS =
  /^(?:packages\/[^/]+\/(?:src|bin)|apps\/[^/]+\/(?:src|entrypoints|server)|examples\/[^/]+\/src|tools\/[^/]+\/src)\//;

/**
 * A TypeScript or JavaScript file that is production code, not a test, a
 * fixture or a generated file.
 */
export function isProductionTypeScript(path) {
  if (!TS_EXT.test(path) || TS_DECLARATION.test(path)) return false;
  if (NOT_PRODUCTION.test(path)) return false;
  if (/(?:^|\/)(?:node_modules|dist|\.output|\.wxt)\//.test(path)) return false;
  return TS_ROOTS.test(path);
}

/** A Rust file that is production code. */
export function isProductionRust(path) {
  if (!path.endsWith(".rs")) return false;
  if (/(?:^|\/)(?:tests|benches|fuzz)\/|_tests?\.rs$|\/tests\.rs$/.test(path))
    return false;
  return /^(?:crates\/[^/]+|apps\/[^/]+)\/src\//.test(path);
}

const count = (text, pattern) => (text.match(pattern) ?? []).length;

/* ------------------------------------------------------------ TypeScript */

/** Skip a `//` or block comment at the cursor; true when one was skipped. */
function skipComment(cursor) {
  const { text } = cursor;
  if (text[cursor.i] !== "/") return false;
  if (text[cursor.i + 1] === "/") {
    const end = text.indexOf("\n", cursor.i);
    cursor.i = end < 0 ? text.length : end;
    return true;
  }
  if (text[cursor.i + 1] !== "*") return false;
  const close = text.indexOf("*/", cursor.i + 2);
  cursor.i = close < 0 ? text.length : close + 2;
  cursor.out.push(" ");
  return true;
}

function copyQuoted(cursor, quote) {
  const { text, out } = cursor;
  out.push(quote);
  cursor.i += 1;
  while (cursor.i < text.length && ![quote, "\n"].includes(text[cursor.i])) {
    if (text[cursor.i] === "\\") out.push(text[cursor.i++]);
    out.push(text[cursor.i++] ?? "");
  }
  if (text[cursor.i] === quote) {
    out.push(quote);
    cursor.i += 1;
  }
}

function copyTemplate(cursor) {
  const { text, out } = cursor;
  out.push("`");
  cursor.i += 1;
  while (cursor.i < text.length && text[cursor.i] !== "`") {
    if (text[cursor.i] === "\\") out.push(text[cursor.i++]);
    if (text[cursor.i] === "$" && text[cursor.i + 1] === "{") {
      out.push("${");
      cursor.i += 2;
      copyCode(cursor, true);
    } else {
      out.push(text[cursor.i++] ?? "");
    }
  }
  if (cursor.i < text.length) {
    out.push("`");
    cursor.i += 1;
  }
}

/** Copy code, dropping comments; stops after the `}` that closes a `${`. */
function copyCode(cursor, untilBrace) {
  const { text, out } = cursor;
  let depth = 0;
  while (cursor.i < text.length) {
    if (skipComment(cursor)) continue;
    const c = text[cursor.i];
    if (c === '"' || c === "'") copyQuoted(cursor, c);
    else if (c === "`") copyTemplate(cursor);
    else if (c === "\\") {
      out.push(text.slice(cursor.i, cursor.i + 2));
      cursor.i += 2;
    } else {
      const closes = c === "}" && depth === 0 && untilBrace;
      depth += (c === "{") - (c === "}");
      out.push(c);
      cursor.i += 1;
      if (closes) return;
    }
  }
}

/**
 * The text with every comment removed. Strings and template literals are kept
 * (a call inside `${}` is code), and a backslash escapes the next character so
 * a regex such as `/\/*\/` does not open a block comment.
 */
export function stripTypeScriptComments(text) {
  const cursor = { text, i: 0, out: [] };
  copyCode(cursor, false);
  return cursor.out.join("");
}

const CONSOLE_METHODS =
  "log|info|warn|error|debug|trace|table|dir|dirxml|group|groupCollapsed|groupEnd|time|timeEnd|timeLog|timeStamp|count|countReset|assert|profile|profileEnd|clear";
/** `console.x`, as a call or passed as a value (`.catch(console.error)`). */
const CONSOLE_MEMBER = new RegExp(
  `(?<![\\w$])console\\s*\\??\\.\\s*(?:${CONSOLE_METHODS})\\b`,
  "g",
);
/** `console['log']` and `console[level]`. */
const CONSOLE_COMPUTED = /(?<![\w$])console\s*(?:\?\.)?\s*\[/g;
/** `const { log } = console`, `const out = console` and `logger = console`. */
const CONSOLE_ALIAS = /[=(,]\s*(?:globalThis\.)?console\s*(?=[;,)\n])/g;
/** The sanctioned last-resort print of a fatal error: scrubbed, then written. */
const SCRUBBED_ERROR = /\bconsole\.error\(\s*describeError\(/g;
/** A direct write to a standard stream, which no scrubber sees. */
const STDIO =
  /(?<![\w$])process\s*\.\s*(?:stderr|stdout)\s*(?:\.\s*write\b|\[\s*['"`]write['"`]\s*\])|(?<![\w$.])(?:fs\.)?writeSync\(\s*[12]\s*,/g;
const PINO_MODULE = String.raw`["'](?:node:)?pino(?:-http)?["']`;
const BOUND = String.raw`[\w$]+`;

/** Local names a `pino` (or `pino-http`) import or require is bound to. */
function pinoAliases(text) {
  const names = new Set(["pino"]);
  const imports = new RegExp(
    String.raw`import\s+(?!type\b)([^;]*?)\s+from\s+${PINO_MODULE}`,
    "g",
  );
  for (const [, clause] of text.matchAll(imports)) {
    const star = clause.match(new RegExp(String.raw`\*\s+as\s+(${BOUND})`));
    if (star) names.add(star[1]);
    const dflt = clause.match(new RegExp(String.raw`^(${BOUND})\s*(?:,|$)`));
    if (dflt) names.add(dflt[1]);
    const named = new RegExp(
      String.raw`(?:^|[{,])\s*(?:default|pino|pinoHttp)\s+as\s+(${BOUND})`,
      "g",
    );
    for (const [, local] of clause.matchAll(named)) names.add(local);
  }
  const bound = new RegExp(
    String.raw`(?:const|let|var)\s+(?:(${BOUND})|\{[^}]*?(?:default|pino)\s*:\s*(${BOUND})[^}]*\})\s*=\s*(?:\(?\s*await\s+)?(?:require|import)\(\s*${PINO_MODULE}\s*\)`,
    "g",
  );
  for (const m of text.matchAll(bound)) names.add(m[1] ?? m[2]);
  return names;
}

/** A call of `pino`, of a name it is bound to, or of its `.default`/`.pino`. */
function pinoBypasses(text) {
  const direct = String.raw`(?:require|import)\(\s*${PINO_MODULE}\s*\)\)?`;
  const call = String.raw`\s*(?:\.\s*(?:default|pino)\s*)?\(`;
  let found = count(text, new RegExp(direct + call, "g"));
  for (const name of pinoAliases(text)) {
    const id = name.replaceAll("$", String.raw`\$`);
    found += count(text, new RegExp(String.raw`(?<![\w$.])${id}${call}`, "g"));
  }
  return found;
}

/**
 * What one TypeScript or JavaScript file does that bypasses the shared logger.
 * @returns {{ console: number, pino: number, stdio: number }}
 */
export function typeScriptBypasses(path, source) {
  const text = stripTypeScriptComments(source);
  const console =
    count(text, CONSOLE_MEMBER) +
    count(text, CONSOLE_COMPUTED) +
    count(text, CONSOLE_ALIAS) -
    count(text, SCRUBBED_ERROR);
  return {
    console,
    // `packages/observability` is the one place a pino instance is built.
    pino: path.startsWith("packages/observability/") ? 0 : pinoBypasses(text),
    stdio: count(text, STDIO),
  };
}

/* ------------------------------------------------------------------ Rust */

/** Skip a `//` or nested block comment at `i`; the index after it, else `i`. */
function afterRustComment(text, i) {
  if (text[i] !== "/") return i;
  if (text[i + 1] === "/") {
    const end = text.indexOf("\n", i);
    return end < 0 ? text.length : end;
  }
  if (text[i + 1] !== "*") return i;
  let depth = 1;
  let at = i + 2;
  while (at < text.length && depth > 0) {
    const open = text.startsWith("/*", at);
    const close = text.startsWith("*/", at);
    depth += Number(open) - Number(close);
    at += open || close ? 2 : 1;
  }
  return at;
}

/** Skip a string literal (plain or raw) at `i`; the index after it, else `i`. */
function afterRustString(text, i) {
  const rawOpen = /b?r(#*)"/y;
  rawOpen.lastIndex = i;
  const raw = /\w/.test(text[i - 1] ?? "") ? null : rawOpen.exec(text);
  if (raw) {
    const close = text.indexOf(`"${raw[1]}`, rawOpen.lastIndex);
    return close < 0 ? text.length : close + 1 + raw[1].length;
  }
  if (text[i] !== '"') return i;
  let at = i + 1;
  while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
  return at + 1;
}

/**
 * The text with comments removed and every string literal emptied, so a word
 * in a comment or a string can neither start nor exempt a subscriber.
 */
export function stripRustNoise(text) {
  const out = [];
  const charLiteral = /'(?:\\[^']+|[^\\'])'/y;
  let i = 0;
  while (i < text.length) {
    const afterComment = afterRustComment(text, i);
    if (afterComment !== i) {
      if (text[i + 1] === "*") out.push(" ");
      i = afterComment;
      continue;
    }
    const afterString = afterRustString(text, i);
    if (afterString !== i) {
      out.push('""');
      i = afterString;
      continue;
    }
    charLiteral.lastIndex = i;
    if (text[i] === "'" && charLiteral.test(text)) {
      out.push("' '");
      i = charLiteral.lastIndex;
      continue;
    }
    out.push(text[i]);
    i += 1;
  }
  return out.join("");
}

/** The index just past the bracket that closes the one at `open`, or -1. */
function closingBracket(text, open) {
  const pairs = { "(": ")", "<": ">", "[": "]", "{": "}" };
  const stack = [];
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack.at(-1)) stack.pop();
    if (stack.length === 0) return i + 1;
  }
  return -1;
}

/** The `.method(args)` calls that directly follow `from`. */
function methodChain(text, from) {
  const calls = [];
  const name = /\s*\.\s*([A-Za-z_]\w*)/y;
  const turbofish = /\s*::\s*(?=<)/y;
  const paren = /\s*(?=\()/y;
  let i = from;
  for (;;) {
    name.lastIndex = i;
    const m = name.exec(text);
    if (!m) return calls;
    i = name.lastIndex;
    turbofish.lastIndex = i;
    if (turbofish.test(text)) {
      i = closingBracket(text, turbofish.lastIndex);
      if (i < 0) return calls;
    }
    paren.lastIndex = i;
    if (!paren.test(text)) return calls;
    const end = closingBracket(text, paren.lastIndex);
    if (end < 0) return calls;
    calls.push({ name: m[1], args: text.slice(paren.lastIndex + 1, end - 1) });
    i = end;
  }
}

const WRITER_SETTERS = new Set(["with_writer", "map_writer"]);

/** Whether the writer a chain ends up with is the scrubbing one (or a test's). */
function writesThroughScrubber(calls, code) {
  const last = calls
    .filter((c) => WRITER_SETTERS.has(c.name) || c.name === "with_test_writer")
    .at(-1);
  if (!last) return false;
  if (last.name === "with_test_writer") return true;
  if (/\bScrubMakeWriter\b/.test(last.args)) return true;
  const ident = last.args.trim();
  return (
    /^[A-Za-z_]\w*$/.test(ident) &&
    new RegExp(
      String.raw`\blet\s+(?:mut\s+)?${ident}\b[^;]*\bScrubMakeWriter\b`,
    ).test(code)
  );
}

/** `fmt::init()` / `fmt::try_init()`: installed with no writer to choose. */
const FMT_INIT = /(?<![\w.])(?:\w+::)*fmt::(?:try_)?init\s*\(\s*\)/g;
/** The ways a formatting subscriber builder or layer is started. */
const FMT_STARTS = [
  /(?<![\w.])(?:\w+::)*fmt\s*\(\s*\)/g,
  /(?<![\w.])(?:\w+::)*(?:FmtSubscriber::builder|fmt::Subscriber::builder|(?:fmt::)?SubscriberBuilder::default|Subscriber::builder)\s*\(\s*\)/g,
  /(?<![\w.])(?:\w+::)*fmt::layer\s*\(\s*\)/g,
  /(?<![\w.])(?:\w+::)*fmt::Layer::(?:new|default)\s*\(\s*\)/g,
];

/**
 * A tracing subscriber or fmt layer built without the scrubbing writer. A test
 * writer is fine: it goes to the test harness, never to a collector or a file.
 * Comments and string literals are removed first, and the writer that counts is
 * the last one the builder chain sets.
 * @returns {{ subscriber: number }}
 */
export function rustBypasses(text) {
  if (!text.includes("tracing_subscriber")) return { subscriber: 0 };
  const code = stripRustNoise(text);
  let bad = count(code, FMT_INIT);
  for (const start of FMT_STARTS) {
    for (const m of code.matchAll(start)) {
      if (/\bfn\s+$/.test(code.slice(0, m.index))) continue;
      const calls = methodChain(code, m.index + m[0].length);
      if (!writesThroughScrubber(calls, code)) bad += 1;
    }
  }
  return { subscriber: bad };
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
