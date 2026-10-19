/**
 * Rows under Identity › Devices (ADR 0186).
 *
 * Pair CLI is an optional add-on on the workspace list. It is not a device,
 * so it is absent from `deviceWorkspaceRows` (the rail and the count) and
 * present on `deviceWorkspaceListRows` with `counted: false`.
 */

export type DeviceWorkspaceExtras = {
  tailnet: boolean;
  approval: boolean;
};

export type DeviceWorkspaceRow = {
  id: string;
  label: string;
  href: string;
  /** False for an add-on that is listed and left out of the Devices count. */
  counted?: boolean;
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
  return rows;
}

/** Optional workspace add-ons. Not devices, and not Identity rail rows. */
export function deviceAddonRows(): DeviceWorkspaceRow[] {
  return [
    {
      id: "pair-cli",
      label: "Pair CLI",
      href: PAIR_CLI_PATH,
      counted: false,
    },
  ];
}

/** The Devices workspace list: counted device rows, then uncounted add-ons. */
export function deviceWorkspaceListRows(
  devices: readonly { id: string; name: string }[],
  extras: DeviceWorkspaceExtras,
): DeviceWorkspaceRow[] {
  return [...deviceWorkspaceRows(devices, extras), ...deviceAddonRows()];
}
