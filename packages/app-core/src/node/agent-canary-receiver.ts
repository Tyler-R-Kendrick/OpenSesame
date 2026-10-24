/** A paired detection-only receiver. Exported artifacts never carry production credentials. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { importJWK, jwtVerify } from "jose";
import { z } from "zod";
import {
  type ControlledCanaryCommand,
  ControlledCanaryCommandSchema,
  type ControlledCanaryRecord,
  encodeControlledCanaryCommand,
} from "../lib/agent-canaries/controlled-receiver-contract.js";
import {
  controlledCanaryAudience,
  parseCanaryReceiverProfile,
} from "../lib/agent-canaries/receiver-profile-data.js";
import type { ReceiverState } from "./agent-canary-state.js";
const hex = z.string().regex(/^[0-9a-f]{64}$/u);
export const CanaryPairingSchema = z.strictObject({
  v: z.literal(1),
  endpoint: z.string(),
  serviceId: hex,
  bindPort: z.number().int(),
  origin: z.string(),
  ownerKeyId: z.string().min(1).max(200),
  ownerPublicJwk: z.strictObject({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().length(43),
    y: z.string().length(43),
  }),
});
export type CanaryPairing = z.infer<typeof CanaryPairingSchema>;
const signedSchema = z.strictObject({
  nonce: hex,
  idToken: z.string().min(1).max(8192),
});
const freshHex = () => randomBytes(32).toString("hex");
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function secretEqual(left: string, right: string) {
  return (
    left.length === right.length &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}
type ReceiverStorage = {
  state: ReceiverState;
  save: (next: ReceiverState) => Promise<void>;
};
class ControlledCanaryReceiver {
  readonly pairing: CanaryPairing;
  readonly #profile;
  readonly #ownerKey;
  readonly #pending = new Map<
    string,
    { command: ControlledCanaryCommand; audience: string; expiresAt: number }
  >();
  #state: ReceiverState;
  readonly #storage: ReceiverStorage;
  constructor(input: CanaryPairing, storage: ReceiverStorage) {
    this.#storage = storage;
    const pairing = CanaryPairingSchema.parse(input);
    Object.freeze(pairing.ownerPublicJwk);
    this.pairing = Object.freeze(pairing);
    this.#profile = parseCanaryReceiverProfile({
      endpoint: this.pairing.endpoint,
      serviceId: this.pairing.serviceId,
      bindPort: this.pairing.bindPort,
      browserOrigin: this.pairing.origin,
    });
    this.#ownerKey = importJWK(this.pairing.ownerPublicJwk, "ES256");
    this.#state = structuredClone(storage.state);
    if (this.#state.serviceId !== this.pairing.serviceId)
      throw new Error("Foreign receiver state.");
  }
  async ready() {
    await this.#ownerKey;
  }
  async #commit(next: ReceiverState) {
    await this.#storage.save(next);
    this.#state = next;
  }
  async challenge<Input>(value: Input) {
    const now = Date.now();
    for (const [nonce, row] of this.#pending)
      if (row.expiresAt <= now) this.#pending.delete(nonce);
    if (this.#pending.size >= 128) throw new Error("Receiver challenge limit.");
    const command = ControlledCanaryCommandSchema.parse(value);
    const commandHash = digest(encodeControlledCanaryCommand(command));
    const nonce = freshHex();
    const audience = controlledCanaryAudience(this.#profile, commandHash);
    const expiresAt = now + 60000;
    this.#pending.set(nonce, { command, audience, expiresAt });
    return {
      nonce,
      serviceId: this.pairing.serviceId,
      audience,
      commandHash,
      expiresAt,
    };
  }
  async execute<Input>(value: Input) {
    const signed = signedSchema.parse(value);
    const held = this.#pending.get(signed.nonce);
    this.#pending.delete(signed.nonce);
    if (!held || held.expiresAt <= Date.now())
      throw new Error("Expired or replayed receiver challenge.");
    const verified = await jwtVerify(signed.idToken, await this.#ownerKey, {
      algorithms: ["ES256"],
      audience: held.audience,
      subject: this.pairing.ownerKeyId,
      requiredClaims: ["exp", "iat", "nonce"],
    });
    const proof = z
      .object({
        nonce: hex,
        exp: z.number().int().positive(),
        iat: z.number().int().nonnegative(),
      })
      .parse(verified.payload);
    if (
      proof.nonce !== signed.nonce ||
      proof.exp * 1000 > held.expiresAt ||
      proof.iat * 1000 > Date.now() + 1000
    )
      throw new Error("Invalid receiver proof.");
    return this.#manage(held.command);
  }
  async #manage(command: ControlledCanaryCommand) {
    const now = Date.now();
    if (command.kind === "inspect")
      return {
        kind: "inspection",
        records: this.#state.records
          .filter(
            (row) =>
              row.record.contextId === command.contextId &&
              row.record.expiresAt > now,
          )
          .map((row) => row.record),
        events: this.#state.events.filter((event) =>
          this.#state.records.some(
            (row) =>
              row.record.contextId === command.contextId &&
              row.record.id === event.id,
          ),
        ),
      };
    if (command.kind === "enroll") {
      const retained = this.#state.records.filter(
        (row) => row.record.expiresAt > now,
      );
      if (retained.length >= 128) throw new Error("Receiver record limit.");
      const token = freshHex();
      const record: ControlledCanaryRecord = {
        id: freshHex(),
        connectionRef: freshHex(),
        generation: freshHex(),
        contextId: command.contextId,
        label: command.label,
        artifactKind: command.artifactKind,
        createdAt: now,
        expiresAt: now + command.retentionDays * 86400000,
      };
      await this.#commit({
        ...this.#state,
        records: [...retained, { record, token }],
      });
      return { kind: "enrolled", record, token };
    }
    const found = this.#state.records.find(
      (row) =>
        row.record.id === command.id &&
        row.record.contextId === command.contextId &&
        (command.kind === "remove" || row.record.expiresAt > now),
    );
    if (!found) throw new Error("Unknown or expired canary.");
    if (command.kind === "export")
      return { kind: "export", record: found.record };
    await this.#commit({
      ...this.#state,
      records: this.#state.records.filter((row) => row !== found),
    });
    return { kind: "removed", id: command.id };
  }
  async observe(id: string, token: string, invoked: boolean) {
    const found = this.#state.records.find(
      (row) =>
        row.record.id === id &&
        row.record.expiresAt > Date.now() &&
        secretEqual(row.token, token),
    );
    if (!found || this.#state.sequence >= Number.MAX_SAFE_INTEGER)
      throw new Error("Unknown canary artifact.");
    const sequence = this.#state.sequence + 1;
    await this.#commit({
      ...this.#state,
      sequence,
      events: [
        ...this.#state.events,
        {
          id,
          event: invoked
            ? ("canary_tool_invoked" as const)
            : ("canary_connected" as const),
          sequence,
          occurredAt: Date.now(),
        },
      ].slice(-1024),
    });
  }
}
export async function createControlledCanaryReceiver(
  input: CanaryPairing,
  storage: ReceiverStorage,
) {
  const receiver = new ControlledCanaryReceiver(input, storage);
  await receiver.ready();
  return receiver;
}
