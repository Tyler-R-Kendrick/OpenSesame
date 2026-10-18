/** Effects run only inside Store's private fresh primary/factor operation and retained leases. */
import type { JsonObject } from "@opensesame/os-domain";
import type {
  LocalCanaryCommand,
  LocalCanaryResult,
} from "@opensesame/vault-core/local-vault-security.js";
import { disposeOriginalCommandData } from "../vault/original-command-retirement-data.js";
import type { RetiredOwnerAuthenticatedData } from "../vault/retired-owner-operation.js";
import {
  type CanaryOwnerCustody,
  canaryDigest,
  openCanaryOwnerCustody,
} from "./canary-owner-effects-custody.js";
import { executeCanaryOwnerCommand } from "./canary-owner-effects-transport.js";
import {
  type ControlledCanaryCommand,
  ControlledCanaryCommandSchema,
  type ControlledCanaryResult,
} from "./controlled-receiver-contract.js";
import { captureOriginalCanaryIndexedSealData } from "./original-indexed-seal-data.js";
import { copyCanaryReceiverProfile } from "./receiver-profile-data.js";
function configuration(
  held: CanaryOwnerCustody,
  id: string,
  serviceId: string,
): JsonObject {
  const row = held.records.find(
    (entry) => entry.record.id === id && entry.record.expiresAt > Date.now(),
  );
  if (!row)
    throw new Error(
      "Canary configuration is unavailable in this owner context.",
    );
  const url = `${held.endpoint}/v1/agent-canaries/artifacts/${id}`;
  if (row.record.artifactKind === "mcp-config")
    return {
      mcpServers: {
        [row.record.label]: {
          url,
          headers: { Authorization: `Bearer ${row.token}` },
        },
      },
    };
  return {
    kind: "canary-connection-reference",
    serviceId,
    connectionRef: row.record.connectionRef,
    url,
    token: row.token,
  };
}
function projectEnrollment(
  result: Extract<ControlledCanaryResult, { kind: "enrolled" }>,
  held: CanaryOwnerCustody,
  command: Extract<ControlledCanaryCommand, { kind: "enroll" }>,
): LocalCanaryResult {
  const record = result.record;
  const now = Date.now();
  if (
    record.contextId !== command.contextId ||
    record.label !== command.label ||
    record.artifactKind !== command.artifactKind ||
    held.records.some((row) => row.record.id === record.id) ||
    record.createdAt > now ||
    record.createdAt < now - 60000 ||
    record.expiresAt <= now ||
    record.expiresAt - record.createdAt !== command.retentionDays * 86400000
  )
    throw new Error(
      "Canary enrollment differs from the accepted retention and context.",
    );
  return { kind: "enrolled", record };
}
function projectResult(
  result: ControlledCanaryResult,
  held: CanaryOwnerCustody,
  command: ControlledCanaryCommand,
  serviceId: string,
): LocalCanaryResult {
  if (result.kind === "enrolled" && command.kind === "enroll")
    return projectEnrollment(result, held, command);
  if (
    result.kind === "removed" &&
    command.kind === "remove" &&
    result.id === command.id
  )
    return result;
  if (
    result.kind === "export" &&
    command.kind === "export" &&
    result.record.id === command.id &&
    result.record.contextId === command.contextId &&
    held.records.some(
      (row) => JSON.stringify(row.record) === JSON.stringify(result.record),
    )
  )
    return {
      kind: "configuration",
      id: command.id,
      configuration: configuration(held, command.id, serviceId),
    };
  return projectInspection(result, held, command);
}
function projectInspection(
  result: ControlledCanaryResult,
  held: CanaryOwnerCustody,
  command: ControlledCanaryCommand,
): LocalCanaryResult {
  if (result.kind === "inspection" && command.kind === "inspect") {
    if (
      result.records.some(
        (row) =>
          row.contextId !== command.contextId ||
          !held.records.some(
            (local) => JSON.stringify(local.record) === JSON.stringify(row),
          ),
      ) ||
      result.events.some(
        (event) => !held.records.some((row) => row.record.id === event.id),
      )
    )
      throw new Error("Foreign canary inspection.");
    const active = new Set(result.records.map((row) => row.id));
    return {
      ...result,
      inactiveIds: held.records
        .filter((row) => !active.has(row.record.id))
        .map((row) => row.record.id),
    };
  }
  throw new Error(
    "Canary receiver result does not match the accepted command.",
  );
}
export async function runCanaryOwnerEffects(
  data: RetiredOwnerAuthenticatedData,
  input: LocalCanaryCommand,
  signal: AbortSignal,
): Promise<LocalCanaryResult> {
  const profile = copyCanaryReceiverProfile(input.receiver);
  const check = () => {
    data.check();
    if (signal.aborted) throw new Error("Canary owner operation retired.");
  };
  check();
  const action = { ...input.action };
  if (action.kind === "enroll" && action.ownerConsent !== true)
    throw new Error("Canary enrollment requires owner consent.");
  const seal = captureOriginalCanaryIndexedSealData(check);
  let failure: ErrorOptions | undefined;
  try {
    const custody = await openCanaryOwnerCustody(
      data,
      profile,
      seal,
      action.kind === "pairing",
    );
    check();
    const held = custody.held;
    if (action.kind === "pairing") {
      await custody.publish(held);
      check();
      return {
        kind: "pairing",
        pairing: {
          v: 1,
          endpoint: profile.endpoint,
          serviceId: profile.serviceId,
          bindPort: profile.bindPort,
          origin: profile.browserOrigin,
          ownerKeyId: held.keyId,
          ownerPublicJwk: held.publicJwk,
        },
      };
    }
    const contextId = await canaryDigest(data.contextWire);
    const { ownerConsent: _, ...enrollment } =
      action.kind === "enroll"
        ? action
        : { ownerConsent: undefined, ...action };
    const command = ControlledCanaryCommandSchema.parse({
      ...enrollment,
      contextId,
    });
    const result = await executeCanaryOwnerCommand(
      profile,
      held,
      command,
      check,
      signal,
    );
    const projected = projectResult(result, held, command, profile.serviceId);
    if (result.kind === "enrolled")
      await custody.publish({
        ...held,
        records: [
          ...held.records.filter((row) => row.record.expiresAt > Date.now()),
          { record: result.record, token: result.token },
        ],
      });
    if (result.kind === "removed")
      await custody.publish({
        ...held,
        records: held.records.filter((row) => row.record.id !== result.id),
      });
    check();
    return projected;
  } catch (cause) {
    failure = { cause };
    throw cause;
  } finally {
    await disposeOriginalCommandData(
      failure,
      data.resources.recordDrainFailure,
      [seal.close],
    );
  }
}
