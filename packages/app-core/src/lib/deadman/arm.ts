/**
 * Arming, committing, disarming and releasing the deadman switch (ADR 0209).
 *
 * Arming is deliberately two-phase. Preparation seals the chosen items under a
 * fresh release key and shows that key once; nothing is stored or sent. The
 * person must record the key and acknowledge it before the commit registers
 * the signed record with the relay and writes the device-local package.
 */

import type { VaultItem } from "@opensesame/vault-core";
import { canonicalJson, generateSigningPair, signText } from "./crypto.js";
import { withDeadmanTurn } from "./fence.js";
import { DEADMAN_MAX_ITEMS, DEADMAN_MAX_TIMEOUT_DAYS } from "./keys.js";
import {
  type DeadmanPackage,
  openDeadmanPackage,
  readDeadmanPackage,
  sealDeadmanPackage,
  writeDeadmanPackage,
} from "./package.js";
import {
  type DeadmanDisarm,
  DeadmanRelayError,
  type RelayTarget,
  normalizeRelayUrl,
  normalizeWebhookUrl,
  sendArm,
  sendDisarm,
} from "./relay.js";
import {
  type DeadmanConfig,
  type DeadmanState,
  type DeadmanStatus,
  deadmanKeyMatchesState,
  deadmanSeams,
  deleteDeadmanConfig,
  deleteDeadmanLocal,
  loadDeadmanStatus,
  readDeadmanConfig,
  readDeadmanState,
  signDeadmanState,
  verifyDeadmanState,
  writeDeadmanConfig,
  writeDeadmanState,
} from "./state.js";

export type DeadmanPlan = Readonly<{
  v: 1;
  id: string;
  tomb: string;
  state: DeadmanState;
  packageJson: string;
  packageDigest: string;
  itemCount: number;
  privateKeyJwk: JsonWebKey;
  webhookUrl: string;
  relayToken: string;
  releaseKey: string;
}>;

export type PrepareDeadmanInput = Readonly<{
  tomb: string;
  items: readonly VaultItem[];
  itemIds: readonly string[];
  timeoutDays: number;
  relayUrl: string;
  webhookUrl: string;
  relayToken?: string;
}>;

/** The config input, checked: the relay token as it will be sent. */
type CheckedConfig = { relayToken: string };

function validateConfigInput(input: {
  timeoutDays: number;
  relayToken?: string;
}): CheckedConfig {
  if (
    !Number.isSafeInteger(input.timeoutDays) ||
    input.timeoutDays < 1 ||
    input.timeoutDays > DEADMAN_MAX_TIMEOUT_DAYS
  )
    throw new Error(
      `Choose an inactivity window between 1 and ${DEADMAN_MAX_TIMEOUT_DAYS} days.`,
    );
  const relayToken = (input.relayToken ?? "").trim();
  for (const character of relayToken) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f)
      throw new Error("A relay token cannot contain control characters.");
  }
  if (relayToken.length > 4096) throw new Error("The relay token is too long.");
  return { relayToken };
}

function selectedItems(
  items: readonly VaultItem[],
  itemIds: readonly string[],
): VaultItem[] {
  if (itemIds.length === 0 || itemIds.length > DEADMAN_MAX_ITEMS)
    throw new Error(
      `Choose between 1 and ${DEADMAN_MAX_ITEMS} items for the deadman switch.`,
    );
  if (new Set(itemIds).size !== itemIds.length)
    throw new Error("An item was chosen twice.");
  const byId = new Map(items.map((item) => [item.id, item]));
  const real: VaultItem[] = [];
  for (const id of itemIds) {
    const item = byId.get(id);
    if (!item)
      throw new Error("One of the chosen items is no longer in this vault.");
    real.push(item);
  }
  if (real.some((item) => item.deletedAt !== null || item.kind === "drop"))
    throw new Error(
      "Trash, lost, passkeys and one-time drop items cannot be released.",
    );
  return real;
}

function newId(): string {
  return crypto.randomUUID();
}

async function disarmFor(
  state: DeadmanState,
  privateKeyJwk: JsonWebKey,
): Promise<DeadmanDisarm> {
  const unsigned = {
    v: 1 as const,
    type: "opensesame.deadman.disarm" as const,
    id: state.id,
    at: deadmanSeams.now(),
  };
  return {
    ...unsigned,
    signature: await signText(privateKeyJwk, canonicalJson(unsigned)),
  };
}

/** Seal a package and return the one release key that opens it. Stores nothing. */
export async function prepareDeadmanSwitch(
  input: PrepareDeadmanInput,
): Promise<DeadmanPlan> {
  if (input.tomb === "guest")
    throw new Error("A deadman switch is not available in a guest session.");
  if (readDeadmanState(input.tomb))
    throw new Error("Turn off the current deadman switch before replacing it.");
  const { relayToken } = validateConfigInput(input);
  const relayUrl = normalizeRelayUrl(input.relayUrl);
  const webhookUrl = normalizeWebhookUrl(input.webhookUrl);
  const items = selectedItems(input.items, input.itemIds);
  const id = newId();
  const createdAt = new Date(deadmanSeams.now()).toISOString();
  const pair = await generateSigningPair();
  const sealed = await sealDeadmanPackage({
    tomb: input.tomb,
    id,
    createdAt,
    items,
  });
  const base = {
    v: 1 as const,
    id,
    tomb: input.tomb,
    armedAt: createdAt,
    lastAuthenticatedAt: deadmanSeams.now(),
    timeoutDays: input.timeoutDays,
    packageDigest: sealed.package.digest,
    itemCount: sealed.package.itemCount,
    publicKeyJwk: pair.publicKeyJwk,
    relayUrl,
    sequence: 1,
  };
  const state = await signDeadmanState(base, pair.privateKeyJwk);
  return {
    v: 1,
    id,
    tomb: input.tomb,
    state,
    packageJson: sealed.packageJson,
    packageDigest: sealed.package.digest,
    itemCount: sealed.package.itemCount,
    privateKeyJwk: pair.privateKeyJwk,
    webhookUrl,
    relayToken,
    releaseKey: sealed.releaseKey,
  };
}

/**
 * Register the plan with the relay, then commit the sealed private half, the
 * package and the public record. A failed write tells the relay to disarm so a
 * half-armed switch cannot fire for a package this device does not have.
 */
export function commitDeadmanSwitch(plan: DeadmanPlan): Promise<DeadmanState> {
  return withDeadmanTurn(plan.tomb, () => commitDeadmanSwitchNow(plan));
}

async function commitDeadmanSwitchNow(
  plan: DeadmanPlan,
): Promise<DeadmanState> {
  if (readDeadmanState(plan.tomb))
    throw new Error("Turn off the current deadman switch before replacing it.");
  if (!(await verifyDeadmanState(plan.state)))
    throw new Error("The deadman record did not verify before arming.");
  if (
    !(await deadmanKeyMatchesState(plan.privateKeyJwk, plan.state.publicKeyJwk))
  )
    throw new Error(
      "The deadman state key does not match the armed private key.",
    );
  const packageValue = readDeadmanPackage(plan.tomb);
  if (packageValue)
    throw new Error("A deadman package is already stored for this vault.");
  const committed = await signDeadmanState(
    {
      ...plan.state,
      lastAuthenticatedAt: deadmanSeams.now(),
    },
    plan.privateKeyJwk,
  );
  const target: RelayTarget = {
    relayUrl: committed.relayUrl,
    relayToken: plan.relayToken,
  };
  // The local half must exist before the relay can be armed; otherwise a
  // successful registration has no package this device can release. Any
  // failure here means the relay has not been asked yet.
  try {
    const config: DeadmanConfig = {
      v: 1,
      id: plan.id,
      privateKeyJwk: plan.privateKeyJwk,
      relayToken: plan.relayToken,
      webhookUrl: plan.webhookUrl,
    };
    await writeDeadmanConfig(plan.tomb, config);
    await writeDeadmanPackage(plan.tomb, plan.packageJson);
    await writeDeadmanState(plan.tomb, committed);
  } catch (error) {
    await deleteDeadmanLocal(plan.tomb);
    throw error;
  }
  try {
    await sendArm(target, committed, plan.webhookUrl);
    return committed;
  } catch (error) {
    // A response that explicitly refused the arm proves the relay is not
    // armed. A network/abort failure is ambiguous, so ask it to disarm and
    // keep the local half if that cannot be confirmed: a retry can then
    // disarm, whereas deleting it would leave an unreleasable relay record.
    const refused =
      error instanceof DeadmanRelayError && error.status !== undefined;
    if (refused) {
      await deleteDeadmanLocal(plan.tomb);
      throw error;
    }
    const disarmed = await disarmFor(committed, plan.privateKeyJwk)
      .then((disarm) => sendDisarm(target, disarm))
      .then(
        () => true,
        () => false,
      );
    if (disarmed) {
      await deleteDeadmanLocal(plan.tomb);
      throw error;
    }
    throw new Error(
      "The relay did not confirm the arm or the disarm. The local deadman record was kept so you can retry turning it off.",
    );
  }
}

/**
 * Disarm only after the relay accepts the signed disarm. Otherwise a local
 * "off" would leave the relay still counting down and still able to notify.
 */
export function disarmDeadmanSwitch(tomb: string): Promise<void> {
  return withDeadmanTurn(tomb, () => disarmDeadmanSwitchNow(tomb));
}

async function disarmDeadmanSwitchNow(tomb: string): Promise<void> {
  const state = readDeadmanState(tomb);
  if (!state) return;
  if (!(await verifyDeadmanState(state)))
    throw new Error("The deadman record did not verify.");
  const config = await readDeadmanConfig(tomb);
  if (
    !config ||
    config.id !== state.id ||
    !(await deadmanKeyMatchesState(config.privateKeyJwk, state.publicKeyJwk))
  )
    throw new Error("The deadman private record is missing or does not match.");
  await sendDisarm(
    { relayUrl: state.relayUrl, relayToken: config.relayToken },
    await disarmFor(state, config.privateKeyJwk),
  );
  await deleteDeadmanConfig(tomb);
  await deleteDeadmanLocal(tomb);
}

export type DeadmanRelease = Readonly<{
  status: DeadmanStatus;
  package: DeadmanPackage;
}>;

/** The release screen's full check; only a valid, triggered package gets here. */
export async function loadDeadmanRelease(
  tomb: string,
): Promise<DeadmanRelease> {
  const status = await loadDeadmanStatus(tomb);
  if (!status) throw new Error("No deadman switch is set on this device.");
  if (status.damaged)
    throw new Error(
      "The deadman record did not verify. Nothing can be released.",
    );
  if (!status.packageReady)
    throw new Error("The deadman release package is missing or changed.");
  if (!status.triggered)
    throw new Error(
      `The deadman switch has not reached its deadline. ${Math.max(
        1,
        Math.ceil(status.remainingMs / 86_400_000),
      )} days remain.`,
    );
  const packageValue = readDeadmanPackage(tomb);
  if (!packageValue) throw new Error("The deadman release package is missing.");
  return { status, package: packageValue };
}

/** Open only the package the status named, with the release key. */
export async function releaseDeadmanSwitch(
  tomb: string,
  releaseKey: string,
): Promise<VaultItem[]> {
  const release = await loadDeadmanRelease(tomb);
  return openDeadmanPackage(tomb, release.package, releaseKey);
}
