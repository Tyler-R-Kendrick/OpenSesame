import {
  type ObservationReceiverProvision,
  ackSchema,
  metadataSchema,
  packageSchema,
  parseObservationReceiverProvision,
} from "@opensesame/app-core/lib/credential-observation/protocol.js";
import {
  closedKeys,
  closedMetadata,
  invariant,
  parsed,
} from "./security-protocol/oracles.js";

export function fuzz(data: Buffer): void {
  const mode = (data[0] ?? 0) % 4;
  const raw = data.subarray(1, 8194).toString("utf8");
  if (mode === 0) {
    const accepted = parsed(() => parseObservationReceiverProvision(raw));
    if (!accepted) return;
    assertProvisionInvariant(accepted.value, raw);
  } else if (mode === 1) {
    const accepted = parsed(() => metadataSchema.parse(JSON.parse(raw)));
    if (accepted) closedMetadata(accepted.value);
  } else if (mode === 2) {
    const accepted = parsed(() => packageSchema.parse(JSON.parse(raw)));
    if (accepted)
      closedKeys(accepted.value, [
        "v",
        "packageId",
        "receiverId",
        "bindingId",
        "keyEpoch",
        "issuedAt",
        "expiresAt",
        "nonceB64",
        "ciphertextB64",
        "macB64",
      ]);
    // Schema acceptance deliberately makes no authentication/delivery claim.
  } else {
    const accepted = parsed(() => ackSchema.parse(JSON.parse(raw)));
    if (accepted)
      closedKeys(accepted.value, [
        "v",
        "packageId",
        "bindingId",
        "keyEpoch",
        "acceptedAt",
        "macB64",
      ]);
  }
}

function assertProvisionInvariant(
  p: ObservationReceiverProvision,
  raw: string,
): void {
  const url = new URL(p.origin);
  invariant(Buffer.byteLength(raw, "utf8") <= 8192, "provision resource bound");
  invariant(
    url.origin === p.origin &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "non-origin receiver destination",
  );
  invariant(
    url.protocol === "https:" ||
      (p.allowLoopback &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
    "unapproved cleartext receiver",
  );
  const bytes = Buffer.from(p.independentKeyMaterialB64, "base64");
  invariant(
    bytes.length === 64 &&
      bytes.toString("base64") === p.independentKeyMaterialB64,
    "independent key encoding",
  );
  bytes.fill(0);
}
