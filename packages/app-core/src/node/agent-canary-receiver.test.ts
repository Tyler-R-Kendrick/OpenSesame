import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  CanaryPairingSchema,
  createControlledCanaryReceiver,
} from "./agent-canary-receiver.js";
import { type ReceiverState, openCanaryState } from "./agent-canary-state.js";
const serviceId = "a".repeat(64);
const contextId = "b".repeat(64);
async function fixture() {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  const pairing = CanaryPairingSchema.parse({
    v: 1,
    endpoint: "http://127.0.0.1:34567",
    serviceId,
    bindPort: 34567,
    origin: "https://vault.example",
    ownerKeyId: "owner-test",
    ownerPublicJwk: jwk,
  });
  let state: ReceiverState = {
    v: 1,
    serviceId,
    records: [],
    events: [],
    sequence: 0,
  };
  const receiver = await createControlledCanaryReceiver(pairing, {
    state,
    save: async (next) => {
      state = structuredClone(next);
    },
  });
  async function sign(
    challenge: Awaited<ReturnType<typeof receiver.challenge>>,
    key = keys.privateKey,
    audience = challenge.audience,
  ) {
    return new SignJWT({ nonce: challenge.nonce })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(pairing.ownerKeyId)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(Math.floor(challenge.expiresAt / 1000))
      .sign(key);
  }
  return { receiver, sign, state: () => state };
}
const enroll = {
  kind: "enroll",
  contextId,
  label: "Detection only",
  artifactKind: "mcp-config",
  retentionDays: 1,
};
describe("paired canary receiver", () => {
  it("authenticates exact commands, records detection and removes artifacts", async () => {
    const f = await fixture();
    const challenge = await f.receiver.challenge(enroll);
    const result = await f.receiver.execute({
      nonce: challenge.nonce,
      idToken: await f.sign(challenge),
    });
    expect(result.kind).toBe("enrolled");
    const row = f.state().records[0];
    expect(row.record.contextId).toBe(contextId);
    await f.receiver.observe(row.record.id, row.token, false);
    await f.receiver.observe(row.record.id, row.token, true);
    expect(f.state().events.map((event) => event.event)).toEqual([
      "canary_connected",
      "canary_tool_invoked",
    ]);
    const remove = await f.receiver.challenge({
      kind: "remove",
      contextId,
      id: row.record.id,
    });
    await f.receiver.execute({
      nonce: remove.nonce,
      idToken: await f.sign(remove),
    });
    await expect(
      f.receiver.observe(row.record.id, row.token, true),
    ).rejects.toThrow();
  });
  it("refuses foreign keys, audience substitution, replay and false tokens", async () => {
    const f = await fixture();
    const foreign = await generateKeyPair("ES256");
    const first = await f.receiver.challenge(enroll);
    await expect(
      f.receiver.execute({
        nonce: first.nonce,
        idToken: await f.sign(first, foreign.privateKey),
      }),
    ).rejects.toThrow();
    const second = await f.receiver.challenge(enroll);
    await expect(
      f.receiver.execute({
        nonce: second.nonce,
        idToken: await f.sign(second, undefined, "https://attacker.example"),
      }),
    ).rejects.toThrow();
    const third = await f.receiver.challenge(enroll);
    const signed = { nonce: third.nonce, idToken: await f.sign(third) };
    await f.receiver.execute(signed);
    await expect(f.receiver.execute(signed)).rejects.toThrow();
    await expect(
      f.receiver.observe(f.state().records[0].record.id, "0".repeat(64), true),
    ).rejects.toThrow();
    expect(f.state().events).toEqual([]);
  });
  it("enforces context scope and bounded enrollment", async () => {
    const f = await fixture();
    await expect(
      f.receiver.challenge({ ...enroll, retentionDays: 91 }),
    ).rejects.toThrow();
    const first = await f.receiver.challenge(enroll);
    await f.receiver.execute({
      nonce: first.nonce,
      idToken: await f.sign(first),
    });
    const other = await f.receiver.challenge({
      kind: "remove",
      contextId: "c".repeat(64),
      id: f.state().records[0].record.id,
    });
    await expect(
      f.receiver.execute({ nonce: other.nonce, idToken: await f.sign(other) }),
    ).rejects.toThrow();
    expect(f.state().records).toHaveLength(1);
  });
  it("refuses expired commands and expired artifact bearers", async () => {
    const f = await fixture();
    const command = await f.receiver.challenge(enroll);
    await f.receiver.execute({
      nonce: command.nonce,
      idToken: await f.sign(command),
    });
    const row = f.state().records[0];
    const pending = await f.receiver.challenge({ kind: "inspect", contextId });
    const signed = await f.sign(pending);
    const clock = vi.spyOn(Date, "now").mockReturnValue(pending.expiresAt + 1);
    try {
      await expect(
        f.receiver.execute({ nonce: pending.nonce, idToken: signed }),
      ).rejects.toThrow("Expired");
      clock.mockReturnValue(row.record.expiresAt);
      await expect(
        f.receiver.observe(row.record.id, row.token, true),
      ).rejects.toThrow();
      expect(f.state().events).toEqual([]);
      const next = await f.receiver.challenge(enroll);
      await f.receiver.execute({
        nonce: next.nonce,
        idToken: await f.sign(next),
      });
      expect(f.state().records).toHaveLength(1);
      expect(f.state().records[0].record.id).not.toBe(row.record.id);
    } finally {
      clock.mockRestore();
    }
  });
  it("persists authenticated state, refuses tampering and concurrent writers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "canary-receiver-"));
    try {
      const storage = await openCanaryState(directory, serviceId);
      await expect(openCanaryState(directory, serviceId)).rejects.toThrow();
      await storage.save({ ...storage.state, sequence: 5 });
      await storage.close();
      const reopened = await openCanaryState(directory, serviceId);
      expect(reopened.state.sequence).toBe(5);
      await reopened.close();
      const path = join(directory, "receiver.sealed");
      const bytes = await readFile(path);
      bytes[bytes.length - 1] ^= 1;
      await writeFile(path, bytes);
      await expect(openCanaryState(directory, serviceId)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
