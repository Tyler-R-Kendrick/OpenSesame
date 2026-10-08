/** Non-destructive bounded enqueue. Local evidence is independent of optional delivery. */
import { bytesToB64 } from "@opensesame/vault-core/bytes.js";
import type { CanaryEvent } from "../credential-canaries/records.js";
import { trackRetiredCredentialTelemetry } from "../retired-credentials/telemetry-queue.js";
import {
  type ObservationMetadata,
  type ObservedPasswordEvent,
  normalizeObservation,
} from "./protocol.js";
import { sealObservation } from "./seal.js";
import {
  MAX_OUTBOX_ENTRIES,
  type ReceiverConfig,
  discardExpiredEntries,
  readObservationOutbox,
  readReceiverConfig,
  withObservationLock,
  writeObservationOutbox,
} from "./storage.js";
function dedupSubject(metadata: ObservationMetadata): string {
  const event = metadata.event;
  if (event.type === "retired_credential_observed")
    return JSON.stringify({ type: event.type, trapId: event.trapId });
  return JSON.stringify(event);
}
export async function appendObservation(
  config: ReceiverConfig,
  metadata: ObservationMetadata,
  testing: boolean,
  check: () => void = () => {},
) {
  if (
    (!testing && (!config.enabled || !config.verified)) ||
    Date.parse(config.provision.expiresAt) <= Date.now()
  )
    return null;
  if (metadata.vaultIdentity !== config.vaultIdentity)
    throw new Error("Observation vault context changed.");
  const records = await readObservationOutbox(
    config.tomb,
    config.vaultIdentity,
    check,
  );
  check();
  const now = Date.now();
  discardExpiredEntries(records, config, now);
  const fingerprint = bytesToB64(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(dedupSubject(metadata)),
      ),
    ),
  );
  check();
  if (
    records.history.length >= 8 ||
    records.history.some(
      (h) => h.fingerprint === fingerprint && now - Date.parse(h.at) < 60000,
    ) ||
    records.entries.length >= MAX_OUTBOX_ENTRIES
  )
    return null;
  const packet = await sealObservation(metadata, config.provision, now);
  check();
  records.entries.push({
    revision: config.revision,
    package: packet,
    testing,
    attempts: 0,
    lastAttemptAt: null,
  });
  records.history.push({ fingerprint, at: new Date(now).toISOString() });
  await writeObservationOutbox(records, check);
  check();
  return packet;
}
export async function queueCredentialObservation(
  tomb: string,
  event: CanaryEvent | ObservedPasswordEvent,
): Promise<void> {
  const metadata = normalizeObservation(event);
  const packet = await withObservationLock(tomb, async () => {
    const config = await readReceiverConfig(tomb);
    return config ? appendObservation(config, metadata, false) : null;
  });
  if (packet)
    void trackRetiredCredentialTelemetry(
      import("./delivery.js")
        .then(({ flushObservationOutbox }) => flushObservationOutbox(tomb))
        .then(() => {}),
    );
}
