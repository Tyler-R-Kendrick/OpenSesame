/** Native Jazzer awaits this target; the random fallback does not discover this directory. */
import {
  openObservation,
  verifyObservationAcknowledgement,
} from "@opensesame/app-core/lib/credential-observation/seal.js";
import {
  metadata,
  packet,
  provision,
  signedAck,
  signedAckBody,
  signedPackage,
} from "./independent-wire.js";
import { closedMetadata, invariant, parsedAsync } from "./oracles.js";

export async function fuzz(data: Buffer): Promise<void> {
  const mode = (data[0] ?? 0) % 7;
  const input = data.subarray(1, 8194);
  const now = Date.now();
  const binding = provision(now);
  if (mode === 0) {
    const accepted = await parsedAsync(() =>
      openObservation(input.toString("utf8"), binding, now),
    );
    if (accepted) closedMetadata(accepted.value);
    return;
  }
  if (mode === 1) {
    const p = await packet(Uint8Array.from(input.subarray(0, 2048)), now);
    const accepted = await parsedAsync(() =>
      openObservation(JSON.stringify(p), binding, now),
    );
    if (accepted) closedMetadata(accepted.value);
    return;
  }
  const p = await packet(
    new TextEncoder().encode(JSON.stringify(metadata(now))),
    now,
  );
  if (mode === 2) {
    const bytes = Buffer.from(p.ciphertextB64, "base64");
    // Genuine outer HMAC, but one changed encrypted bit must fail the inner GCM tag.
    const index = 12 + ((input[0] ?? 0) % (bytes.length - 12));
    bytes[index] = (bytes[index] ?? 0) ^ 1;
    const changed = await signedPackage({
      ...p,
      ciphertextB64: bytes.toString("base64"),
    });
    const accepted = await parsedAsync(() =>
      openObservation(JSON.stringify(changed), binding, now),
    );
    invariant(
      !accepted,
      "modified AEAD ciphertext admitted with a freshly valid outer MAC",
    );
  } else if (mode === 3) {
    const changed = await signedPackage({
      ...p,
      bindingId: `wrong-${p.bindingId}`,
    });
    const accepted = await parsedAsync(() =>
      openObservation(JSON.stringify(changed), binding, now),
    );
    invariant(!accepted, "signed package admitted to wrong receiver binding");
  } else if (mode === 4) {
    await parsedAsync(() =>
      verifyObservationAcknowledgement(input.toString("utf8"), p, binding),
    );
  } else if (mode === 5) {
    const ack = await signedAck(p, now);
    const changed = await signedAckBody({
      ...ack,
      packageId: "213e2c4f-29b4-4dbf-9d0f-7a184b04fd6d",
    });
    const accepted = await parsedAsync(() =>
      verifyObservationAcknowledgement(JSON.stringify(changed), p, binding),
    );
    invariant(!accepted, "genuine MAC acknowledged another package");
  } else {
    // Nonvacuous independent authenticated positive control, reached by fuzzing too.
    const result = await openObservation(JSON.stringify(p), binding, now);
    invariant(
      JSON.stringify(result) === JSON.stringify(metadata(now)),
      "valid independent packet changed metadata",
    );
    await verifyObservationAcknowledgement(
      JSON.stringify(await signedAck(p, now)),
      p,
      binding,
    );
  }
}
