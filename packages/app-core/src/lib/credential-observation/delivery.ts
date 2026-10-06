import { assertObservationEgress } from "./egress-admission.js";
/** One-purpose sealed dispatch: fixed method/path, no cookies, redirects, bearer or root. */
import {
  OBSERVATION_ROUTE,
  type SealedObservationPackage,
} from "./protocol.js";
import {
  authenticateSealedObservation,
  verifyObservationAcknowledgement,
} from "./seal.js";
import {
  MAX_ATTEMPTS,
  type ReceiverConfig,
  discardExpiredEntries,
  readObservationOutbox,
  readReceiverConfig,
  withObservationLock,
  writeObservationOutbox,
} from "./storage.js";
const active = new Set<string>();
const requests = new Map<string, Set<AbortController>>();
export type ObservationDeliverySummary = {
  delivered: number;
  queued: number;
  failed: number;
};
export function revokeObservationRequests(tomb: string): void {
  for (const controller of requests.get(tomb) ?? []) controller.abort();
}
function allowed(config: ReceiverConfig, testing: boolean): boolean {
  return (
    (testing || (config.enabled && config.verified)) &&
    Date.parse(config.provision.expiresAt) > Date.now()
  );
}
async function boundedAck(response: Response): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Observation receiver rejected delivery.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing observation acknowledgement.");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 2048) {
        await reader.cancel();
        throw new Error("Observation acknowledgement is too large.");
      }
      parts.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    reader.releaseLock();
  }
}
type ReservedDelivery = {
  config: ReceiverConfig;
  packet: SealedObservationPackage;
  attempt: number;
};
async function reserve(
  tomb: string,
  packageId: string | undefined,
  testing: boolean,
): Promise<ReservedDelivery | null> {
  return withObservationLock(tomb, async () => {
    const config = await readReceiverConfig(tomb);
    if (!config || !allowed(config, testing)) return null;
    assertObservationEgress(`${config.provision.origin}${OBSERVATION_ROUTE}`);
    const records = await readObservationOutbox(tomb, config.vaultIdentity);
    discardExpiredEntries(records, config, Date.now());
    const entry = records.entries.find(
      (e) =>
        e.testing === testing &&
        (!packageId || e.package.packageId === packageId) &&
        e.attempts < MAX_ATTEMPTS &&
        (!e.lastAttemptAt || Date.now() - Date.parse(e.lastAttemptAt) >= 5000),
    );
    if (!entry) {
      await writeObservationOutbox(records);
      return null;
    }
    await authenticateSealedObservation(entry.package, config.provision);
    entry.attempts += 1;
    entry.lastAttemptAt = new Date().toISOString();
    await writeObservationOutbox(records);
    return { config, packet: entry.package, attempt: entry.attempts };
  });
}
async function dispatch(
  tomb: string,
  reservation: ReservedDelivery,
  testing: boolean,
  controller: AbortController,
) {
  return withObservationLock(tomb, async () => {
    const current = await readReceiverConfig(tomb);
    if (
      !current ||
      current.revision !== reservation.config.revision ||
      !allowed(current, testing)
    )
      return null;
    const records = await readObservationOutbox(tomb, current.vaultIdentity);
    if (
      !records.entries.some(
        (e) =>
          e.package.packageId === reservation.packet.packageId &&
          e.attempts === reservation.attempt,
      )
    )
      return null;
    const running = requests.get(tomb) ?? new Set<AbortController>();
    running.add(controller);
    requests.set(tomb, running);
    // Start the actual request while binding revocation is excluded; release
    // the lock before awaiting any remote response or its body.
    assertObservationEgress(`${current.provision.origin}${OBSERVATION_ROUTE}`);
    const response = fetch(`${current.provision.origin}${OBSERVATION_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reservation.packet),
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    void response.catch(() => {});
    return { response };
  });
}
export async function deliverObservation(
  tomb: string,
  packageId?: string,
  testing = false,
): Promise<boolean> {
  const reservation = await reserve(tomb, packageId, testing);
  if (!reservation) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  let acknowledged = false;
  try {
    const started = await dispatch(tomb, reservation, testing, controller);
    if (!started) return false;
    await verifyObservationAcknowledgement(
      await boundedAck(await started.response),
      reservation.packet,
      reservation.config.provision,
    );
    acknowledged = true;
  } catch {
    acknowledged = false;
  } finally {
    clearTimeout(timer);
    const running = requests.get(tomb);
    running?.delete(controller);
    if (!running?.size) requests.delete(tomb);
  }
  return withObservationLock(tomb, async () => {
    const current = await readReceiverConfig(tomb);
    if (
      !current ||
      current.revision !== reservation.config.revision ||
      !allowed(current, testing)
    )
      return false;
    const records = await readObservationOutbox(tomb, current.vaultIdentity);
    const entry = records.entries.find(
      (e) => e.package.packageId === reservation.packet.packageId,
    );
    if (!entry || entry.attempts !== reservation.attempt) return false;
    if (acknowledged)
      records.entries = records.entries.filter((e) => e !== entry);
    else records.failed = Math.min(4294967295, records.failed + 1);
    await writeObservationOutbox(records);
    return acknowledged;
  });
}
async function summary(
  tomb: string,
  delivered: number,
): Promise<ObservationDeliverySummary> {
  return withObservationLock(tomb, async () => {
    const config = await readReceiverConfig(tomb);
    if (!config) return { delivered, queued: 0, failed: 0 };
    const records = await readObservationOutbox(tomb, config.vaultIdentity);
    discardExpiredEntries(records, config, Date.now());
    await writeObservationOutbox(records);
    return {
      delivered,
      queued: records.entries.filter(
        (e) => !e.testing && e.attempts < MAX_ATTEMPTS,
      ).length,
      failed: records.failed,
    };
  });
}
export async function flushObservationOutbox(
  tomb: string,
): Promise<ObservationDeliverySummary> {
  if (active.has(tomb) || active.size >= 4) return summary(tomb, 0);
  active.add(tomb);
  let delivered = 0;
  try {
    for (let i = 0; i < 2; i += 1) {
      if (!(await deliverObservation(tomb))) break;
      delivered += 1;
    }
    return await summary(tomb, delivered);
  } finally {
    active.delete(tomb);
  }
}
