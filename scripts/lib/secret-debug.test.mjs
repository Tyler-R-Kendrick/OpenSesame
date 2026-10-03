import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isScannedRust, mask, secretDebugDerives } from "./secret-debug.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hits = (text) =>
  secretDebugDerives(text).map((h) => `${h.type}.${h.field}`);

describe("which files are scanned", () => {
  it("covers product source and skips tests, benches and fuzz targets", () => {
    expect(isScannedRust("crates/gateway/src/routes/a.rs")).toBe(true);
    expect(isScannedRust("apps/cli/src/main.rs")).toBe(true);
    expect(isScannedRust("crates/gateway/tests/a.rs")).toBe(false);
    expect(isScannedRust("crates/gateway/src/routes/a_tests.rs")).toBe(false);
    expect(isScannedRust("crates/gateway/src/tests.rs")).toBe(false);
    expect(isScannedRust("packages/cli/src/a.ts")).toBe(false);
  });
});

describe("a derived Debug over a secret field", () => {
  it("is flagged by field name, whatever else the derive lists", () => {
    for (const field of [
      "secret",
      "token",
      "password",
      "passphrase",
      "private_key",
      "api_key",
      "shared_secret",
      "client_secret",
      "claim_token",
      "derived_token",
      "webhook_secret",
    ]) {
      expect(
        hits(
          `#[derive(Clone, Debug, Deserialize)]\npub struct S {\n  pub ${field}: String,\n}`,
        ),
      ).toEqual([`S.${field}`]);
    }
  });

  it("sees through stacked attributes, doc comments and visibility", () => {
    const text = `
#[derive(Debug)]
#[serde(deny_unknown_fields)]
/// A body.
pub(crate) struct Body {
    /// The value.
    #[serde(default)]
    pub(crate) secret: Option<String>,
}`;
    expect(hits(text)).toEqual(["Body.secret"]);
  });

  it("covers a path-qualified Debug and enum variant fields", () => {
    expect(
      hits("#[derive(std::fmt::Debug)]\nstruct S { token: String }"),
    ).toEqual(["S.token"]);
    expect(
      hits("#[derive(Debug)]\nenum E { A { api_key: String }, B }"),
    ).toEqual(["E.api_key"]);
  });

  it("is not flagged when Debug is written by hand or not derived", () => {
    expect(hits("#[derive(Clone)]\nstruct S { secret: String }")).toEqual([]);
    expect(hits("struct S { secret: String }")).toEqual([]);
  });

  it("is not flagged for a field that holds no plaintext", () => {
    const text = `#[derive(Debug)]
struct S {
    fence_token: i64,
    has_secret: bool,
    keyfile: Option<PathBuf>,
    secret: Option<SealedBlob>,
    token: SecretString,
    internal_secret: Option<AuthorityHandle>,
}`;
    expect(hits(text)).toEqual([]);
    // A byte buffer is a credential, even though `u8` is a scalar.
    expect(hits("#[derive(Debug)]\nstruct S { secret: Vec<u8> }")).toEqual([
      "S.secret",
    ]);
  });

  it("ignores names that only contain the word, and comments and strings", () => {
    expect(
      hits(
        "#[derive(Debug)]\nstruct S { token_id: String, secrets_dir: String, tokenizer: u8 }",
      ),
    ).toEqual([]);
    expect(
      hits(
        '// #[derive(Debug)] struct S { secret: String }\nconst X: &str = "#[derive(Debug)] struct S { secret: String }";',
      ),
    ).toEqual([]);
  });

  it("ignores fixtures in an inline test module", () => {
    const text =
      "#[cfg(test)]\nmod tests {\n    #[derive(Debug)]\n    struct F { secret: String }\n}\n#[derive(Debug)]\nstruct P { token: String }";
    expect(hits(text)).toEqual(["P.token"]);
  });

  it("keeps field types with generics and commas from hiding the next field", () => {
    const text =
      "#[derive(Debug)]\nstruct S {\n    map: HashMap<String, Vec<u8>>,\n    password: String,\n}";
    expect(hits(text)).toEqual(["S.password"]);
  });

  it("masks comments and strings but keeps the layout", () => {
    const text = 'a // b\n"c{" /* d\n */ e';
    const masked = mask(text);
    expect(masked).toHaveLength(text.length);
    expect(masked.split("\n").length).toBe(text.split("\n").length);
    expect(masked).not.toMatch(/[bcd]/);
  });
});

describe("the repository", () => {
  it("derives Debug over no struct that holds a secret", () => {
    const allowed = JSON.parse(
      readFileSync(
        resolve(root, "scripts/lib/secret-debug-allowlist.json"),
        "utf8",
      ),
    ).allowed;
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString("utf8")
      .split("\0")
      .filter(isScannedRust);
    const used = new Set();
    const offenders = [];
    for (const path of tracked) {
      for (const hit of secretDebugDerives(
        readFileSync(resolve(root, path), "utf8"),
      )) {
        const key = `${path}:${hit.type}.${hit.field}`;
        if (key in allowed) used.add(key);
        else offenders.push(`${key} (line ${hit.line})`);
      }
    }
    // A derived Debug prints every field. Replace the derive with a hand-written
    // `impl fmt::Debug` that prints `[REDACTED]` for the secret (AGENTS.md, ADR 0157).
    expect(offenders).toEqual([]);
    // An allow-list entry that no longer matches is a stale justification.
    expect(Object.keys(allowed).filter((key) => !used.has(key))).toEqual([]);
  });
});
