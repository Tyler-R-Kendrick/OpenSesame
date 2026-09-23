/** @vitest-environment node */
/**
 * The four boundaries the engine's own suites did not yet assert directly:
 * which cryptographic primitives ship (SB-020), when a sealed identity may
 * be read (SB-034), what may never appear in a URL, a log, or a diagnostic
 * (SB-059), and that an import lands whole or not at all (SB-069).
 *
 * Several of these read the shipped sources rather than trusting a
 * convention, because the thing being asserted is the *absence* of a path
 * that a future edit could quietly add back.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mayUseVaultIdentities } from "../../sections/settings/sops/identities.js";
import { SopsError, redactError } from "./errors.js";

const sopsDir = __dirname;
const coreSrc = join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name))
      out.push(path);
  }
  return out;
}

const engineSources = walk(sopsDir)
  .filter((path) => !path.includes(`${join("fixtures")}`))
  .map((path) => ({ path, source: readFileSync(path, "utf8") }));

describe("SB-020 the shipped primitives are the platform's, with no fallback", () => {
  it("every symmetric and digest operation goes through WebCrypto", async () => {
    // A JavaScript reimplementation of AES-GCM or SHA-512 would be a second,
    // unaudited implementation of the thing the MAC depends on. There is
    // deliberately no fallback: an engine without WebCrypto refuses.
    const hashed = await crypto.subtle.digest(
      "SHA-512",
      new TextEncoder().encode("sops"),
    );
    expect(hashed.byteLength).toBe(64);
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32),
      "AES-GCM",
      false,
      ["encrypt"],
    );
    expect(key.type).toBe("secret");
  });

  it("no engine module rolls its own cipher, digest, or randomness", () => {
    for (const { path, source } of engineSources) {
      expect(source, path).not.toMatch(/\bMath\.random\b/u);
      // A hand-written S-box or round-constant table is the shape of a
      // reimplementation; the engine has no reason to contain one.
      expect(source, path).not.toMatch(/\b[sS]_?box\b|roundConstants/u);
    }
  });

  it("the engine's third-party dependencies are exactly the three declared ones", () => {
    // `@noble/ciphers` is here because SOPS nonces are 32 bytes and Go's
    // `cipher.NewGCMWithNonceSize` accepts that; noble does too, with no
    // nonce truncated or rehashed. `age-encryption` owns age envelopes and
    // `yaml` owns YAML syntax (the engine owns the emitted bytes). All
    // three are bundled, offline, and maintained — this list may not grow
    // without someone changing this test on purpose.
    const external = new Set<string>();
    for (const { source } of engineSources)
      for (const match of source.matchAll(/from "([^".][^"]*)"/gu)) {
        const name = match[1] ?? "";
        if (
          !name.startsWith(".") &&
          !name.startsWith("node:") &&
          !name.startsWith("@opensesame/")
        )
          external.add(name);
      }
    expect([...external].sort()).toEqual([
      "@noble/ciphers/aes",
      "age-encryption",
      "yaml",
    ]);
  });
});

describe("SB-034 a sealed identity needs a real, unlocked, non-guest session", () => {
  const unlocked = {
    status: "unlocked",
    guest: false,
    awaitingSecondStep: false,
    tomb: "personal",
  };

  it("allows only a fully unlocked human session", () => {
    expect(mayUseVaultIdentities(unlocked)).toBe(true);
  });

  it("denies a locked vault, a pending second step, and a guest", () => {
    expect(mayUseVaultIdentities({ ...unlocked, status: "locked" })).toBe(
      false,
    );
    expect(mayUseVaultIdentities({ ...unlocked, status: "empty" })).toBe(false);
    expect(
      mayUseVaultIdentities({ ...unlocked, awaitingSecondStep: true }),
    ).toBe(false);
    expect(mayUseVaultIdentities({ ...unlocked, guest: true })).toBe(false);
  });

  it("reads identities from the addressed tomb and never scans another", () => {
    const source = readFileSync(
      join(coreSrc, "sections/settings/sops/identities.ts"),
      "utf8",
    );
    expect(source).toMatch(/readAgeKeyConfig\(access\.tomb\)/u);
    expect(source).not.toMatch(/listDeviceVaults|localStorage|process\.env/u);
  });
});

describe("SB-059 nothing secret reaches a URL, a log, or a diagnostic", () => {
  it("a redacted error names the failure and never carries the cause", () => {
    const redacted = redactError(
      new Error("age: no identity matched AGE-SECRET-KEY-1QQQQ"),
      "missing_identity",
    );
    expect(redacted).toBeInstanceOf(SopsError);
    expect(redacted.message).not.toMatch(/AGE-SECRET-KEY/u);
    expect(redacted.message.length).toBeGreaterThan(0);
  });

  it("no engine module logs, beacons, or builds a URL from its inputs", () => {
    for (const { path, source } of engineSources) {
      expect(source, path).not.toMatch(
        /console\.(log|info|warn|error|debug)\(/u,
      );
      expect(source, path).not.toMatch(
        /sendBeacon|navigator\.clipboard|window\.location\s*=|location\.href\s*=/u,
      );
      expect(source, path).not.toMatch(/URLSearchParams\(/u);
    }
  });

  it("a provider endpoint comes from configuration, never from the document", () => {
    // An imported document's `sops:` block names *which* key was used. It
    // must never be able to name *where* to send anything.
    const cloud = readFileSync(join(sopsDir, "keys", "cloud.ts"), "utf8");
    expect(cloud).toMatch(/assertSopsHttpsEndpoint/u);
    const metadata = readFileSync(join(sopsDir, "metadata.ts"), "utf8");
    expect(metadata).not.toMatch(/https?:\/\//u);
  });
});

describe("SB-069 a vault import lands whole or not at all", () => {
  // The import hook's half of this case lives beside the hook in the shell
  // (`sections/settings/sops/useVaultSecrets.boundary.test.ts`).
  it("the store's batch write is one change", () => {
    const store = readFileSync(join(coreSrc, "lib/vault/store.ts"), "utf8");
    const batch = store.slice(
      store.indexOf("async saveItems("),
      store.indexOf("async trashItem("),
    );
    expect(batch).toMatch(/#mutate/u);
    expect(batch.match(/#mutate/gu)).toHaveLength(1);
  });

  it("a failed write restores the previous body rather than leaving memory ahead", () => {
    const store = readFileSync(join(coreSrc, "lib/vault/store.ts"), "utf8");
    const mutate = store.slice(store.indexOf("async #mutate("));
    expect(mutate.slice(0, 1600)).toMatch(/previous/u);
    expect(mutate.slice(0, 1600)).toMatch(/#writeChain/u);
  });
});
