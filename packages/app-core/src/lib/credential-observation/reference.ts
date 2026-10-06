/** Controlled receiver reference: authenticated metadata only, idempotent bounded receipts. */
import { bytesToB64 } from "@opensesame/vault-core/bytes.js";
import { z } from "zod";
import {
  type ObservationAcknowledgement,
  type ObservationReceiverProvision,
  ackSchema,
  isoSchema,
  metadataSchema,
  packageBody,
  packageSchema,
  provisionSchema,
} from "./protocol.js";
import { acknowledgeObservation, openObservation } from "./seal.js";
export const referenceStateSchema = z
  .object({
    v: z.literal(1),
    receiverId: z.string().min(1).max(128),
    bindingId: z.string().min(1).max(128),
    keyEpoch: z.number().int().min(0).max(4294967295),
    receipts: z
      .array(
        z
          .object({
            fingerprint: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
            expiresAt: isoSchema,
            acknowledgement: ackSchema,
            metadata: metadataSchema,
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type ObservationReferenceState = z.infer<typeof referenceStateSchema>;
export type ObservationReferenceStorage = {
  read(): Promise<ObservationReferenceState | null>;
  write(state: ObservationReferenceState): Promise<void>;
};
export class ObservationReferenceReceiver {
  readonly #provision: ObservationReceiverProvision;
  #tail: Promise<void> = Promise.resolve();
  constructor(
    provision: ObservationReceiverProvision,
    readonly storage: ObservationReferenceStorage,
  ) {
    this.#provision = provisionSchema.parse(provision);
  }
  async receive(raw: string): Promise<ObservationAcknowledgement> {
    const metadata = await openObservation(raw, this.#provision);
    const packet = packageSchema.parse(JSON.parse(raw));
    const fingerprint = bytesToB64(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`${packageBody(packet)}\n${packet.macB64}`),
        ),
      ),
    );
    const result = this.#tail.then(async () => {
      const state = referenceStateSchema.parse(
        (await this.storage.read()) ?? {
          v: 1,
          receiverId: this.#provision.receiverId,
          bindingId: this.#provision.bindingId,
          keyEpoch: this.#provision.keyEpoch,
          receipts: [],
        },
      );
      if (
        state.receiverId !== this.#provision.receiverId ||
        state.bindingId !== this.#provision.bindingId ||
        state.keyEpoch !== this.#provision.keyEpoch
      )
        throw new Error("Receiver state binding is invalid.");
      state.receipts = state.receipts.filter(
        (r) => Date.parse(r.expiresAt) > Date.now(),
      );
      const prior = state.receipts.find(
        (r) => r.acknowledgement.packageId === packet.packageId,
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new Error("Conflicting observation package replay.");
        return prior.acknowledgement;
      }
      if (
        state.receipts.length >= 256 ||
        state.receipts.filter(
          (r) =>
            Date.now() - Date.parse(r.acknowledgement.acceptedAt) < 3600000,
        ).length >= 8
      )
        throw new Error("Receiver observation budget exhausted.");
      const acknowledgement = await acknowledgeObservation(
        packet,
        this.#provision,
      );
      state.receipts.push({
        fingerprint,
        expiresAt: packet.expiresAt,
        acknowledgement,
        metadata,
      });
      await this.storage.write(state);
      return acknowledgement;
    });
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
