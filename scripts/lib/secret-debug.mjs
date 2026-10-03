/**
 * Secret-holding structs that derive `Debug` (ADR 0155).
 *
 * `#[derive(Debug)]` prints every field, so a struct with a plaintext secret
 * field leaks it into any `{:?}`, `tracing` field or panic message that is
 * handed the struct. AGENTS.md: "A struct holding a secret never derives
 * `Debug`" -- it writes `impl fmt::Debug` by hand and prints `[REDACTED]` for
 * the secret fields.
 *
 * This is the guard that keeps that true. It chose a scanner over an ast-grep
 * rule because tree-sitter-rust makes `#[derive(..)]` a sibling of the struct
 * rather than a parent, so a rule cannot say "a derived struct with a field
 * named X" without a brittle `follows` stop, and `ast-grep` is not a pinned
 * dependency of the workspace (the audit gate fails where it is missing).
 *
 * Pure: it reads text and knows nothing about disk.
 */

/** A Rust file whose structs are production code. */
export function isScannedRust(path) {
  if (!path.endsWith(".rs")) return false;
  if (
    /(?:^|\/)(?:tests|benches|fuzz|examples)\/|_tests?\.rs$|\/tests\.rs$/.test(
      path,
    )
  )
    return false;
  return /^(?:crates\/[^/]+|apps\/[^/]+)\/src\//.test(path);
}

const SECRET_WORDS =
  "secret|token|password|passphrase|private_key|api_key|shared_secret|client_secret|claim_token|recovery_code|password_hash|user_key|keyfile";
/** A field name that holds a credential: the word itself or `<prefix>_<word>`. */
const SECRET_FIELD = new RegExp(`^(?:[a-z0-9_]*_)?(?:${SECRET_WORDS})$`);
/**
 * Field types that hold no plaintext credential: types whose own `Debug`
 * redacts, ciphertext (`SealedBlob`), an opaque handle (`AuthorityHandle`), a
 * file path (`PathBuf`: a `--keyfile` names the key, it is not the key), and
 * scalars (a `fence_token: i64` counter is not a bearer).
 */
const SELF_REDACTING_TYPE =
  /\b(?:Secret\w*|Redacted\w*|Zeroizing|SealedBlob|AuthorityHandle|PathBuf)\b/;
const SCALAR_TYPE = /^(?:Option<)?(?:bool|[iu](?:8|16|32|64|128|size))>?$/;
const holdsNoPlaintext = (type) =>
  SELF_REDACTING_TYPE.test(type) || SCALAR_TYPE.test(type);

/**
 * The lexers `mask` tries at each position. Each returns the span to blank and
 * where scanning resumes, or null when the text there is not its token.
 */
const LEXERS = [
  (text, i) => {
    if (!text.startsWith("//", i)) return null;
    const end = text.indexOf("\n", i);
    const to = end < 0 ? text.length : end;
    return { from: i, to, next: to };
  },
  (text, i) => {
    if (!text.startsWith("/*", i)) return null;
    let depth = 1;
    let j = i + 2;
    while (j < text.length && depth > 0) {
      const open = text.startsWith("/*", j);
      const close = text.startsWith("*/", j);
      depth += open ? 1 : close ? -1 : 0;
      j += open || close ? 2 : 1;
    }
    return { from: i, to: j, next: j };
  },
  (text, i) => {
    const raw = /^r(#*)"/.exec(text.slice(i, i + 40));
    if (!raw) return null;
    const close = `"${raw[1]}`;
    const start = i + 2 + raw[1].length;
    const found = text.indexOf(close, start);
    const next = found < 0 ? text.length : found + close.length;
    return { from: start, to: next - close.length, next };
  },
  (text, i) => {
    if (text[i] !== '"') return null;
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    return { from: i + 1, to: j, next: j + 1 };
  },
  (text, i) => {
    const char = /^'(?:\\.[^']*|[^\\'])'/.exec(text.slice(i, i + 12));
    if (!char) return null;
    return {
      from: i + 1,
      to: i + char[0].length - 1,
      next: i + char[0].length,
    };
  },
];

/** Replace comments and string/char literal contents with spaces, keeping layout. */
export function mask(text) {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    let span = null;
    for (const lex of LEXERS) {
      span = lex(text, i);
      if (span) break;
    }
    if (!span) {
      i += 1;
      continue;
    }
    for (let k = span.from; k < span.to; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
    i = span.next;
  }
  return out.join("");
}

/** Index just past the bracket that closes the one at `open`, or -1. */
function closing(text, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const stack = [];
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** Split a struct/enum body into its top-level comma-separated parts. */
function topLevelParts(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if ("{([<".includes(c)) depth += 1;
    else if ("})]".includes(c)) depth -= 1;
    else if (c === ">" && body[i - 1] !== "-") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

const FIELD =
  /^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:r#)?([A-Za-z_]\w*)\s*:(?!:)([\s\S]*)$/;

/** Named fields (name, type text) of a `{ ... }` body, including enum variants'. */
function namedFields(body, isEnum) {
  const fields = [];
  for (const part of topLevelParts(body)) {
    if (isEnum) {
      const open = part.indexOf("{");
      if (open >= 0) {
        const end = closing(part, open);
        fields.push(...namedFields(part.slice(open + 1, end - 1), false));
      }
      continue;
    }
    const m = FIELD.exec(part);
    if (m) fields.push({ name: m[1], type: m[2].trim() });
  }
  return fields;
}

const DERIVE = /#\[derive\(([^)]*)\)\]/g;
const DERIVES_DEBUG = /(?:^|[\s,:])Debug(?:\s*$|[\s,])/;
const ATTRIBUTE = /^\s*#\[/;
const HEAD = /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum)\s+([A-Za-z_]\w*)/;

/** Spans of inline `#[cfg(test)] mod x { .. }` blocks: fixtures, not product types. */
function testModuleSpans(code) {
  const pattern = /#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+\w+\s*\{/g;
  return [...code.matchAll(pattern)].map((m) => {
    const open = m.index + m[0].length - 1;
    return [open, closing(code, open)];
  });
}

/** Index after any attributes that follow `at`. */
function skipAttributes(code, at) {
  let pos = at;
  for (;;) {
    const attr = ATTRIBUTE.exec(code.slice(pos));
    if (!attr) return pos;
    const end = closing(code, pos + attr[0].length - 1);
    if (end < 0) return pos;
    pos = end;
  }
}

/** The braced struct or enum declared at `at`: its name and named fields. */
function declaration(code, at) {
  const head = HEAD.exec(code.slice(at));
  if (!head) return null;
  const after = at + head[0].length;
  const brace = code.indexOf("{", after);
  const semi = code.indexOf(";", after);
  if (brace < 0 || (semi >= 0 && semi < brace)) return null;
  const end = closing(code, brace);
  if (end < 0) return null;
  return {
    name: head[2],
    fields: namedFields(code.slice(brace + 1, end - 1), head[1] === "enum"),
  };
}

/**
 * Every derived-`Debug` struct or enum in `text` that has a secret-named field.
 * @returns {{ type: string, field: string, line: number }[]}
 */
export function secretDebugDerives(text) {
  const code = mask(text);
  const skipped = testModuleSpans(code);
  const hits = [];
  for (const derive of code.matchAll(DERIVE)) {
    if (!DERIVES_DEBUG.test(derive[1])) continue;
    if (skipped.some(([a, b]) => derive.index > a && derive.index < b))
      continue;
    const decl = declaration(
      code,
      skipAttributes(code, derive.index + derive[0].length),
    );
    if (!decl) continue;
    const line = code.slice(0, derive.index).split("\n").length;
    for (const f of decl.fields) {
      if (SECRET_FIELD.test(f.name) && !holdsNoPlaintext(f.type)) {
        hits.push({ type: decl.name, field: f.name, line });
      }
    }
  }
  return hits;
}
