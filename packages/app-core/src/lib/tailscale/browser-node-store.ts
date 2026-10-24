/** SDK private keys remain actual Token CredentialItems under the vault key. */
import { canonicalize } from "@opensesame/os-domain";
import { z } from "zod";
import {
  readDeviceRows,
  removeDeviceConfigurationDurable,
  updateDeviceConfigurationDurable,
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
import { TailscaleHTTPRouteConfiguration } from "./browser-node-peer-http.js";
import {
  type TailscaleNodeConfiguration,
  TailscaleServerTrustConfiguration,
  normalizeTailscaleNodeIdentity,
} from "./browser-node-port.js";
import { browserNodeTransportOptions } from "./browser-node-transport-options.js";
const FIELD = "tailscale_browser_node";
const Metadata = z
  .object({
    hostname: z.string(),
    controlURL: z.string().url(),
    reference: z.string(),
    tomb: z.string(),
    nativeHTTP: TailscaleHTTPRouteConfiguration.optional(),
    peerTLS: TailscaleServerTrustConfiguration.optional(),
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
  const { nativeHTTP, peerTLS } = browserNodeTransportOptions(config);
  const identity = { hostname: config.hostname, controlURL: config.controlURL };
  await initializeVaultCredentialCustody();
  check();
  const row = savedNodeRow(tomb);
  if (row) {
    const record = Metadata.parse(JSON.parse(row.fields[FIELD] ?? ""));
    if (record.tomb !== tomb || binding(record) !== binding(identity))
      throw new Error(
        "This vault has a different saved browser node. Use its hostname and control server.",
      );
    if (
      nativeHTTP !== undefined &&
      canonicalize(record.nativeHTTP ?? null) !== canonicalize(nativeHTTP)
    )
      throw new Error(
        "Update the saved native HTTPS configuration before reconnecting.",
      );
    if (
      peerTLS !== undefined &&
      canonicalize(record.peerTLS ?? null) !== canonicalize(peerTLS)
    )
      throw new Error("Update the saved peer TLS trust before reconnecting.");
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
      name: identity.hostname,
      targetBinding: binding(identity),
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
  const record: TailscaleNodeRecord = {
    ...identity,
    reference: capture.reference,
    tomb,
  };
  if (nativeHTTP !== undefined) record.nativeHTTP = nativeHTTP;
  if (peerTLS !== undefined) record.peerTLS = peerTLS;
  let published = false;
  try {
    const connection = await saveDeviceConnectorConfigurationDurable(
      () => ({
        providerId: "tailscale",
        displayName: identity.hostname,
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
/** Persist an explicit public route choice while retaining the original node's private state. */
export async function configureBrowserNodeState(
  config: TailscaleNodeConfiguration,
  tomb: string,
  check: () => void,
): Promise<TailscaleNodeRecord> {
  const identity = normalizeTailscaleNodeIdentity(config);
  const { nativeHTTP, peerTLS } = browserNodeTransportOptions(config);
  check();
  const stored = await openBrowserNodeState(identity, tomb, check);
  check();
  return updateBrowserNodeOptions(
    stored.record,
    { nativeHTTP, peerTLS },
    check,
  );
}
export function savedBrowserNodeConfiguration(): Omit<
  TailscaleNodeConfiguration,
  "authKey"
> | null {
  try {
    const row = savedNodeRow(vaultStore.getSnapshot().tomb);
    if (!row) return null;
    const record = Metadata.parse(JSON.parse(row.fields[FIELD] ?? ""));
    const identity = {
      hostname: record.hostname,
      controlURL: record.controlURL,
    };
    return {
      ...identity,
      ...browserNodeTransportOptions(record),
    };
  } catch {
    return null;
  }
}
/** Change public routing/trust without replacing the original private node keys. */
export async function updateBrowserNodeNativeHTTP(
  original: TailscaleNodeRecord,
  next: TailscaleHTTPRouteConfiguration | undefined,
  check: () => void,
): Promise<TailscaleNodeRecord> {
  return updateBrowserNodeOptions(
    original,
    { nativeHTTP: next, peerTLS: original.peerTLS },
    check,
  );
}
async function updateBrowserNodeOptions(
  original: TailscaleNodeRecord,
  next: Pick<TailscaleNodeConfiguration, "nativeHTTP" | "peerTLS">,
  check: () => void,
): Promise<TailscaleNodeRecord> {
  const record = Metadata.parse(original);
  const options = browserNodeTransportOptions(next);
  const row = savedNodeRow(record.tomb);
  if (!row) throw new Error("The saved Tailscale browser node changed.");
  const receipt = browserNodePublicFingerprint(record, row.connectionId);
  const capture = captureState(record);
  const assertCurrent = () => {
    assertVaultCredentials(capture, record.tomb, check);
    if (browserNodePublicFingerprint(record, row.connectionId) !== receipt)
      throw new Error("The saved Tailscale browser node changed.");
  };
  assertCurrent();
  const identity = {
    hostname: record.hostname,
    controlURL: record.controlURL,
    reference: record.reference,
    tomb: record.tomb,
  };
  const replacement = Metadata.parse({
    ...identity,
    ...options,
  });
  await updateDeviceConfigurationDurable(
    row.connectionId,
    async (current) => {
      assertCurrent();
      if (JSON.stringify(current.row) !== receipt)
        throw new Error("The saved Tailscale browser node changed.");
      if (canonicalize(record) === canonicalize(replacement)) return current;
      return {
        ...current,
        row: {
          ...current.row,
          updatedAt: new Date().toISOString(),
          fields: {
            ...current.row.fields,
            [FIELD]: JSON.stringify(replacement),
          },
        },
      };
    },
    assertCurrent,
  );
  assertVaultCredentials(capture, record.tomb, check);
  browserNodePublicFingerprint(replacement, row.connectionId);
  return replacement;
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
  const unchanged = () => {
    assertCurrentScope();
    const current = readDeviceRows().find(
      (entry) => entry.connectionId === row.connectionId,
    );
    if (!current || current.fields[FIELD] !== row.fields[FIELD])
      throw new Error("Browser node configuration changed.");
  };
  // The private state goes before the row that names it: a node shown as
  // forgotten has no credential left behind. A credential the person edited
  // meanwhile is theirs and stays (the discard compares before it withdraws).
  if (capture) {
    unchanged();
    await discardVaultCredentials(capture, tomb, assertCurrentScope).catch(
      assertCurrentScope,
    );
  }
  await removeDeviceConfigurationDurable(
    row.connectionId,
    unchanged,
    assertCurrentScope,
  );
}
