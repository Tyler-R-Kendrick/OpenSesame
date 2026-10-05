import { describe, expect, it } from "vitest";
import { AtRestUnavailable, SealedKv } from "./store";
import { MemoryStore, useTestDeviceKey } from "./test-support/memory";
import { CURRENT, rig } from "./test-support/rig";
import { RP } from "./test-support/site";
import { RunnerVault } from "./vault";

const CTX = { runId: "run:1", origin: RP };

describe("everything the runner keeps rests sealed (ADR 0149)", () => {
  it("writes only sealed values, and none that holds a credential or an origin", async () => {
    const r = await rig();
    const handle = `candidate:${crypto.randomUUID()}`;
    await r.vault.generate(CTX, handle);
    await r.vault.seal(CTX, handle, r.host);
    await r.settings.markActive("run:1", { origin: RP, tabId: 3 });
    const secrets = [
      CURRENT,
      "host-session-token",
      ...(await r.vault.secrets(CTX)),
    ];
    expect(r.store.rows.size).toBeGreaterThan(4);
    for (const [key, value] of r.store.rows) {
      expect(key.startsWith("runner."), key).toBe(true);
      expect(value.startsWith("osc2."), key).toBe(true);
      for (const secret of secrets) expect(value).not.toContain(secret);
      expect(key).not.toContain("rp.example");
    }
  });

  it("reads nothing that was written in the clear, and removes it", async () => {
    const store = new MemoryStore();
    useTestDeviceKey();
    const kv = new SealedKv(store);
    await store.set("runner.host.token", "clear-token");
    expect(await kv.get("host.token")).toBeNull();
    expect(store.rows.has("runner.host.token")).toBe(false);
  });

  it("a value bound to one name does not open under another", async () => {
    const store = new MemoryStore();
    useTestDeviceKey();
    const kv = new SealedKv(store);
    await kv.set("a", "one");
    const sealed = store.rows.get("runner.a");
    if (sealed === undefined) throw new Error("not written");
    store.rows.set("runner.b", sealed);
    expect(await kv.get("a")).toBe("one");
    expect(await kv.get("b")).toBeNull();
  });

  it("with no key to seal under, nothing is written", async () => {
    const store = new MemoryStore();
    const kv = new SealedKv(store, {
      seal: async () => null,
      open: async () => null,
    });
    await expect(kv.set("host.token", "t")).rejects.toThrow(AtRestUnavailable);
    expect(store.rows.size).toBe(0);
    const vault = new RunnerVault(kv);
    await expect(
      vault.putEntry({ origin: RP, username: "u", password: "p" }),
    ).rejects.toThrow("at_rest_unavailable");
    expect(store.rows.size).toBe(0);
  });
});

describe("the vault's entries", () => {
  it("keeps the previous password beside a new one, and names only origins", async () => {
    const r = await rig();
    await r.vault.putEntry({
      origin: RP,
      username: "ada",
      password: "second-pass",
    });
    const entry = await r.vault.getEntry(RP);
    expect(entry).toMatchObject({ password: "second-pass", previous: CURRENT });
    expect(await r.vault.origins()).toEqual([RP]);
    await r.vault.removeEntry(RP);
    expect(await r.vault.getEntry(RP)).toBeNull();
    expect(await r.vault.origins()).toEqual([]);
  });

  it("keeps the rollback credential when the same password is saved again", async () => {
    const r = await rig();
    const save = (password: string) =>
      r.vault.putEntry({ origin: RP, username: "ada", password });
    await save("second-pass");
    await save("second-pass");
    expect(await r.vault.getEntry(RP)).toMatchObject({
      password: "second-pass",
      previous: CURRENT,
    });
    // A real change still replaces it: the rollback is one step back.
    await save("third-pass");
    expect(await r.vault.getEntry(RP)).toMatchObject({
      password: "third-pass",
      previous: "second-pass",
    });
  });

  it("does not return an entry stored for a different origin's name", async () => {
    const r = await rig();
    expect(await r.vault.getEntry("https://other.example")).toBeNull();
  });

  it("refuses to hold a candidate for a recipient that is not a usable public key", async () => {
    const r = await rig({ recovery: false });
    for (const jwk of [
      {},
      { kty: "oct", k: "AAAA" },
      { kty: "RSA", n: "AQAB", e: "AQAB" },
      { kty: "RSA", n: "x", e: "AQAB", d: "private" },
    ]) {
      expect(await r.vault.setRecipient(jwk)).toBeNull();
    }
    expect(await r.vault.recipient()).toBeNull();
  });
});

describe("candidates", () => {
  it("are generated strong, per run, and listed without their value", async () => {
    const r = await rig();
    const handle = `candidate:${crypto.randomUUID()}`;
    expect(await r.vault.generate(CTX, handle)).toBe(true);
    const value = await r.vault.resolve(handle, CTX);
    expect(value).toMatch(/^[\x21-\x7e]{28}$/);
    expect(value).toMatch(/[a-z]/);
    expect(value).toMatch(/[A-Z]/);
    expect(value).toMatch(/[0-9]/);
    expect(value).toMatch(/[^a-zA-Z0-9]/);
    expect(
      await r.vault.resolve(handle, { ...CTX, runId: "run:2" }),
    ).toBeNull();
    expect(
      await r.vault.resolve(handle, { ...CTX, origin: "https://o.example" }),
    ).toBeNull();
    const listed = JSON.stringify(await r.vault.candidates());
    expect(listed).not.toContain(value ?? "?");
    expect(listed).toContain(handle);
  });

  it("are not promoted until their backup was proven, and promotion is idempotent", async () => {
    const r = await rig();
    const handle = `candidate:${crypto.randomUUID()}`;
    await r.vault.generate(CTX, handle);
    expect(await r.vault.promote(CTX, handle)).toBe(false);
    expect(await r.vault.seal(CTX, handle, r.host)).toBe(true);
    expect(await r.vault.seal(CTX, handle, r.host)).toBe(true);
    expect(await r.vault.promote(CTX, handle)).toBe(true);
    const first = await r.vault.getEntry(RP);
    expect(await r.vault.promote(CTX, handle)).toBe(true);
    expect((await r.vault.getEntry(RP))?.previous).toBe(first?.previous);
    expect(first?.password).toBe(await r.vault.resolve(handle, CTX));
  });

  it("are not sealed without a recipient or a store, nor for another run", async () => {
    const r = await rig({ recovery: false });
    const handle = `candidate:${crypto.randomUUID()}`;
    await r.vault.generate(CTX, handle);
    expect(await r.vault.seal(CTX, handle, r.host)).toBe(false);
    const s = await rig();
    await s.vault.generate(CTX, handle);
    expect(await s.vault.seal(CTX, handle, null)).toBe(false);
    expect(await s.vault.seal({ ...CTX, runId: "run:2" }, handle, s.host)).toBe(
      false,
    );
  });

  it("keep only the newest few promoted, and never forget one that is not", async () => {
    const r = await rig();
    const kept: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const handle = `candidate:${crypto.randomUUID()}`;
      await r.vault.generate(CTX, handle);
      await r.vault.seal(CTX, handle, r.host);
      await r.vault.promote(CTX, handle);
      kept.push(handle);
    }
    const loose = `candidate:${crypto.randomUUID()}`;
    await r.vault.generate(CTX, loose);
    const held = await r.vault.candidates();
    expect(held.filter((c) => c.state === "promoted")).toHaveLength(8);
    expect(held.map((c) => c.handle)).toContain(loose);
  });
});
