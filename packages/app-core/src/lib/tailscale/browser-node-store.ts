/** SDK private keys remain actual Token CredentialItems under the vault key. */
import { canonicalize } from "@opensesame/os-domain";
import { z } from "zod";
import {
  readDeviceRows,
  removeDeviceConfigurationDurable,
} from "../device-connector-records.js";
import { saveDeviceConnectorConfigurationDurable } from "../device-connectors.js";
import {
  assertVaultCredentials,
  discardVaultCredentials,
  initializeVaultCredentialCustody,
  readVaultCredentials,
  stageVaultCredentials,
} from "../vault-credential-custody.js";
import { vaultStore } from "../vault/store.js";
import type { TailscaleNodeConfiguration } from "./browser-node-port.js";
const FIELD = "tailscale_browser_node";
const Metadata = z
  .object({
    hostname: z.string(),
    controlURL: z.string().url(),
    reference: z.string(),
    tomb: z.string(),
  })
  .strict();
const State = z.record(z.string(), z.string().max(1_000_000));
export type TailscaleNodeState = z.infer<typeof State>;
export type TailscaleNodeRecord = z.infer<typeof Metadata>;
function binding(
  config: Pick<TailscaleNodeConfiguration, "hostname" | "controlURL">,
): string {
  return canonicalize({
    providerId: "tailscale-browser-node",
    hostname: config.hostname,
    controlURL: config.controlURL,
  });
}
function savedNodeRow(tomb: string) {
  return readDeviceRows().find(
    (entry) =>
      entry.providerId === "tailscale" &&
      entry.fields[FIELD] &&
      Metadata.parse(JSON.parse(entry.fields[FIELD])).tomb === tomb,
  );
}
export async function openBrowserNodeState(
  config: TailscaleNodeConfiguration,
  tomb: string,
  check: () => void,
) {
  await initializeVaultCredentialCustody();
  check();
  const row = savedNodeRow(tomb);
  if (row) {
    const record = Metadata.parse(JSON.parse(row.fields[FIELD] ?? ""));
    if (record.tomb !== tomb || binding(record) !== binding(config))
      throw new Error(
        "This vault has a different saved browser node. Use its hostname and control server.",
      );
    const capture = captureState(record);
    const state = decodeState(capture.fields.get("nodeState"));
    assertVaultCredentials(capture, tomb, check);
    return {
      record,
      state,
      connectionId: row.connectionId,
      credentialReceipt: JSON.stringify(capture.items),
      publicReceipt: browserNodePublicFingerprint(record, row.connectionId),
    };
  }
  const capture = await stageVaultCredentials(
    {
      name: config.hostname,
      targetBinding: binding(config),
      fields: [
        {
          field: "nodeState",
          label: "Tailscale browser node private state",
          value: "{}",
        },
      ],
    },
    tomb,
    check,
  );
  const record = {
    hostname: config.hostname,
    controlURL: config.controlURL,
    reference: capture.reference,
    tomb,
  };
  let published = false;
  try {
    const connection = await saveDeviceConnectorConfigurationDurable(
      () => ({
        providerId: "tailscale",
        displayName: config.hostname,
        scopes: [],
        fields: {
          [FIELD]: JSON.stringify(record),
          self_hosted_configuration: "tailscale-browser-v1",
        },
        secrets: {},
      }),
      undefined,
      () => assertVaultCredentials(capture, tomb, check),
    );
    published = true;
    check();
    assertVaultCredentials(capture, tomb, check);
    return {
      record,
      state: {},
      connectionId: connection.connectionId,
      credentialReceipt: JSON.stringify(capture.items),
      publicReceipt: browserNodePublicFingerprint(
        record,
        connection.connectionId,
      ),
    };
  } catch (error) {
    if (!published)
      await discardVaultCredentials(capture, tomb, check).catch(
        () => undefined,
      );
    throw error;
  }
}
export function savedBrowserNodeConfiguration(): {
  hostname: string;
  controlURL: string;
} | null {
  try {
    const row = savedNodeRow(vaultStore.getSnapshot().tomb);
    if (!row) return null;
    const record = Metadata.parse(JSON.parse(row.fields[FIELD] ?? ""));
    return { hostname: record.hostname, controlURL: record.controlURL };
  } catch {
    return null;
  }
}
/** The exact public row is independent of a legitimate pending private-state write. */
export function browserNodePublicFingerprint(
  record: TailscaleNodeRecord,
  connectionId: string,
): string {
  const row = readDeviceRows().find(
    (entry) => entry.connectionId === connectionId,
  );
  if (
    !row ||
    row.providerId !== "tailscale" ||
    row.fields[FIELD] !== JSON.stringify(record)
  )
    throw new Error("The saved Tailscale browser node changed.");
  return JSON.stringify(row);
}
function captureState(record: TailscaleNodeRecord) {
  const row = savedNodeRow(record.tomb);
  if (
    !row ||
    canonicalize(Metadata.parse(JSON.parse(row.fields[FIELD] ?? ""))) !==
      canonicalize(record)
  )
    throw new Error("The saved Tailscale browser node changed.");
  return readVaultCredentials(
    record.reference,
    binding(record),
    ["nodeState"],
    record.tomb,
  );
}
export function browserNodeCredentialFingerprint(
  record: TailscaleNodeRecord,
): string {
  return JSON.stringify(captureState(record).items);
}
export function readBrowserNodeState(
  record: TailscaleNodeRecord,
): Record<string, string> {
  return decodeState(captureState(record).fields.get("nodeState"));
}
function decodeState(raw: string | undefined): TailscaleNodeState {
  if (!raw || raw.length > 4_000_000)
    throw new Error("Tailscale node state is missing or oversized.");
  return State.parse(JSON.parse(raw));
}
export async function writeBrowserNodeState(
  record: TailscaleNodeRecord,
  expected: Record<string, string>,
  next: Record<string, string>,
  check: () => void,
): Promise<string> {
  const capture = captureState(record);
  if (canonicalize(readBrowserNodeState(record)) !== canonicalize(expected))
    throw new Error(
      "Tailscale private state changed. Reconnect the browser node.",
    );
  const serialized = JSON.stringify(State.parse(next));
  if (serialized.length > 4_000_000)
    throw new Error("Tailscale node state exceeds its limit.");
  const items = capture.items.map((item) => {
    if (item.method.type !== "token")
      throw new Error("Tailscale node credential changed.");
    return { ...item, method: { ...item.method, token: serialized } };
  });
  assertVaultCredentials(capture, record.tomb, check);
  // VaultStore captures exact prior item bytes and checks them inside its queued
  // cross-tab body mutation. Its external guard also runs after normalization.
  await vaultStore.saveItems(items, undefined, () => {
    check();
    const row = savedNodeRow(record.tomb);
    if (
      !row ||
      canonicalize(Metadata.parse(JSON.parse(row.fields[FIELD] ?? ""))) !==
        canonicalize(record)
    )
      throw new Error("Browser node configuration changed during persistence.");
  });
  const committed = captureState(record);
  if (committed.fields.get("nodeState") !== serialized)
    throw new Error("The saved browser node private state differs.");
  const receipt = JSON.stringify(committed.items);
  assertVaultCredentials(committed, record.tomb, check);
  if (browserNodeCredentialFingerprint(record) !== receipt)
    throw new Error("Tailscale private state changed after persistence.");
  return receipt;
}

export async function forgetBrowserNodeState(
  tomb: string,
  check: () => void,
): Promise<void> {
  await initializeVaultCredentialCustody();
  const assertCurrentScope = () =>
    assertVaultCredentials({ items: [] }, tomb, check);
  assertCurrentScope();
  const row = savedNodeRow(tomb);
  if (!row) return;
  const record = Metadata.parse(JSON.parse(row.fields[FIELD] ?? ""));
  if (record.tomb !== tomb)
    throw new Error("Open the vault that owns this browser node.");
  let capture: ReturnType<typeof captureState> | null = null;
  try {
    capture = captureState(record);
  } catch {
    assertCurrentScope();
  }
  await removeDeviceConfigurationDurable(
    row.connectionId,
    () => {
      assertCurrentScope();
      const current = readDeviceRows().find(
        (entry) => entry.connectionId === row.connectionId,
      );
      if (!current || current.fields[FIELD] !== row.fields[FIELD])
        throw new Error("Browser node configuration changed.");
    },
    assertCurrentScope,
  );
  if (capture)
    await discardVaultCredentials(capture, tomb, assertCurrentScope).catch(
      assertCurrentScope,
    );
}
