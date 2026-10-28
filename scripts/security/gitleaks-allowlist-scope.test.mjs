import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = readFileSync(`${root}.gitleaks.toml`, "utf8");
const ignore = readFileSync(`${root}.gitleaksignore`, "utf8");

// Read TOML path arrays without mistaking a `]` in a quoted regex for the
// end of the array. Reject unknown syntax so an edit cannot silently skip it.
function pathPatterns(block) {
  const match = /^\s*paths\s*=\s*\[/m.exec(block);
  if (!match) return [];
  let cursor = match.index + match[0].length;
  const entries = [];
  while (cursor < block.length) {
    while (/\s|,/.test(block[cursor] ?? "")) cursor++;
    if (block[cursor] === "#") {
      const next = block.indexOf("\n", cursor);
      cursor = next < 0 ? block.length : next + 1;
      continue;
    }
    if (block[cursor] === "]") return entries;
    const delimiter = block.startsWith("'''", cursor) ? "'''" : "'";
    assert.equal(block.slice(cursor, cursor + delimiter.length), delimiter,
      "Use literal TOML strings in global path allowlists");
    const start = cursor + delimiter.length;
    const end = block.indexOf(delimiter, start);
    assert.notEqual(end, -1, "Unterminated path allowlist entry");
    entries.push(block.slice(start, end));
    cursor = end + delimiter.length;
  }
  throw new Error("Unterminated path allowlist");
}

function regexFor(pattern) {
  const insensitive = pattern.startsWith("(?i)");
  const source = (insensitive ? pattern.slice(4) : pattern)
    .replaceAll("\\A", "^")
    .replaceAll("\\z", "$");
  return new RegExp(source, insensitive ? "i" : "");
}

test("global path exclusions do not hide secrets in production or vendor source", () => {
  const paths = [
    // Former whole-file exclusions remain covered in both scanning modes.
    "Cargo.lock",
    "crates/bitwarden-server/tests/protocol.rs",
    "crates/human-vault/tests/fixtures/root_protection_shared_vectors.json",
    "crates/provider-bitwarden/tests/fixtures/cloud/sync.json",
    "crates/provider-bitwarden/tests/fixtures/vaultwarden/sync.json",
    "crates/provider-bitwarden/tests/vectors/crypto_vectors.json",
    "packages/app-core/src/lib/age-keys.test.ts",
    "packages/app-core/src/lib/duress/settings/unlock-secret-collision.test.ts",
    "packages/app-core/src/lib/duress/store/store.test.ts",
    "packages/app-core/src/lib/git-auth-modes.test.ts",
    "packages/app-core/src/lib/github-app-secret.test.ts",
    "packages/app-core/src/lib/sops/fixtures/upstream/identities.json",
    "packages/app-core/src/lib/vault/protection/fixtures/shared-vectors.json",
    "packages/control-plane/src/__tests__/oauth2-proxy-live.test.ts",
    "scripts/lib/mtls-manifest.test.mjs",
    "spec/conformance/item-type-cases.json",
    "spec/conformance/vault-drive-protocol.json",
    "tests/fuzz/cargo/Cargo.lock",
    "apps/cli/src/certs.rs",
    "apps/pages/index.html",
    "apps/pages/src/work/probe.ts",
    "apps/pages/src/target/probe.ts",
    "apps/pages/src/.tools/probe.ts",
    "apps/pages/src/.pnpm-store/probe.ts",
    "apps/pages/src/.impeccable/live/sessions/probe.ts",
    "apps/pages/src/.impeccable/live/server.json",
    "apps/pages/src/.deepsec/.env.custom",
    "apps/pages/src/dist-identity-verify/probe.ts",
    "apps/pages/src/dist-secret-backends-verify/probe.ts",
    "apps/pages/src/tests/visual-contract/output/probe.ts",
    "apps/pages/src/modules/activity.log/probe.ts",
    "crates/ceremony/src/capture.rs",
    "crates/connection-broker/src/secret_debug.rs",
    "crates/pki-core/src/bundle.rs",
    "crates/pki-core/src/keys.rs",
    "packages/app-core/src/lib/capabilities/keys.ts",
    "packages/app-core/src/lib/capabilities/trust/accepted-revision.ts",
    "packages/app-core/src/lib/duress/incident/intent-journal.ts",
    "packages/app-core/src/lib/vault/protection/browser-enroll.ts",
    "packages/wallet/src/config.ts",
    "scripts/test/live-turn/third_party/unreviewed/new_module.go",
    "scripts/test/live-turn/third_party/x-crypto/chacha20/vectors_test.go",
    "scripts/test/live-turn/third_party/x-crypto/internal/poly1305/vectors_test.go",
  ];
  const blocks = config.split(/^\[\[allowlists\]\]\s*$/m).slice(1);
  assert.ok(blocks.length > 0, "Expected global allowlists");
  for (const block of blocks) {
    for (const pattern of pathPatterns(block)) {
      const regex = regexFor(pattern);
      for (const path of paths) {
        const parts = path.split("/");
        for (let size = 1; size <= parts.length; size++) {
          const candidate = parts.slice(0, size).join("/");
          assert.equal(regex.test(candidate), false, `${candidate} is excluded by ${pattern}`);
        }
      }
    }
  }
});

test("historical exceptions are bound to an immutable commit and finding", () => {
  const lines = ignore.split("\n").filter((line) => line && !line.startsWith("#"));
  assert.ok(lines.length > 0, "Expected reviewed historical fingerprints");
  assert.equal(new Set(lines).size, lines.length, "Duplicate fingerprints");
  for (const line of lines)
    assert.match(line, /^[a-f0-9]{40}:[^:\n]+:[a-z0-9-]+:[1-9][0-9]*$/);
  assert.ok(!lines.some((line) => line.startsWith(
    "c9862a0e99b1fc7a8bc3169ec8158dd9abaebf01:apps/pages/src/lib/transport-settings.test.ts:github-pat:42",
  )), "An unverified credential-shaped finding must stay visible");
});
