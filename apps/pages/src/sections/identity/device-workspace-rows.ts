/** Rows under Identity › Devices besides vault device records (ADR 0186 Pair CLI). */

export type DeviceWorkspaceExtras = {
  tailnet: boolean;
  approval: boolean;
};

export type DeviceWorkspaceRow = {
  id: string;
  label: string;
  href: string;
};

export const DEVICES_LIST_PATH = "/identity?view=devices";

export const PAIR_CLI_PATH = "/identity/authorize?cli=1";

/** The Devices workspace list and the Identity rail subtree share this shape. */
export function deviceWorkspaceRows(
  devices: readonly { id: string; name: string }[],
  extras: DeviceWorkspaceExtras,
): DeviceWorkspaceRow[] {
  const rows: DeviceWorkspaceRow[] = devices.map((device) => ({
    id: device.id,
    label: device.name,
    href: `${DEVICES_LIST_PATH}#${encodeURIComponent(device.id)}`,
  }));
  if (extras.tailnet) {
    rows.push({
      id: "tailnet-devices",
      label: "Tailnet devices",
      href: `${DEVICES_LIST_PATH}#tailnet-devices`,
    });
  }
  if (extras.approval) {
    rows.push({
      id: "approve-device",
      label: "Approve a device",
      href: `${DEVICES_LIST_PATH}#approve-device`,
    });
  }
  rows.push({
    id: "cli-terminal",
    label: "Terminal CLI",
    href: PAIR_CLI_PATH,
  });
  return rows;
}
